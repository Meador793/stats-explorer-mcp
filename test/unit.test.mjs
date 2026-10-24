import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNumber, isMissing, assertTabularSource, assertFlatRows, NotTabularError, TABULAR_STATEMENT, loadTable, setAllowedRoots } from '../src/data.js';
import { connect, FIXTURES } from './helpers.mjs';

// ------------------------------------------------------------------ parsing (the app's import module)

test('CSV is parsed by the app module: quotes, embedded commas/newlines, CRLF, BOM, typed values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-csv-'));
  writeFileSync(join(dir, 'q.csv'), '﻿a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"line1\nline2",NA\r\n');
  setAllowedRoots([dir]);
  const t = await loadTable('q.csv');
  assert.deepEqual(t.headers, ['a', 'b', 'c']);
  assert.deepEqual(t.rows, [{ a: 1, b: 'x, y', c: 'he said "hi"' }, { a: 2, b: 'line1\nline2', c: null }]);
  rmSync(dir, { recursive: true, force: true });
});
test('duplicate headers are renamed (as in the app), not silently overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-dup-'));
  writeFileSync(join(dir, 'd.csv'), 'a,a\n1,2\n');
  setAllowedRoots([dir]);
  assert.deepEqual((await loadTable('d.csv')).headers, ['a', 'a (2)']);
  rmSync(dir, { recursive: true, force: true });
});
test('strict numbers (unlike parseFloat, "12 kg" is not 12)', () => {
  assert.equal(toNumber('12'), 12);
  assert.equal(toNumber(' -1.5e3 '), -1500);
  assert.equal(toNumber('12 kg'), null);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('0x1A'), null);
  assert.equal(toNumber('0b101'), null);
  assert.equal(toNumber('Infinity'), null);
  assert.equal(toNumber('.5'), 0.5);
  assert.ok(isMissing('NA') && isMissing('') && isMissing(' n/a ') && !isMissing('0'));
});

// ------------------------------------------------------------------ tabular only

test('JSON, BSON, NDJSON and NoSQL connections get the tabular statement', () => {
  for (const f of ['orders.json', 'dump.bson', 'events.ndjson', 'x.jsonl', 'mongodb+srv://u:p@cluster/db', 'couchdb://host/db', 'redis://localhost']) {
    assert.throws(() => assertTabularSource(f), (e) => e instanceof NotTabularError && e.message.startsWith(TABULAR_STATEMENT), f);
  }
  assert.throws(() => assertTabularSource('https://example.com/data.csv'), /tabular formats.*local files only/);
  assert.throws(() => assertTabularSource('notes.pdf'), /tabular formats.*not one of those formats/);
  for (const f of ['a.csv', 'b.tsv', 'c.xlsx', 'd.parquet', 'e.txt']) assert.doesNotThrow(() => assertTabularSource(f), f);
  assert.throws(() => assertFlatRows([{ a: 1, b: { c: 2 } }]), NotTabularError);
  assert.throws(() => assertFlatRows([{ tags: [1, 2] }]), NotTabularError);
  assert.doesNotThrow(() => assertFlatRows([{ a: 1, b: 'x' }]));
});
test('a .csv that actually contains JSON documents gets the statement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-js-'));
  writeFileSync(join(dir, 'docs.csv'), '[{"_id":{"$oid":"1"},"items":[1,2]}]');
  setAllowedRoots([dir]);
  await assert.rejects(loadTable('docs.csv'), NotTabularError);
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ through MCP

let client;
before(async () => { client = await connect({ guided: false }); });
after(async () => { await client?.close(); });
const call = (name, args) => client.callTool({ name, arguments: args });
const errText = async (name, args) => {
  const r = await call(name, args);
  assert.ok(r.isError, `expected an error, got: ${r.content[0].text.slice(0, 200)}`);
  return r.content[0].text;
};

