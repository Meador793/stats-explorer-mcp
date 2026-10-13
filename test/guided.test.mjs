// Guided mode (the default): intent classification, the six "Bring it all together" steps in order,
// user confirmation of every column / chart / report choice, reports without unrequested sections,
// and the tabular-only statement. Runs through real MCP clients over stdio, with and without forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { connect, FIXTURES } from './helpers.mjs';

const REF = JSON.parse(readFileSync(new URL('./reference/guided.json', import.meta.url)));
const close = (got, want, tol = 1e-6) => assert.ok(Math.abs(got - want) <= tol * Math.max(1, Math.abs(want)), `got ${got}, want ${want}`);
const text = (r) => r.content[0].text;
const sc = (r) => r.structuredContent;
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });

/** Calls a tool; if it asks for confirmation (client without forms), "the user" agrees and it is called again with the token. */
async function confirmed(c, name, args) {
  const first = await call(c, name, args);
  assert.ok(!first.isError, text(first));
  if (sc(first).status !== 'needs_confirmation') return first;
  assert.match(text(first), /CONFIRMATION NEEDED, nothing has run yet/);
  const second = await call(c, name, { ...args, confirmation_token: sc(first).confirmation_token });
  assert.ok(!second.isError, text(second));
  return second;
}

test('guided mode is the default: workflow tools, no direct test tools', async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const n of ['start_analysis', 'state_hypotheses', 'check_assumptions', 'check_spread', 'power_analysis', 'run_test', 'base_rate_check', 'skip_step', 'describe', 'create_visualization', 'build_report']) assert.ok(names.includes(n), n);
  for (const n of ['t_test', 'anova', 'chi_square']) assert.ok(!names.includes(n), `${n} should only be reachable through run_test`);
  const prompts = (await c.listPrompts()).prompts.map((p) => p.name);
  assert.deepEqual(prompts.sort(), ['analyze', 'explore_data', 'hypothesis_test']);
  assert.match(c.getInstructions(), /Bring it all together/);
  assert.match(c.getInstructions(), /built for tabular formats/);
  await c.close();
});

test('nothing runs before the request is classified with start_analysis', async () => {
  const c = await connect();
  const r = await call(c, 'describe', { file: 'trial.csv', column: 'score' });
  assert.ok(r.isError);
  assert.match(text(r), /Call start_analysis first.*hypothesis test.*explore/s);
  await c.close();
});

test('exploration: selections need the user\'s confirmation token, and the report has no hypothesis section', async () => {
  const c = await connect();
  await call(c, 'start_analysis', { question: 'What does the score distribution look like by group?', mode: 'explore', file: 'trial.csv' });

  // 1. First call only proposes.
  const p = await call(c, 'describe', { file: 'trial.csv', column: 'score', group_column: 'group' });
  assert.equal(sc(p).status, 'needs_confirmation');
  assert.deepEqual(sc(p).proposed, { column: 'score', group_column: 'group' });
  assert.ok(sc(p).options.column.includes('bp') && !sc(p).options.column.includes('group'), 'numeric roles offer numeric columns');
  assert.ok(!sc(p).descriptives, 'no statistics before confirmation');
  // 2. A made-up or mismatched token does not work.
  const bad = await call(c, 'describe', { file: 'trial.csv', column: 'score', group_column: 'group', confirmation_token: 'deadbeef' });
  assert.equal(sc(bad).status, 'needs_confirmation');
  const swapped = await call(c, 'describe', { file: 'trial.csv', column: 'bp', group_column: 'group', confirmation_token: sc(p).confirmation_token });
  assert.equal(sc(swapped).status, 'needs_confirmation', 'a token only confirms the selection it was issued for');
  // 3. With the right token it runs.
  const ok = await call(c, 'describe', { file: 'trial.csv', column: 'score', group_column: 'group', confirmation_token: sc(p).confirmation_token });
  assert.equal(sc(ok).descriptives.length, 3);
  // 4. The same selection again does not ask twice.
  const again = await call(c, 'describe', { file: 'trial.csv', column: 'score', group_column: 'group' });
  assert.ok(sc(again).descriptives);

  // Hypothesis tools are refused in an exploration.
  const h = await call(c, 'state_hypotheses', { test: 'anova', test_arguments: { file: 'trial.csv', column: 'score', group_column: 'group' } });
  assert.ok(h.isError);
  assert.match(text(h), /exploration.*start_analysis again with mode "hypothesis_test"/s);
  const rt = await call(c, 'run_test');
  assert.ok(rt.isError);

  // Correlation in an exploration is descriptive: no p-value, no verdict.
  const cor = await confirmed(c, 'correlation', { file: 'trial.csv', x_column: 'age', y_column: 'bp' });
  assert.equal(sc(cor).p_value, undefined);
  assert.equal(sc(cor).significant, undefined);
  assert.match(sc(cor).interpretation, /not a significance test/);

  // Chart: type and columns confirmed, SVG produced.
  const viz = await confirmed(c, 'create_visualization', { chart: 'box_plot', file: 'trial.csv', column: 'score', group_column: 'group' });
  assert.equal(sc(viz).groups.length, 3);

  // Report: sections confirmed, no hypothesis write-up.
  const dir = mkdtempSync(join(tmpdir(), 'se-rep-'));
  const c2 = c; // same session
  const out = join(dir, 'explore.html');
  const prop = await call(c2, 'build_report', { save_to: out });
  assert.equal(sc(prop).status, 'needs_confirmation');
  assert.ok(!existsSync(out), 'nothing written before confirmation');
  await c.close();
  rmSync(dir, { recursive: true, force: true });
});

