#!/usr/bin/env node
// A production-style pipeline: an orchestrator drives Stats Explorer over MCP, checks every
// checkpoint with Jev (TypeSafe's System One API) under its own policy, and signs its decisions.
// Stats Explorer runs in orchestrated mode, so nothing passes a checkpoint without a valid signature.
//
//   node examples/orchestrator/pipeline.mjs job.json            uses Jev (needs TYPESAFE_API_KEY)
//   node examples/orchestrator/pipeline.mjs job.json --dry-run  no Jev: approves only what Stats
//                                                                Explorer's own checks find clean
//
// job.json: { "question": "...", "file": "data.csv", "test": "t_test",
//             "test_arguments": { ... }, "alternative": "two-sided", "alpha": 0.05,
//             "claims": ["optional finding sentences; {p}, {significance} and {verdict} are filled in"],
//             "report": "report.html", "data_folder": "." }
//
// The same pattern works in any orchestrator (LangGraph, Temporal, Airflow, n8n, AWS Step Functions /
// Bedrock AgentCore): when a tool result has status needs_approval, evaluate data.jev_packet, sign the
// decision with STATS_EXPLORER_APPROVAL_SECRET and call record_verification. See docs/JEV.md.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signApproval, systemOne } from '../../src/jev/index.js'; // from npm: 'stats-explorer-mcp/jev'

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const jobPath = args.find((x) => !x.startsWith('--'));
if (!jobPath) { console.error('Usage: node pipeline.mjs job.json [--dry-run]'); process.exit(2); }
const job = JSON.parse(readFileSync(jobPath, 'utf8'));
const folder = resolve(dirname(jobPath), job.data_folder || '.');

// The secret is shared only between the orchestrator and the Stats Explorer process it starts.
const secret = process.env.STATS_EXPLORER_APPROVAL_SECRET || randomBytes(32).toString('hex');
const POLICY = { passAt: Number(process.env.POLICY_PASS_AT || 0.85), name: dry ? 'dry-run policy (own checks only)' : 'jev policy v1' };
const api = { key: process.env.TYPESAFE_API_KEY || '', baseUrl: process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai', model: process.env.TYPESAFE_MODEL || 'jev-latest', timeoutMs: 10000, retries: 2 };
if (!dry && !api.key) { console.error('Set TYPESAFE_API_KEY, or run with --dry-run.'); process.exit(2); }

const server = fileURLToPath(new URL('../../src/index.js', import.meta.url));
const client = new Client({ name: 'stats-explorer-orchestrator', version: '1.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [server], stderr: 'inherit',
  env: {
    ...process.env, STATS_EXPLORER_ROOTS: folder, STATS_EXPLORER_HIDE_LINK: '1',
    STATS_EXPLORER_CONFIRM_SELECTIONS: 'off', // the job file is the approved selection
    STATS_EXPLORER_JEV: 'orchestrated', STATS_EXPLORER_APPROVAL_SECRET: secret,
    STATS_EXPLORER_JEV_CHECKPOINTS: process.env.STATS_EXPLORER_JEV_CHECKPOINTS || 'plan,conclusions,data',
    STATS_EXPLORER_AUDIT_LOG: process.env.STATS_EXPLORER_AUDIT_LOG || resolve(folder, 'stats-explorer-audit.jsonl'),
  },
}));

/** Policy: Jev's probabilities (or, in a dry run, Stats Explorer's own checks) → a signed decision. */
async function decide(packet) {
  const own = packet.own_checks || {};
  const items = [];
  if (dry) {
    for (const id of packet.question_ids) items.push({ id, outcome: own[id]?.outcome || 'pass' });
  } else {
    const { probabilities, model } = await systemOne(api, { state: packet.state, questions: packet.questions });
    // Every question is phrased so that "true" is what Stats Explorer asks about; the data screen asks
    // whether text is an instruction, so a low probability is good there.
    for (const id of packet.question_ids) items.push({ id, probability: probabilities[id] });
    packet.model = model;
  }
  const good = (it) => (it.probability == null ? it.outcome === 'pass' : (packet.checkpoint === 'data' ? 1 - it.probability : it.probability) >= POLICY.passAt);
  const overall = items.every((it) => good(it) && !own[it.id]) ? 'pass' : items.some((it) => own[it.id]?.outcome === 'fail') ? 'fail' : 'review';
  return signApproval(secret, { packet_id: packet.packet_id, overall, items, by: POLICY.name, model: packet.model });
}

/** Calls a tool; answers every needs_approval with a signed decision and calls it again. */
async function run(name, a = {}) {
  for (let i = 0; i < 4; i++) {
    const r = await client.callTool({ name, arguments: a });
    const d = r.structuredContent || {};
    if (r.isError) throw new Error(`${name}: ${r.content.map((c) => c.text).join(' ')}`);
    if (d.status !== 'needs_approval') return d;
    const approval = await decide(d.jev_packet);
    const rec = await client.callTool({ name: 'record_verification', arguments: { packet_id: d.jev_packet.packet_id, approval } });
    const v = rec.structuredContent || {};
    console.log(`  ${d.checkpoint} check: ${v.overall}`);
    if (name === 'check_conclusions') return v;
    if (v.overall !== 'pass') throw new Error(`${name} stopped by the ${d.checkpoint} check: ${JSON.stringify(v.items?.filter((x) => x.outcome !== 'pass'))}`);
  }
  throw new Error(`${name}: too many approval rounds`);
}

try {
  console.log(`Job: ${job.question}`);
  await run('start_analysis', { question: job.question, mode: 'hypothesis_test', file: job.file });
  await run('state_hypotheses', { test: job.test, test_arguments: { file: job.file, ...job.test_arguments }, alternative: job.alternative || 'two-sided', alpha: job.alpha ?? 0.05 });
  await run('check_assumptions');
  await run('check_spread');
  await run('skip_step', { step: 4, reason: 'Pipeline job: no minimum effect size was specified.' });
  const res = await run('run_test');
  console.log(`  ${res.test}: ${res.verdict}, p = ${res.p_value}`);
  await run('skip_step', { step: 6, reason: 'Pipeline job: not a rare-event detection question.' });
  const claims = (job.claims || ['The result was {significance} (p = {p}).'])
    .map((c) => c.replace('{p}', res.p_value < 0.0001 ? '< 0.0001' : res.p_value.toFixed(4)).replace('{verdict}', res.verdict).replace('{significance}', res.significant ? 'statistically significant' : 'not statistically significant'));
  const checked = await run('check_conclusions', { claims });
  for (const cl of checked.claims || []) console.log(`  claim ${cl.outcome}: ${cl.claim}`);
  if (job.report) {
    const rep = await run('build_report', { save_to: job.report, overwrite: true, ...(checked.claims?.some((x) => x.outcome === 'pass') ? { conclusions_check: checked.packet_id } : {}) });
    console.log(`Report: ${rep.saved_to}`);
  }
} catch (e) {
  console.error(`Pipeline stopped: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