test('lists all tools with read-only annotations', async () => {
  const { tools } = await client.listTools();
  const LARGE_FILE_TOOLS = ['job_status', 'cancel_job', 'large_file_plan', 'manage_cache'];
  assert.equal(tools.filter((t) => !LARGE_FILE_TOOLS.includes(t.name)).length, 18); // 16 statistics tools (incl. ab_test, ab_test_plan) + group_summary + find_relationships
  assert.deepEqual(tools.filter((t) => LARGE_FILE_TOOLS.includes(t.name)).map((t) => t.name).sort(), [...LARGE_FILE_TOOLS].sort());
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, t.name !== 'manage_cache', t.name);
    assert.ok(t.description.length > 30, t.name);
  }
});

test('files outside the allowed folders are refused, including via symlink', async () => {
  // /etc/passwd exists only on Linux/macOS; on Windows it is a missing file. Either way nothing is read.
  assert.match(await errText('inspect_data_file', { file: '/etc/passwd' }), /outside the allowed|File not found/);
  const outside = mkdtempSync(join(tmpdir(), 'se-'));
  writeFileSync(join(outside, 'secret.csv'), 'a\n1\n');
  assert.match(await errText('inspect_data_file', { file: join(outside, 'secret.csv') }), /outside the allowed/);
  assert.match(await errText('inspect_data_file', { file: '../../package.json' }), /tabular formats/);
  const link = join(FIXTURES, 'link.csv');
  rmSync(link, { force: true });
  // Windows only lets administrators (or Developer Mode) create symlinks; skip that one check otherwise.
  let linked = true;
  try { symlinkSync(join(outside, 'secret.csv'), link); } catch (e) { if (e.code === 'EPERM') linked = false; else throw e; }
  try {
    if (linked) assert.match(await errText('inspect_data_file', { file: 'link.csv' }), /outside the allowed/);
  } finally {
    rmSync(link, { force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('helpful errors', async () => {
  assert.match(await errText('inspect_data_file', { file: 'nope.csv' }), /not found/);
  assert.match(await errText('t_test', { type: 'one_sample', sample1: [5, 5, 5] }), /no variation/);
  assert.match(await errText('t_test', { type: 'one_sample', sample1: [1] }), /at least 2/);
  assert.match(await errText('t_test', { type: 'paired', sample1: [1, 2, 3], sample2: [1, 2] }), /same length/);
  assert.match(await errText('t_test', { type: 'one_sample', file: 'trial.csv', column: 'group' }), /non-numeric/);
  assert.match(await errText('t_test', { type: 'independent', file: 'trial.csv', column: 'score', group_column: 'group' }), /Pick two groups.*Control/);
  assert.match(await errText('t_test', { type: 'independent', file: 'trial.csv', column: 'scroe', group_column: 'group', group1: 'Control', group2: 'Drug A' }), /No column named "scroe". Columns are/);
  assert.match(await errText('chi_square', { type: 'goodness_of_fit', observed: [10, 20], expected: [5, 5] }), /sums to 10/);
  assert.match(await errText('chi_square', { type: 'independence', table: [[1, 0], [2, 0]] }), /total of zero/);
  assert.match(await errText('binomial_test', { successes: 5, trials: 3 }), /0 ≤ successes ≤ trials/);
  assert.match(await errText('power_analysis', { effect_size: 0.5 }), /exactly two/);
  assert.match(await errText('fisher_exact', { table: [[1, 2, 3], [4, 5, 6]] }), /2×2/);
  assert.match(await errText('manova', { file: 'trial.csv', group_column: 'group', outcome_columns: ['bp'] }), /at least 2/);
});

test('t-test result shape and wording', async () => {
  const r = await call('t_test', { type: 'independent', sample1: [5, 6, 7, 8, 9], sample2: [1, 2, 3, 4, 5], group1: 'New', group2: 'Old' });
  const d = r.structuredContent;
  assert.equal(d.significant, true);
  assert.match(d.test, /Welch/);
  assert.equal(d.confidence_interval.level, 0.95);
  assert.equal(d.effect_size.magnitude, 'large');
  assert.ok(d.details.New && d.details.Old);
  assert.match(r.content[0].text, /reject H₀/);
});

test('tiny p-values are reported as "p < 0.0001", never 0', async () => {
  const a = Array.from({ length: 50 }, (_, i) => 10 + (i % 7) * 0.1);
  const b = a.map((v) => v + 5);
  const r = await call('t_test', { type: 'independent', sample1: a, sample2: b });
  assert.ok(r.structuredContent.p_value > 0 && r.structuredContent.p_value < 1e-30);
  assert.match(r.content[0].text, /p < 0\.0001/);
});

test('chi-square warns on small expected counts', async () => {
  const r = await call('chi_square', { type: 'independence', table: [[3, 1], [1, 3]] });
  assert.match(r.structuredContent.warnings.join(' '), /fisher|Fisher/);
});

test('choose_test routes questions to tools', async () => {
  const pick = async (args) => (await call('choose_test', args)).structuredContent.tool;
  assert.equal(await pick({ goal: 'compare_two_groups', paired: true }), 't_test');
  assert.equal(await pick({ goal: 'compare_three_plus_groups' }), 'anova');
  assert.equal(await pick({ goal: 'compare_three_plus_groups', has_covariate: true }), 'ancova');
  assert.equal(await pick({ goal: 'compare_three_plus_groups', multiple_outcomes: true }), 'manova');
  assert.equal(await pick({ goal: 'association_two_categorical' }), 'chi_square');
  assert.equal(await pick({ goal: 'compare_proportion_to_value' }), 'binomial_test');
});

test('inspect_data_file reports types, missing values and quoted categories', async () => {
  const r = await call('inspect_data_file', { file: 'trial.csv' });
  const cols = Object.fromEntries(r.structuredContent.columns.map((c) => [c.name, c]));
  assert.equal(r.structuredContent.rows, 84);
  assert.equal(cols.score.type, 'numeric');
  assert.equal(cols.score.missing, 2);
  assert.equal(cols.group.distinct, 3);
  assert.ok(cols.site.top_values.some((t) => t.value === 'North, Clinic'));
});

test('result footer link can be turned off and on', async () => {
  const r = await call('describe', { values: [1, 2, 3] });
  assert.doesNotMatch(r.content[0].text, /Explore this visually/);
  const c2 = await connect({ guided: false, env: { STATS_EXPLORER_HIDE_LINK: '', STATS_EXPLORER_APP_URL: 'https://example.com/app' } });
  const r2 = await c2.callTool({ name: 'describe', arguments: { values: [1, 2, 3] } });
  assert.match(r2.content[0].text, /https:\/\/example\.com\/app/);
  await c2.close();
});

test('attached-file references are understood: @name, #file:, quotes, file:// links, subfolders', async () => {
  const { pathToFileURL } = await import('node:url');
  const { mkdirSync, copyFileSync } = await import('node:fs');
  const sub = join(FIXTURES, 'nested', 'deeper');
  mkdirSync(sub, { recursive: true });
  copyFileSync(join(FIXTURES, 'trial.csv'), join(sub, 'attached data.csv'));
  try {
    for (const ref of ['@trial.csv', '#file:trial.csv', '"trial.csv"', '`trial.csv`', pathToFileURL(join(FIXTURES, 'trial.csv')).href,
      'attached data.csv', '@attached data.csv', pathToFileURL(join(sub, 'attached data.csv')).href, 'deeper/attached data.csv']) {
      const r = await client.callTool({ name: 'inspect_data_file', arguments: { file: ref } });
      assert.ok(!r.isError, `${ref}: ${r.content?.[0]?.text}`);
      assert.match(r.content[0].text, /rows, 8 columns/, ref);
    }
    assert.match(await errText('inspect_data_file', { file: 'nowhere.csv' }), /not found/);
  } finally {
    rmSync(join(FIXTURES, 'nested'), { recursive: true, force: true });
  }
});
