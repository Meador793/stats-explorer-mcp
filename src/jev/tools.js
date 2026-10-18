// Tools and instructions added when Jev checks are on (STATS_EXPLORER_JEV is not off).
import { z } from 'zod';
import { UserError } from '../errors.js';
import { conclusionsPacket } from './checks.js';
import { packetForAgent, SOURCE_LABEL, CHECKPOINT_LABEL } from './gate.js';

const fmtPct = (p) => (p == null ? '' : ` (${(p * 100).toFixed(0)}% OK)`);

export function verdictLines(v) {
  return [
    `${CHECKPOINT_LABEL[v.checkpoint]}: ${v.overall.toUpperCase()} (${SOURCE_LABEL[v.source] || v.source}${v.model ? `, ${v.model}` : ''}${v.tool ? `, ${v.tool}` : ''}).${v.note ? ` Note: ${v.note}` : ''}`,
    ...v.items.map((i) => `- ${i.outcome === 'pass' ? '✓' : i.outcome === 'review' ? '?' : '✗'} ${i.claim ? `"${i.claim}"` : i.label}${fmtPct(i.probability_ok)}${i.issues.length ? `: ${i.issues.join(' ')}` : ''}`),
  ];
}

function resultsFor(session, ids) {
  if (ids?.length) {
    const found = session.results.filter((r) => ids.includes(r.id));
    const unknown = ids.filter((id) => !found.some((r) => r.id === id));
    if (unknown.length) throw new UserError(`Unknown result id(s): ${unknown.join(', ')}. Available: ${session.results.map((r) => `${r.id} ${r.title}`).join('; ') || 'none yet'}.`);
    return found;
  }
  const own = session.current ? session.results.filter((r) => r.analysisId === session.current.id) : [];
  return own.length ? own : session.results;
}

async function checkConclusions(a, ctx) {
  const { session, jev } = ctx;
  const claims = a.claims.map((c) => String(c).trim()).filter(Boolean);
  if (!claims.length) throw new UserError('Pass claims: the sentences of your answer that state a finding, one per entry.');
  const results = resultsFor(session, a.result_ids);
  if (!results.length) throw new UserError('There are no computed results to check claims against yet. Run the analysis first.');
  const question = a.question || session.current?.question || '';
  const built = conclusionsPacket({ question, claims, results });
  const packet = jev.makePacket('conclusions', results.map((r) => r.id).join(','), built, { analysisId: session.current?.id || null });
  let verdict = jev.verdicts.get(packet.id);
  if (!verdict) {
    if (!jev.uses('conclusions')) verdict = jev.decide(packet, { source: 'stats-explorer' });
    else if (jev.config.mode === 'enforce') {
      verdict = await jev.callApi(packet);
      if (verdict.error) {
        return { data: { status: 'blocked_by_jev', packet_id: packet.id, reason: verdict.error, own_checks: built.deterministic }, summary: [`The Jev check could not run: ${verdict.error}`, 'Do not present the claims as checked.'] };
      }
    } else {
      const own = Object.entries(built.deterministic);
      const status = jev.config.mode === 'orchestrated' ? 'needs_approval' : 'needs_verification';
      return {
        data: { status, checkpoint: 'conclusions', jev_packet: packetForAgent(packet) },
        summary: [
          status === 'needs_approval'
            ? `APPROVAL NEEDED (written conclusions): the orchestrator checks packet ${packet.id} and records a signed decision.`
            : `JEV CHECK NEEDED (written conclusions). Call the Jev verification tool from the user's Jev MCP server (jev_verify / verify with claims + evidence = context, or jev_noul / check with propositions + context), then call record_verification with packet_id "${packet.id}" and one result per claim id (${Object.keys(packet.questions).join(', ')}).`,
          ...(own.length ? ['Stats Explorer already flagged:', ...own.flatMap(([id, d]) => d.issues.map((i) => `- ${id} "${built.questions[id].claim}": ${i}`))] : ['Stats Explorer\'s own checks found no problems (numbers match, significance stated correctly, no causal wording).']),
        ],
      };
    }
  }
  return conclusionResponse(verdict);
}

function conclusionResponse(v) {
  const ok = v.items.filter((i) => i.outcome === 'pass');
  return {
    data: { status: 'checked', packet_id: v.packet_id, overall: v.overall, source: v.source, claims: v.items.map((i) => ({ id: i.id, claim: i.claim, outcome: i.outcome, probability_ok: i.probability_ok, issues: i.issues })) },
    summary: [
      ...verdictLines(v),
      v.overall === 'pass'
        ? 'All claims passed. You can present them; to put them in a report, pass conclusions_check with this packet_id to build_report.'
        : `${ok.length} of ${v.items.length} claims passed. Fix or drop the flagged ones (use the exact numbers from the results, match significance to the p-value, avoid causal wording) and check again; only passed claims go into a report.`,
    ],
  };
}