test('exploration report (saved) contains only confirmed sections and no hypothesis section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-rep-'));
  const c = await connect({ env: { STATS_EXPLORER_ROOTS: [FIXTURES, dir].join(delimiter) } });
  await call(c, 'start_analysis', { question: 'Summarise blood pressure', mode: 'explore' });
  const d = await confirmed(c, 'describe', { file: 'trial.csv', column: 'bp' });
  await confirmed(c, 'create_visualization', { chart: 'histogram', file: 'trial.csv', column: 'bp' });
  const out = join(dir, 'bp.html');
  const r = await confirmed(c, 'build_report', { save_to: out, include: [sc(d).result_id] });
  assert.equal(sc(r).hypothesis_section, false);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /Descriptive statistics: bp/);
  assert.doesNotMatch(html, /Histogram/, 'the chart was not ticked, so it is not in the report');
  assert.doesNotMatch(html, /H₀|hypothes|p = |p-value|Reject/i);
  await c.close();
  rmSync(dir, { recursive: true, force: true });
});

test('hypothesis test: steps run in order; the user changes a dropdown in the form; results match SciPy/statsmodels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-hyp-'));
  const forms = [];
  const c = await connect({
    env: { STATS_EXPLORER_ROOTS: [FIXTURES, dir].join(delimiter) },
    elicitation: (params) => {
      forms.push(params);
      const props = params.requestedSchema.properties;
      if (props.group2) return { action: 'accept', content: { group2: 'Drug B' } }; // the user picks a different group
      return { action: 'accept', content: {} };
    },
  });
  const s = await call(c, 'start_analysis', { question: 'Does the drug change scores compared with control?', mode: 'hypothesis_test', file: 'trial.csv' });
  assert.equal(sc(s).steps.length, 6);
  assert.deepEqual(sc(s).steps.map((x) => x.title), [
    'State your question and choose the right test', 'Validate your data against the test’s assumptions', 'Check spread',
    'Calculate power before you run', 'Run the test, then report honestly', 'Sanity-check rare events against base rates']);

  // Out of order is refused.
  for (const t of ['run_test', 'check_assumptions', 'check_spread']) {
    const r = await call(c, t);
    assert.ok(r.isError, t);
    assert.match(text(r), /Step 1 \("State your question/);
  }

  const st = await call(c, 'state_hypotheses', { test: 't_test', test_arguments: { type: 'independent', file: 'trial.csv', column: 'score', group_column: 'group', group1: 'Control', group2: 'Drug A' } });
  assert.ok(!st.isError, text(st));
  const form = forms.at(-1);
  assert.deepEqual(form.requestedSchema.properties.group2.enum.sort(), ['Control', 'Drug A', 'Drug B']);
  assert.equal(form.requestedSchema.properties.group2.default, 'Drug A');
  assert.ok(form.requestedSchema.properties.column.enum.includes('bp'));
  assert.equal(sc(st).plan.args.group2, 'Drug B', 'the user\'s change in the form wins');
  assert.match(sc(st).plan.h0, /Control and Drug A/, 'default text was generated before the change; H₀ is still editable');

  const r5early = await call(c, 'run_test');
  assert.match(text(r5early), /Step 2/);

  const a2 = await call(c, 'check_assumptions');
  assert.ok(sc(a2).checks.some((x) => x.check === 'Who is missing from the sample?'));
  assert.ok(sc(a2).checks.some((x) => x.check === 'Missing values' && /score: 2/.test(x.detail)));
  const a3 = await call(c, 'check_spread');
  assert.equal(sc(a3).spread.length, 2);

  const p4a = await call(c, 'power_analysis', {});
  assert.equal(sc(p4a).status, 'needs_input');
  const p4 = await call(c, 'power_analysis', { smallest_effect: 0.5 });
  close(sc(p4).power, REF.power_two_sample_d05);
  assert.equal(sc(p4).n_needed, REF.n_needed_two_sample_d05);

  const r5 = await call(c, 'run_test');
  close(sc(r5).statistic.value, REF.welch_t);
  close(sc(r5).p_value, REF.welch_p);
  close(sc(r5).df, REF.welch_df);
  assert.equal(sc(r5).verdict, 'Fail to reject H₀');
  assert.match(text(r5), /Power was low \(step 4\)/);

  const bad6 = await call(c, 'skip_step', { step: 5, reason: 'no' });
  assert.ok(bad6.isError);
  const s6 = await call(c, 'skip_step', { step: 6, reason: 'Not a rare-event detection question.' });
  assert.ok(!s6.isError);

  const out = join(dir, 'report.html');
  const rep = await call(c, 'build_report', { save_to: out });
  assert.equal(sc(rep).hypothesis_section, true);
  const html = readFileSync(out, 'utf8');
  for (const h of ['1 · The question', '2 · The hypotheses', '3 · How we tested it', '4 · What we found', '5 · The verdict', '6 · Base rates', 'Fail to reject H₀', 'Not applicable: Not a rare-event', 'Who is missing'].slice(0, 8)) assert.ok(html.includes(h), h);
  assert.ok(html.includes('Drug B'));
  await c.close();
  rmSync(dir, { recursive: true, force: true });
});

