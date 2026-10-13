// Large files (src/big/): streamed results equal the in-memory ones; parallel pieces merge exactly
// (also when a line break inside a quoted value falls on a split point); the user is asked before a
// long read; sample mode says so; long reads become background jobs; columns can be cached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from './helpers.mjs';

const dir = mkdtempSync(join(tmpdir(), 'se-big-'));
const cacheDir = mkdtempSync(join(tmpdir(), 'se-cache-'));
test.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(cacheDir, { recursive: true, force: true }); });

// A file with groups, missing values, and quoted values containing commas, quotes and line breaks.
let seed = 99;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const lines = ['id,group,x,y,cat,cond,test,note'];
for (let i = 0; i < 6000; i++) {
  const g = ['A', 'B', 'C'][i % 3];
  const x = 50 + 10 * gauss(), y = 2 * x + (g === 'B' ? 1.5 : 0) + 5 * gauss();
  const cond = rnd() < 0.1 ? 1 : 0, t = cond ? (rnd() < 0.85 ? 1 : 0) : (rnd() < 0.07 ? 1 : 0);
  const note = i % 7 === 0 ? '"multi\nline, with ""quotes"""' : 'plain';
  lines.push([i, g, x.toFixed(4), i % 97 === 0 ? 'NA' : y.toFixed(4), ['red', 'green', 'blue'][Math.floor(rnd() * 3)], cond, t, note].join(','));
}
writeFileSync(join(dir, 'data.csv'), `${lines.join('\n')}\n`);
writeFileSync(join(dir, 'docs.csv'), '[{"a":1},{"a":2}]\n');

const CALLS = [
  ['t_test', { type: 'independent', file: 'data.csv', column: 'y', group_column: 'group', group1: 'A', group2: 'B' }],
  ['anova', { file: 'data.csv', column: 'y', group_column: 'group', pairwise: true }],
  ['chi_square', { type: 'independence', file: 'data.csv', row_column: 'group', col_column: 'cat' }],
  ['correlation', { file: 'data.csv', x_column: 'x', y_column: 'y' }],
  ['describe', { file: 'data.csv', column: 'y', group_column: 'group' }],
  ['ancova', { file: 'data.csv', outcome_column: 'y', covariate_column: 'x', group_column: 'group' }],
  ['inspect_data_file', { file: 'data.csv' }],
  ['group_summary', { file: 'data.csv', group_column: 'cat', value_column: 'y', stats: ['count', 'sum', 'mean', 'median', 'min', 'max', 'std_dev'] }],
  ['find_relationships', { file: 'data.csv', target: 'y' }],
];
const base = { STATS_EXPLORER_ROOTS: dir, STATS_EXPLORER_CACHE_DIR: cacheDir, STATS_EXPLORER_EXACT_CAP: '100000' };
const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k === 'large_file' ? undefined : v)));

async function results(env, opts = {}) {
  const c = await connect({ guided: false, confirm: false, env: { ...base, ...env }, ...opts });
  try {
    const out = [];
    for (const [name, args] of CALLS) out.push((await c.callTool({ name, arguments: args })).structuredContent);
    return out;
  } finally { await c.close(); }
}

let memory;
test('streaming gives the same results as loading into memory, also in parallel pieces', async () => {
  memory = await results({ STATS_EXPLORER_STREAM_MB: '100000' });
  const streamed = await results({ STATS_EXPLORER_STREAM_MB: '0' });
  assert.ok(streamed[0].large_file, 'the streaming path was used');
  assert.deepEqual(streamed.map(strip), memory.map(strip));
  // 2 KB pieces: many split points fall inside the multi-line quoted notes; the file is then re-read in one piece.
  const parallel = await results({ STATS_EXPLORER_STREAM_MB: '0', STATS_EXPLORER_CHUNK_KB: '2', STATS_EXPLORER_WORKERS: '3' });
  assert.deepEqual(parallel.map(strip), memory.map(strip));
});

test('without the values (summary path), statistics match and estimates are labelled', async () => {
  const s = await results({ STATS_EXPLORER_STREAM_MB: '0', STATS_EXPLORER_EXACT_CAP: '3' });
  const close = (a, b) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
  assert.ok(close(s[0].statistic.value, memory[0].statistic.value) && close(s[0].p_value, memory[0].p_value));
  assert.ok(close(s[1].statistic.value, memory[1].statistic.value));
  assert.deepEqual(s[2].table, memory[2].table);
  assert.ok(close(s[3].statistic.value, memory[3].statistic.value));
  assert.ok(close(s[5].statistic.value, memory[5].statistic.value));
  assert.deepEqual(s[0].large_file.approximate, ['medians and quartiles in details']);
  assert.match(s[0].warnings.join(' '), /Estimated from a quantile sketch/);
});

