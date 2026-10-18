// Settings for working with Jev (TypeSafe's "System One" judgment model). Off unless
// STATS_EXPLORER_JEV is set.
//
//   STATS_EXPLORER_JEV            off (default) | cooperate | enforce | orchestrated
//       cooperate     no orchestrator: Claude / Copilot call a Jev MCP server themselves at each
//                     checkpoint, using packets Stats Explorer prepares, and report the answer back
//       enforce       Stats Explorer calls the Jev API itself at each checkpoint (needs TYPESAFE_API_KEY)
//       orchestrated  a production orchestrator runs Jev (or any policy) and signs its decision with
//                     STATS_EXPLORER_APPROVAL_SECRET; unsigned decisions are refused
//   STATS_EXPLORER_JEV_CHECKPOINTS  comma list of plan, conclusions, data (default: plan,conclusions).
//                     data sends column names and sample text values to Jev, so it is opt-in.
//   STATS_EXPLORER_JEV_REQUIRE      cooperate mode: on (default) = a checkpoint waits for Jev's answer;
//                     off = the packet is only suggested
//   STATS_EXPLORER_JEV_PASS_AT      probability at or above which a check passes (default 0.8)
//   STATS_EXPLORER_JEV_FAIL_BELOW   probability below which a check fails (default 0.5); in between = review
//   STATS_EXPLORER_JEV_ON_ERROR     enforce mode, when the Jev API can't be reached: block (default) | warn
//   STATS_EXPLORER_JEV_ALLOW_OVERRIDE  on (default) | off: whether the user may accept a flagged check
//   STATS_EXPLORER_AUDIT_LOG        path of a JSON Lines file that records every checkpoint decision
//   TYPESAFE_API_KEY, TYPESAFE_BASE_URL (https://api.typesafe.ai), TYPESAFE_MODEL (jev-latest),
//   TYPESAFE_TIMEOUT_SECONDS (10)   enforce mode only
//   STATS_EXPLORER_APPROVAL_SECRET  orchestrated mode only (at least 32 characters)

export const JEV_MODES = ['off', 'cooperate', 'enforce', 'orchestrated'];
export const CHECKPOINTS = ['plan', 'conclusions', 'data'];

const isOff = (v) => /^(0|off|false|no|disabled?)$/i.test(String(v ?? '').trim());
const num = (v, d) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : d; };

export function readJevConfig(env = process.env) {
  let mode = String(env.STATS_EXPLORER_JEV || 'off').trim().toLowerCase();
  if (isOff(mode)) mode = 'off';
  if (mode === 'on' || mode === 'true') mode = 'cooperate';
  const problems = [];
  if (!JEV_MODES.includes(mode)) { problems.push(`STATS_EXPLORER_JEV="${env.STATS_EXPLORER_JEV}" is not one of ${JEV_MODES.join(', ')}; Jev checks are off.`); mode = 'off'; }
  const listed = String(env.STATS_EXPLORER_JEV_CHECKPOINTS || 'plan,conclusions').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const checkpoints = listed.includes('all') ? [...CHECKPOINTS] : listed.filter((c) => CHECKPOINTS.includes(c));
  for (const c of listed) if (c !== 'all' && !CHECKPOINTS.includes(c)) problems.push(`Unknown checkpoint "${c}" in STATS_EXPLORER_JEV_CHECKPOINTS (use ${CHECKPOINTS.join(', ')}).`);
  let passAt = num(env.STATS_EXPLORER_JEV_PASS_AT, 0.8);
  let failBelow = num(env.STATS_EXPLORER_JEV_FAIL_BELOW, 0.5);
  if (!(passAt > 0 && passAt <= 1)) passAt = 0.8;
  if (!(failBelow >= 0 && failBelow <= passAt)) failBelow = Math.min(0.5, passAt);
  const secret = env.STATS_EXPLORER_APPROVAL_SECRET || '';
  if (mode === 'orchestrated' && secret.length < 32) problems.push('Orchestrated mode needs STATS_EXPLORER_APPROVAL_SECRET (at least 32 characters); every checkpoint is blocked until it is set.');
  const apiKey = env.TYPESAFE_API_KEY || '';
  if (mode === 'enforce' && !apiKey) problems.push('Enforce mode needs TYPESAFE_API_KEY; every checkpoint is blocked until it is set.');
  return {
    mode,
    enabled: mode !== 'off',
    checkpoints: mode === 'off' ? [] : checkpoints,
    require: mode !== 'cooperate' || !isOff(env.STATS_EXPLORER_JEV_REQUIRE),
    passAt, failBelow,
    onError: /^warn$/i.test(env.STATS_EXPLORER_JEV_ON_ERROR || '') ? 'warn' : 'block',
    allowOverride: mode !== 'orchestrated' && !isOff(env.STATS_EXPLORER_JEV_ALLOW_OVERRIDE),
    auditLog: env.STATS_EXPLORER_AUDIT_LOG || '',
    api: {
      key: apiKey,
      baseUrl: (env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, ''),
      model: env.TYPESAFE_MODEL || 'jev-latest',
      timeoutMs: Math.max(1, num(env.TYPESAFE_TIMEOUT_SECONDS, 10)) * 1000,
      retries: Math.max(0, Math.min(5, num(env.TYPESAFE_MAX_RETRIES, 2))),
    },
    secret,
    problems,
  };
}