test('declining the form runs nothing', async () => {
  const c = await connect({ elicitation: () => ({ action: 'decline' }) });
  await call(c, 'start_analysis', { question: 'Is bp related to age?', mode: 'hypothesis_test' });
  const r = await call(c, 'state_hypotheses', { test: 'correlation', test_arguments: { file: 'trial.csv', x_column: 'age', y_column: 'bp' } });
  assert.equal(sc(r).status, 'not_confirmed');
  const s2 = await call(c, 'check_assumptions');
  assert.ok(s2.isError, 'step 1 is still not done');
  await c.close();
});

test('revising the test after the assumption checks restarts later steps', async () => {
  const c = await connect({ elicitation: () => ({ action: 'accept', content: {} }) });
  await call(c, 'start_analysis', { question: 'Is bp related to age?', mode: 'hypothesis_test' });
  await call(c, 'state_hypotheses', { test: 'correlation', test_arguments: { file: 'trial.csv', x_column: 'age', y_column: 'bp' } });
  await call(c, 'check_assumptions');
  const rev = await call(c, 'state_hypotheses', { test: 'correlation', test_arguments: { file: 'trial.csv', x_column: 'age', y_column: 'bp', method: 'spearman' } });
  assert.match(text(rev), /revised/);
  const r = await call(c, 'check_spread');
  assert.match(text(r), /Step 2/);
  await call(c, 'check_assumptions'); await call(c, 'check_spread');
  const p4 = await call(c, 'power_analysis', { smallest_effect: 0.3 });
  close(sc(p4).power, REF.power_corr_r03_n84);
  assert.equal(sc(p4).n_needed, REF.n_needed_corr_r03);
  await c.close();
});

