#!/usr/bin/env node
// Measures how well Jev judges Stats Explorer's checkpoints, on labeled cases (scripts/jev-eval/cases.mjs).
//
//   TYPESAFE_API_KEY=... node scripts/jev-eval.mjs            calls Jev for every case
//   node scripts/jev-eval.mjs --dry-run                        no key needed: Stats Explorer's own checks only
//   options: --repeat 3 (ask each case several times, to see how stable the answers are)
//            --out jev-eval-report.md (also writes .json next to it)
//
// The key is read from the environment and never printed or written. Only the packets the MCP server
// would send are sent (question, plan, column names, computed summary results; no raw rows).
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { buildCases } from './jev-eval/cases.mjs';
import { systemOne } from '../src/jev/client.js';
import { readJevConfig } from '../src/jev/config.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, d) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const dry = flag('--dry-run');
const repeat = Math.max(1, Number(opt('--repeat', 1)) || 1);
const out = opt('--out', 'jev-eval-report.md');
const cfg = readJevConfig({ ...process.env, STATS_EXPLORER_JEV: 'enforce' });
if (!dry && !cfg.api.key) {
  console.error('Set TYPESAFE_API_KEY (your own key) or run with --dry-run.');
  process.exit(1);
}
const outcomeOf = (p) => (p >= cfg.passAt ? 'pass' : p < cfg.failBelow ? 'fail' : 'review');
const RANK = { pass: 0, review: 1, fail: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);

const cases = await buildCases();
const items = []; // one per question
const latencies = [];
let errors = 0;

async function runCase(c) {
  const questions = Object.fromEntries(Object.entries(c.built.questions).map(([id, q]) => [id, { type: 'noul', instructions: q.instructions }]));
  const runs = [];
  if (!dry) {
    for (let k = 0; k < repeat; k++) {
      const t0 = performance.now();
      try {
        const r = await systemOne(cfg.api, { state: c.built.state, questions });
        latencies.push(performance.now() - t0);
        runs.push(r.probabilities);
      } catch (e) {
        errors++;
        console.error(`  ${c.id}: ${e.message}`);
      }
    }
  }
  for (const [qid, good] of Object.entries(c.expect)) {
    const ps = runs.map((r) => r[qid]).filter((p) => typeof p === 'number');
    const p = ps.length ? ps.reduce((s, x) => s + x, 0) / ps.length : null;
    const own = c.built.deterministic?.[qid]?.outcome || 'pass';
    const jev = p == null ? null : outcomeOf(p);
    items.push({
      case: c.id, checkpoint: c.checkpoint, question: qid, label: c.built.questions[qid].label, claim: c.claim,
      expected_ok: good, probability: p, spread: ps.length > 1 ? Math.max(...ps) - Math.min(...ps) : 0,
      jev, own, combined: jev == null ? own : worst(jev, own),
    });
  }
}

// Small concurrency so the API isn't flooded.
const queue = [...cases];
await Promise.all(Array.from({ length: dry ? 1 : 3 }, async () => { while (queue.length) await runCase(queue.shift()); }));

// ------------------------------------------------------------------ metrics
function metrics(list, key) {
  const scored = list.filter((x) => x[key] != null);
  const good = scored.filter((x) => x.expected_ok), bad = scored.filter((x) => !x.expected_ok);
  const passed = (x) => x[key] === 'pass';
  const correct = scored.filter((x) => passed(x) === x.expected_ok).length;
  return {
    n: scored.length, good: good.length, bad: bad.length,
    accuracy: scored.length ? correct / scored.length : null,
    false_approval: bad.length ? bad.filter(passed).length / bad.length : null, // a bad item passed (the dangerous error)
    false_alarm: good.length ? good.filter((x) => !passed(x)).length / good.length : null, // a fine item flagged
    review_share: scored.length ? scored.filter((x) => x[key] === 'review').length / scored.length : null,
  };
}
function auc(list) {
  const s = list.filter((x) => x.probability != null);
  const pos = s.filter((x) => x.expected_ok), neg = s.filter((x) => !x.expected_ok);
  if (!pos.length || !neg.length) return null;
  let w = 0;
  for (const a of pos) for (const b of neg) w += a.probability > b.probability ? 1 : a.probability === b.probability ? 0.5 : 0;
  return w / (pos.length * neg.length);
}
const brier = (list) => { const s = list.filter((x) => x.probability != null); return s.length ? s.reduce((t, x) => t + (x.probability - (x.expected_ok ? 1 : 0)) ** 2, 0) / s.length : null; };
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);
const f3 = (x) => (x == null ? '—' : x.toFixed(3));
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const groups = [['All', items], ['Plan (step 1)', items.filter((x) => x.checkpoint === 'plan')], ['Conclusions', items.filter((x) => x.checkpoint === 'conclusions')]];
for (const qid of ['test_fits', 'hypotheses_match', 'columns_relevant']) groups.push([`Plan: ${qid}`, items.filter((x) => x.question === qid)]);