test('a long read needs the user\'s choice; sample mode says it is a sample', async () => {
  const c = await connect({ guided: false, confirm: false, env: { ...base, STATS_EXPLORER_STREAM_MB: '0', STATS_EXPLORER_ASK_SECONDS: '0' } });
  try {
    const r1 = await c.callTool({ name: 't_test', arguments: CALLS[0][1] });
    assert.equal(r1.structuredContent.status, 'needs_plan');
    assert.match(r1.content[0].text, /LARGE FILE[\s\S]*large_file_plan/);
    const p = await c.callTool({ name: 'large_file_plan', arguments: { file: 'data.csv', choice: 'sample' } });
    assert.ok(!p.isError, p.content[0].text);
    const r2 = await c.callTool({ name: 't_test', arguments: CALLS[0][1] });
    assert.ok(r2.structuredContent.large_file.sampled_fraction > 0);
    assert.match(r2.structuredContent.warnings.join(' '), /Based on a sample/);
    await c.callTool({ name: 'large_file_plan', arguments: { file: 'data.csv', choice: 'full' } });
    const r3 = await c.callTool({ name: 't_test', arguments: CALLS[0][1] });
    assert.deepEqual(strip(r3.structuredContent), strip(memory[0]));
  } finally { await c.close(); }
});

test('clients with forms ask in a form; the chosen columns are cached and reused', async () => {
  let asked = 0;
  const elicitation = async (params) => { asked++; assert.match(params.message, /data\.csv/); return { action: 'accept', content: { choice: 'full', save_columns: true } }; };
  const c = await connect({ guided: false, confirm: false, elicitation, env: { ...base, STATS_EXPLORER_STREAM_MB: '0', STATS_EXPLORER_ASK_SECONDS: '0' } });
  try {
    const r1 = await c.callTool({ name: 'anova', arguments: CALLS[1][1] });
    assert.equal(asked, 1);
    assert.equal(r1.structuredContent.large_file.from_cache, false);
    assert.deepEqual(strip(r1.structuredContent), strip(memory[1]));
    const list = await c.callTool({ name: 'manage_cache', arguments: { action: 'list' } });
    assert.match(list.content[0].text, /data\.csv: .*y.*group|data\.csv: .*group.*y/);
  } finally { await c.close(); }
  // A new server (no results in memory) reads the cached columns instead of the file.
  const c2 = await connect({ guided: false, confirm: false, env: { ...base, STATS_EXPLORER_STREAM_MB: '0', STATS_EXPLORER_ASK_SECONDS: '0' } });
  try {
    const r2 = await c2.callTool({ name: 'anova', arguments: CALLS[1][1] });
    assert.equal(r2.structuredContent.large_file.from_cache, true, r2.content[0].text);
    assert.deepEqual(strip(r2.structuredContent), strip(memory[1]));
    const cleared = await c2.callTool({ name: 'manage_cache', arguments: { action: 'clear' } });
    assert.match(cleared.content[0].text, /Deleted/);
    assert.equal(readdirSync(cacheDir).length, 0);
  } finally { await c2.close(); }
});

test('a long read becomes a background job; job_status returns the same result; jobs can be cancelled', async () => {
  const c = await connect({ guided: false, confirm: false, env: { ...base, STATS_EXPLORER_STREAM_MB: '0', STATS_EXPLORER_BACKGROUND_SECONDS: '0', STATS_EXPLORER_CHUNK_KB: '4', STATS_EXPLORER_WORKERS: '1' } });
  try {
    const r1 = await c.callTool({ name: 'correlation', arguments: CALLS[3][1] });
    assert.equal(r1.structuredContent.status, 'running', r1.content[0].text);
    assert.match(r1.content[0].text, /STILL RUNNING[\s\S]*job_status/);
    const id = r1.structuredContent.job_id;
    let r2;
    for (let i = 0; i < 10; i++) { r2 = await c.callTool({ name: 'job_status', arguments: { job_id: id, wait_seconds: 10 } }); if (r2.structuredContent?.status !== 'running') break; }
    assert.match(r2.content[0].text, new RegExp(`${id} \\(correlation\\) finished`));
    assert.deepEqual(strip(r2.structuredContent), strip(memory[3]));
    // cancel: a different column pair is not cached in memory, so it reads again
    const r3 = await c.callTool({ name: 'describe', arguments: { file: 'data.csv', column: 'x', group_column: 'cat' } });
    assert.equal(r3.structuredContent.status, 'running');
    await c.callTool({ name: 'cancel_job', arguments: { job_id: r3.structuredContent.job_id } });
    const r4 = await c.callTool({ name: 'job_status', arguments: { job_id: r3.structuredContent.job_id, wait_seconds: 10 } });
    assert.ok(['cancelled', undefined].includes(r4.structuredContent?.status) || /finished/.test(r4.content[0].text), r4.content[0].text);
  } finally { await c.close(); }
});

test('large files: missing columns and JSON content give the usual messages', async () => {
  const c = await connect({ guided: false, confirm: false, env: { ...base, STATS_EXPLORER_STREAM_MB: '0' } });
  try {
    const r1 = await c.callTool({ name: 'describe', arguments: { file: 'data.csv', column: 'nope' } });
    assert.ok(r1.isError); assert.match(r1.content[0].text, /No column named "nope"/);
    const r2 = await c.callTool({ name: 'inspect_data_file', arguments: { file: 'docs.csv' } });
    assert.ok(r2.isError); assert.match(r2.content[0].text, /tabular formats/);
  } finally { await c.close(); }
});