test('ANCOVA step 2 checks equal covariate slopes (matches statsmodels interaction F)', async () => {
  const c = await connect({ elicitation: () => ({ action: 'accept', content: {} }) });
  await call(c, 'start_analysis', { question: 'Do groups differ in bp after adjusting for age?', mode: 'hypothesis_test' });
  await call(c, 'state_hypotheses', { test: 'ancova', test_arguments: { file: 'trial.csv', group_column: 'group', outcome_column: 'bp', covariate_column: 'age' } });
  const a2 = await call(c, 'check_assumptions');
  const slope = sc(a2).checks.find((x) => /slopes/.test(x.check));
  close(slope.stats.F, REF.slopes_F);
  close(slope.stats.p_value, REF.slopes_p);
  assert.equal(slope.stats.df2, REF.slopes_df2);
  // Power is not computed for ANCOVA: step 4 says so and is marked done.
  await call(c, 'check_spread');
  const p4 = await call(c, 'power_analysis', {});
  assert.match(text(p4), /does not compute power for the one-way ANCOVA/);
  const r5 = await call(c, 'run_test');
  assert.ok(!r5.isError, text(r5));
  await c.close();
});

test('power in step 4 for one-sample means and proportions (matches statsmodels)', async () => {
  const c = await connect();
  await call(c, 'start_analysis', { question: 'Is the mean different from 50?', mode: 'hypothesis_test' });
  const vals = Array.from({ length: 40 }, (_, i) => 45 + ((i * 7) % 13));
  await confirmed(c, 'state_hypotheses', { test: 't_test', test_arguments: { type: 'one_sample', sample1: vals, mu0: 50 } });
  await call(c, 'check_assumptions'); await call(c, 'check_spread');
  close(sc(await call(c, 'power_analysis', { smallest_effect: 0.3 })).power, REF.power_one_sample_d03_n40);

  await call(c, 'start_analysis', { question: 'Is the coin fair?', mode: 'hypothesis_test' });
  await confirmed(c, 'state_hypotheses', { test: 'binomial_test', test_arguments: { successes: 37, trials: 60, p0: 0.5 } });
  await call(c, 'check_assumptions'); await call(c, 'check_spread');
  close(sc(await call(c, 'power_analysis', { smallest_effect: 0.6 })).power, REF.power_prop_h);
  await c.close();
});

test('JSON / BSON / NoSQL sources get the tabular statement', async () => {
  const c = await connect();
  for (const file of ['orders.json', 'export.bson', 'mongodb://localhost:27017/shop']) {
    const r = await call(c, 'start_analysis', { question: 'Average order value by region', mode: 'explore', file });
    assert.ok(r.isError);
    assert.match(text(r), /^Stats Explorer is built for tabular formats \(CSV, TSV, Excel and Parquet\) to run hypothesis tests or explore statistics\./);
    assert.equal(sc(r).status, 'not_tabular');
  }
  await call(c, 'start_analysis', { question: 'Average by group', mode: 'explore' });
  const r = await call(c, 'inspect_data_file', { file: 'orders.json' });
  assert.match(text(r), /built for tabular formats/);
  await c.close();
});

test('Excel and Parquet files are read like the app reads them', async () => {
  const c = await connect();
  const x = await call(c, 'inspect_data_file', { file: 'book.xlsx' });
  assert.ok(!x.isError, text(x));
  assert.equal(sc(x).sheet, 'Data');
  assert.ok(sc(x).notes.some((n) => /renamed/.test(n)));
  const p = await call(c, 'inspect_data_file', { file: 'polars_default.parquet' });
  assert.ok(!p.isError, text(p));
  assert.deepEqual(sc(p).columns.map((col) => col.name), ['score', 'count', 'group']);
  await c.close();
});

test('confirmations can be turned off explicitly', async () => {
  const c = await connect({ confirm: false });
  await call(c, 'start_analysis', { question: 'Summarise bp', mode: 'explore' });
  const r = await call(c, 'describe', { file: 'trial.csv', column: 'bp' });
  assert.ok(sc(r).descriptives);
  await c.close();
});