async function recordVerification(a, ctx) {
  const { jev } = ctx;
  const v = jev.record(a);
  if (v.checkpoint === 'conclusions') return conclusionResponse(v);
  return {
    data: { status: 'recorded', packet_id: v.packet_id, checkpoint: v.checkpoint, overall: v.overall, source: v.source, items: v.items },
    summary: [
      ...verdictLines(v),
      v.overall === 'pass'
        ? 'Recorded. Now call the tool that asked for this check again, with the same arguments.'
        : 'Recorded. Show the user the flagged items. Revise if they agree; if they want to go ahead anyway, record their reason with override_reason.',
    ],
  };
}

export function jevTools() {
  return [
    {
      name: 'check_conclusions', title: 'Check written conclusions against the results',
      description: 'Before you present findings (or put them in a report), pass the sentences of your answer that state a result. Each claim is checked against the computed results: Stats Explorer checks that every number appears in the results, that "significant" / "not significant" matches the p-value and α, and flags causal or "proves" wording; Jev then judges whether the claim is supported (depending on the server\'s mode, Stats Explorer calls Jev itself, asks you to call the user\'s Jev MCP server, or waits for the orchestrator). Present only claims that pass.',
      inputSchema: {
        claims: z.array(z.string().min(3)).min(1).max(20).describe('Your findings, one sentence per entry, exactly as you will present them.'),
        result_ids: z.array(z.string()).optional().describe('Results the claims are about (default: the current analysis).'),
        question: z.string().optional().describe("The user's question, if no analysis was started."),
      },
      annotations: { title: 'Check conclusions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      run: checkConclusions,
    },
    {
      name: 'record_verification', title: "Record Jev's answer for a checkpoint",
      description: "Records the answer to a JEV CHECK NEEDED or APPROVAL NEEDED response. Cooperate mode: pass the packet_id and results (one per question id, with the probability Jev gave that the statement is TRUE, or its verdict label), and the name of the Jev tool you used. Orchestrated mode: only the orchestrator's signed approval is accepted. Any mode except orchestrated: override_reason records that the user chose to go ahead despite a flagged or unavailable check (only after the user says so; it appears in the report).",
      inputSchema: {
        packet_id: z.string(),
        results: z.array(z.object({
          id: z.string().describe('Question or claim id from the packet (e.g. test_fits, c1).'),
          probability: z.number().min(0).max(1).optional().describe('Jev\'s probability that the statement is TRUE.'),
          verdict: z.string().optional().describe('Or Jev\'s label: verified, needs_review, contradicted, likely, uncertain, unlikely, pass, review, block.'),
        })).optional(),
        jev_tool: z.string().optional().describe('Name of the Jev tool you called.'),
        model: z.string().optional().describe('Jev model reported by the tool, if any.'),
        override_reason: z.string().optional().describe("Only when the user explicitly chose to go ahead without (or despite) the check: their reason."),
        approval: z.string().optional().describe('Orchestrated mode: the signed approval token from the orchestrator.'),
      },
      annotations: { title: 'Record verification', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: recordVerification,
    },
  ];
}

export function jevInstructions(config) {
  const cps = config.checkpoints.map((c) => CHECKPOINT_LABEL[c].toLowerCase()).join(', ');
  const common = `

Independent checks with Jev (mode: ${config.mode}; checkpoints: ${cps || 'none'}). Jev is TypeSafe's fast judgment model; it answers yes/no questions with a probability and never computes statistics. Stats Explorer computes; Jev checks the AI's choices and wording.
- Before presenting findings from a computed result, call check_conclusions with your finding sentences and present only claims that pass. Use the exact numbers from the results.`;
  if (config.mode === 'cooperate') {
    return `${common}
- When a tool answers JEV CHECK NEEDED, call the user's Jev MCP tool with the packet it gives (jev_noul / check / evaluate, jev_verify / verify, or jev_screen), then record_verification with Jev's answers, then call the original tool again. Never answer the packet's questions yourself.${config.require ? ' The checkpoint waits until Jev\'s answer is recorded.' : ' Checks are optional on this server: run them when a Jev tool is connected.'}
- If no Jev MCP server is connected, tell the user; go on only if they accept that (record_verification with override_reason).`;
  }
  if (config.mode === 'enforce') {
    return `${common}
- Stats Explorer calls Jev itself at each checkpoint; you do not need a Jev tool for these checks. If a tool answers BLOCKED BY JEV CHECK, show the user the concerns and revise; record an override only if the user explicitly asks to go ahead.`;
  }
  return `${common}
- This server runs inside an orchestrated pipeline: checkpoints answer APPROVAL NEEDED until the orchestrator records a signed decision. Do not try to approve or override checks yourself.`;
}