const rows = groups.map(([name, list]) => {
  const j = metrics(list, 'jev'), o = metrics(list, 'own'), c = metrics(list, 'combined');
  return { name, n: list.length, jev: j, own: o, combined: c, auc: auc(list), brier: brier(list) };
});

// A plain-language verdict with the thresholds the guide recommends.
const all = rows[0];
let verdict;
if (dry) verdict = 'Dry run: Jev was not called. The table shows what Stats Explorer\'s own checks catch on their own.';
else if (all.jev.n === 0) verdict = 'No Jev answers were received; check the key and the network.';
else if (all.combined.false_approval <= 0.05 && all.auc >= 0.9 && all.jev.false_alarm <= 0.25) verdict = 'GOOD: with Stats Explorer\'s own checks, few bad items get through and Jev ranks good above bad reliably. Fine to use as the second check (enforce or cooperate mode).';
else if (all.combined.false_approval <= 0.15 && all.auc >= 0.75) verdict = 'USABLE AS ADVISORY: Jev helps, but too many bad items still pass to rely on it alone. Keep the checks on, treat "pass" as "no problems found", and keep a human look at the conclusions; consider raising STATS_EXPLORER_JEV_PASS_AT.';
else verdict = 'NOT RELIABLE YET on these cases: do not market Jev as verifying the analysis. Keep Stats Explorer\'s own checks as the safeguard, and describe Jev as an experimental second opinion.';

const lines = [];
lines.push('# Jev evaluation for Stats Explorer', '');
lines.push(`${new Date().toISOString().slice(0, 10)} · model ${dry ? '— (dry run)' : cfg.api.model} · thresholds pass ≥ ${cfg.passAt}, fail < ${cfg.failBelow} · ${cases.length} cases, ${items.length} judgements${repeat > 1 ? `, each asked ${repeat} times` : ''}${errors ? ` · ${errors} API error(s)` : ''}`, '');
lines.push(`**Verdict:** ${verdict}`, '');
lines.push('"Pass" counts as approving the item; review and fail count as flagging it. False approval = a bad plan or claim that passed (the dangerous error). False alarm = a fine one that was flagged.', '');
lines.push('| Set | n | Jev accuracy | Jev false approval | Jev false alarm | Jev review | AUC | Brier | Own checks false approval | Combined false approval | Combined false alarm |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) lines.push(`| ${r.name} | ${r.n} | ${pct(r.jev.accuracy)} | ${pct(r.jev.false_approval)} | ${pct(r.jev.false_alarm)} | ${pct(r.jev.review_share)} | ${f3(r.auc)} | ${f3(r.brier)} | ${pct(r.own.false_approval)} | ${pct(r.combined.false_approval)} | ${pct(r.combined.false_alarm)} |`);
if (latencies.length) lines.push('', `Latency per call: median ${Math.round(q(latencies, 0.5))} ms, 95th percentile ${Math.round(q(latencies, 0.95))} ms.`);
if (repeat > 1) lines.push(`Stability: largest spread of the probability across repeats ${f3(Math.max(...items.map((x) => x.spread)))}.`);
const misses = items.filter((x) => (x.combined === 'pass') !== x.expected_ok);
lines.push('', `## Items the combined check got wrong (${misses.length})`, '');
for (const m of misses) lines.push(`- \`${m.case}\` ${m.question}: expected ${m.expected_ok ? 'OK' : 'NOT OK'}, Jev ${m.probability == null ? '—' : m.probability.toFixed(2)} (${m.jev ?? '—'}), own checks ${m.own}${m.claim ? ` — "${m.claim}"` : ''}`);
const report = lines.join('\n');
console.log(report);
await writeFile(out, report + '\n');
await writeFile(out.replace(/\.md$/, '') + '.json', JSON.stringify({ model: dry ? null : cfg.api.model, thresholds: { pass_at: cfg.passAt, fail_below: cfg.failBelow }, rows, items }, null, 2));
console.error(`\nWrote ${out} and ${out.replace(/\.md$/, '')}.json`);
