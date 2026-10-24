// Tukey HSD and the A/B tools, checked against SciPy and statsmodels (test/reference/abtest.py ->
// fixtures/abtest-ref.json), then end to end through the MCP server: classic tools, the guided
// six-step workflow with its report, the large-file (streamed) path and the Jev claim checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { studentizedRangePValue, tukeyHSD, compactLetters } from '../src/posthoc.js';
import { abReadout, abPlan, adjustP, srmCheck, bayesConversion, fisherTwoSided } from '../src/abtest.js';
import { checkClaim } from '../src/jev/checks.js';
import { connect, FIXTURES } from './helpers.mjs';

const REF = JSON.parse(readFileSync(new URL('./fixtures/abtest-ref.json', import.meta.url)));
const close = (got, want, tol = 1e-6, msg = '') => assert.ok(Math.abs(got - want) <= tol * Math.max(1e-3, Math.abs(want)), `${msg} got ${got}, want ${want}`);
const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const sd = (v) => { const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)); };
const sc = (r) => r.structuredContent;
const text = (r) => r.content[0].text;
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });
const base = { alpha: 0.05, confidence: 0.95, alternative: 'two-sided', correction: 'holm', srm_alpha: 0.001, bayesian: true, post_hoc: 'tukey' };

// ------------------------------------------------------------------ Tukey HSD

test('studentized range p-values match SciPy', () => {
  for (const [q, k, df, p] of REF.sr) close(studentizedRangePValue(q, k, df), p, 2e-4, `q=${q} k=${k} df=${df}`);
});

test('Tukey HSD differences, adjusted p-values and intervals match scipy.stats.tukey_hsd; rejections match statsmodels', () => {
  for (const ds of REF.tukey) {
    const groups = ds.groups.map((v, i) => ({ name: ds.names[i], n: v.length, mean: mean(v) }));
    const N = ds.groups.reduce((s, g) => s + g.length, 0);
    const SSW = ds.groups.reduce((s, g) => s + sd(g) ** 2 * (g.length - 1), 0);
    const t = tukeyHSD(groups, SSW / (N - groups.length), N - groups.length, 0.05);
    for (const [i, j, diff, p, lo, hi] of ds.pairs) {
      const c = t.comparisons.find((x) => x.groups[0] === ds.names[i] && x.groups[1] === ds.names[j]);
      close(c.mean_difference, diff, 1e-9, 'diff');
      close(c.p_adjusted, p, 2e-4, 'p');
      close(c.ci_lower, lo, 1e-4, 'lo'); close(c.ci_upper, hi, 1e-4, 'hi');
      assert.equal(c.significant, ds.reject[`${ds.names[i]}|${ds.names[j]}`]);
    }
    // Letters: two groups share a letter exactly when they are not significantly different.
    for (const c of t.comparisons) {
      const [a, b] = c.groups.map((g) => t.letters[g]);
      assert.equal([...a].some((x) => b.includes(x)), !c.significant, `${c.groups} letters ${a} ${b}`);
    }
  }
});

test('compact letters: top group gets "a", overlapping groups share letters', () => {
  const g = [{ name: 'low', mean: 1 }, { name: 'mid', mean: 2 }, { name: 'high', mean: 3 }];
  assert.deepEqual(compactLetters(g, [['low', 'high']]), { high: 'a', mid: 'ab', low: 'b' });
  assert.deepEqual(compactLetters(g, []), { low: 'a', mid: 'a', high: 'a' });
});

// ------------------------------------------------------------------ A/B: conversion

test('conversion A/B: z, p, one-sided p, lift intervals, Fisher, Wilson, chi-square, Holm/Bonferroni and SRM match statsmodels / SciPy', () => {
  for (const rec of REF.ab_conversion) {
    const variants = rec.arms.map(([n, x], i) => ({ name: 'ABCD'[i], n, conversions: x }));
    const r = abReadout({ ...base, metric: 'conversion', variants }).data;
    rec.wilson.forEach(([lo, hi], i) => { close(r.variants[i].ci_lower, lo, 1e-9); close(r.variants[i].ci_upper, hi, 1e-9); });
    rec.comparisons.forEach((ref, i) => {
      const c = r.comparisons[i];
      close(c.statistic.value, ref.z, 1e-9, 'z'); close(c.p_value, ref.p, 1e-7, 'p');
      close(c.absolute_lift_ci[0], ref.diff_ci[0], 1e-9); close(c.absolute_lift_ci[1], ref.diff_ci[1], 1e-9);
      close(c.relative_lift_ci[0], ref.rel_ci[0], 1e-7); close(c.relative_lift_ci[1], ref.rel_ci[1], 1e-7);
      if (c.fisher_exact_p != null) close(c.fisher_exact_p, ref.fisher_p, 1e-7, 'fisher');
      close(fisherTwoSided([[rec.arms[i + 1][1], rec.arms[i + 1][0] - rec.arms[i + 1][1]], [rec.arms[0][1], rec.arms[0][0] - rec.arms[0][1]]]), ref.fisher_p, 1e-6, 'fisher direct');
      const g = abReadout({ ...base, alternative: 'greater', metric: 'conversion', variants }).data.comparisons[i];
      close(g.p_value, ref.p_greater, 1e-7, 'one-sided');
    });
    adjustP(rec.comparisons.map((x) => x.p), 'holm').forEach((p, i) => close(p, rec.holm[i], 1e-9, 'holm'));
    adjustP(rec.comparisons.map((x) => x.p), 'bonferroni').forEach((p, i) => close(p, rec.bonferroni[i], 1e-9, 'bonf'));
    if (rec.comparisons.length > 1) r.comparisons.forEach((c, i) => close(c.p_adjusted, rec.holm[i], 1e-7));
    if (rec.omnibus) { close(r.omnibus.statistic, rec.omnibus[0], 1e-9); close(r.omnibus.p_value, rec.omnibus[1], 1e-7); }
    close(r.sample_ratio_check.chi_square, rec.srm[0], 1e-9); close(r.sample_ratio_check.p_value, rec.srm[1], 1e-7);
  }
  const uneven = srmCheck([9100, 1000], ['A', 'B'], { A: 90, B: 10 });
  close(uneven.chi_square, REF.srm_uneven[0], 1e-9); close(uneven.p_value, REF.srm_uneven[1], 1e-7);
});

test('Bayesian probabilities and expected loss match numerical integration in SciPy', () => {
  for (const rec of REF.bayes) {
    const variants = rec.arms.map(([n, x], i) => ({ name: 'ABC'[i], n, conversions: x }));
    const b = bayesConversion(variants, 0);
    rec.best.forEach((p, i) => close(b.variants[i].prob_best, p, 1e-6, 'best'));
    rec.beats.forEach((p, i) => close(b.variants[i + 1].prob_beats_control, p, 1e-6, 'beats'));
    rec.loss.forEach((l, i) => assert.ok(Math.abs(b.variants[i].expected_loss - l) < 1e-8, `loss ${b.variants[i].expected_loss} vs ${l}`));
  }
});

test('a sample ratio mismatch blocks the decision', () => {
  const r = abReadout({ ...base, metric: 'conversion', variants: [{ name: 'A', n: 10000, conversions: 500 }, { name: 'B', n: 9000, conversions: 520 }] }).data;
  assert.equal(r.sample_ratio_check.mismatch, true);
  assert.match(r.decision, /sample ratio mismatch/);
  assert.match(r.warnings.join(' '), /Sample ratio mismatch/);
});

// ------------------------------------------------------------------ A/B: continuous

test('continuous A/B: Welch t, p, df and interval match SciPy; 3+ variants get ANOVA and Tukey', () => {
  for (const rec of REF.ab_continuous) {
    const variants = rec.groups.map((v, i) => ({ name: 'ABC'[i], n: v.length, mean: mean(v), sd: sd(v) }));
    const r = abReadout({ ...base, metric: 'continuous', variants }).data;
    rec.welch.forEach((w, i) => {
      const c = r.comparisons[i];
      close(c.statistic.value, w.t, 1e-9, 't'); close(c.p_value, w.p, 1e-7, 'p'); close(c.df, w.df, 1e-9, 'df');
      close(c.absolute_lift_ci[0], w.ci[0], 1e-7); close(c.absolute_lift_ci[1], w.ci[1], 1e-7);
      close(abReadout({ ...base, alternative: 'greater', metric: 'continuous', variants }).data.comparisons[i].p_value, w.p_greater, 1e-7);
    });
    if (rec.anova) {
      close(r.omnibus.statistic, rec.anova[0], 1e-9); close(r.omnibus.p_value, rec.anova[1], 1e-7);
      for (const c of r.post_hoc.comparisons) {
        const [i, j] = c.groups.map((g) => 'ABC'.indexOf(g));
        close(c.p_adjusted, rec.tukey_p[i][j], 2e-4);
      }
    }
  }
});

// ------------------------------------------------------------------ planning

test('sample sizes and detectable effects match statsmodels NormalIndPower', () => {
  for (const p of REF.plan_conversion) {
    const r = abPlan({ metric: 'conversion', baseline_rate: p.p1, mde: p.p2 - p.p1, mde_type: 'absolute', variants: 2, alpha: p.alpha, power: p.power, alternative: p.alternative === 'larger' ? 'greater' : 'two-sided' }).data;
    close(r.cohens_h, p.h, 1e-9);
    assert.ok(Math.abs(r.n_per_variant - p.n) <= 1, `n ${r.n_per_variant} vs ${p.n}`);
  }
  for (const m of REF.plan_mde) {
    const r = abPlan({ metric: 'conversion', baseline_rate: 0.05, n_per_variant: m.n, variants: 2, alpha: m.alpha, power: m.power }).data;
    close(r.detectable.cohens_h, m.h, 1e-6); close(r.detectable.cohens_h, m.h_statsmodels, 1e-4);
  }
  for (const p of REF.plan_continuous) {
    const r = abPlan({ metric: 'continuous', baseline_sd: 10, mde: p.d * 10, variants: 2, alpha: p.alpha, power: p.power }).data;
    assert.ok(Math.abs(r.n_per_variant - p.n) <= 1, `n ${r.n_per_variant} vs ${p.n}`);
  }
  const three = abPlan({ metric: 'conversion', baseline_rate: 0.02, mde: 0.005, variants: 4, alpha: 0.05, power: 0.8, daily_traffic: 5000 }).data;
  const ref = REF.plan_conversion.find((x) => x.p1 === 0.02);
  assert.ok(Math.abs(three.n_per_variant - ref.n) <= 1, 'α split over 3 comparisons');
  assert.equal(three.days_needed, Math.ceil(three.total_n / 5000));
});

// ------------------------------------------------------------------ Jev claim checks name the pair

test('claim checks use the named comparison: a non-significant variant called significant fails', () => {
  const r = abReadout({ ...base, metric: 'conversion', variants: REF.ab_conversion[3].arms.map(([n, x], i) => ({ name: ['Control', 'Green', 'Red', 'Blue'][i], n, conversions: x })) }).data;
  const green = r.comparisons.find((c) => c.variant === 'Green'), red = r.comparisons.find((c) => c.variant === 'Red');
  assert.ok(green.significant && !red.significant);
  assert.equal(checkClaim('Green converts significantly better than Control.', { numbers: [], tests: [r] }).outcome, 'pass');
  assert.equal(checkClaim('Red converts significantly better than Control.', { numbers: [], tests: [r] }).outcome, 'fail');
});

// ------------------------------------------------------------------ through the MCP server

const EXP = REF.experiment_file;

test('classic tools: ab_test from a file (conversion and revenue, with segments) and ANOVA with Tukey', async () => {
  const c = await connect({ guided: false, confirm: false });
  const streamed = process.env.STATS_EXPLORER_STREAM_MB === '0'; // every file forced through the large-file path
  const segArgs = { metric: 'conversion', file: 'experiment.csv', variant_column: 'variant', outcome_column: 'converted', segment_column: 'device' };
  if (streamed) {
    const seg = await call(c, 'ab_test', segArgs);
    assert.ok(seg.isError); assert.match(text(seg), /segment_column needs a data file small enough/);
  } else assert.equal(sc(await call(c, 'ab_test', segArgs)).segments.length, 2);
  const conv = sc(await call(c, 'ab_test', { ...segArgs, segment_column: undefined }));
  for (const v of conv.variants) assert.deepEqual([v.n, v.conversions], EXP.counts[v.name]);
  for (const cmp of conv.comparisons) { close(cmp.statistic.value, EXP.z[cmp.variant][0], 1e-9); close(cmp.p_value, EXP.z[cmp.variant][1], 1e-7); }
  const rev = sc(await call(c, 'ab_test', { metric: 'continuous', file: 'experiment.csv', variant_column: 'variant', outcome_column: 'revenue' }));
  for (const cmp of rev.comparisons) { close(cmp.statistic.value, EXP.welch[cmp.variant][0], 1e-9); close(cmp.p_value, EXP.welch[cmp.variant][1], 1e-7); }
  const an = sc(await call(c, 'anova', { file: 'experiment.csv', column: 'revenue', group_column: 'variant' }));
  for (const cmp of an.post_hoc.comparisons) { const [i, j] = cmp.groups.map((g) => 'ABC'.indexOf(g)); close(cmp.p_adjusted, EXP.tukey_revenue_p[i][j], 2e-4); }
  assert.deepEqual(an.post_hoc.significant_pairs.map((p) => `${p.higher}>${p.lower}`), ['B>A']);
  const t = text(await call(c, 'anova', { file: 'experiment.csv', column: 'revenue', group_column: 'variant' }));
  assert.match(t, /★ B > A/);
  const bad = await call(c, 'ab_test', { metric: 'conversion', file: 'experiment.csv', variant_column: 'variant', outcome_column: 'device' });
  assert.ok(bad.isError); assert.match(text(bad), /success_value/);
  await c.close();
});

test('large-file path gives the same A/B and Tukey results as in memory', async () => {
  for (const env of [{ STATS_EXPLORER_STREAM_MB: '0' }, { STATS_EXPLORER_STREAM_MB: '0', STATS_EXPLORER_EXACT_CAP: '3', STATS_EXPLORER_CHUNK_KB: '8', STATS_EXPLORER_WORKERS: '2' }]) {
    const c = await connect({ guided: false, confirm: false, env });
    const conv = sc(await call(c, 'ab_test', { metric: 'conversion', file: 'experiment.csv', variant_column: 'variant', outcome_column: 'converted' }));
    for (const v of conv.variants) assert.deepEqual([v.n, v.conversions], EXP.counts[v.name]);
    const rev = sc(await call(c, 'ab_test', { metric: 'continuous', file: 'experiment.csv', variant_column: 'variant', outcome_column: 'revenue' }));
    for (const cmp of rev.comparisons) close(cmp.p_value, EXP.welch[cmp.variant][1], 1e-6);
    const an = sc(await call(c, 'anova', { file: 'experiment.csv', column: 'revenue', group_column: 'variant' }));
    for (const cmp of an.post_hoc.comparisons) { const [i, j] = cmp.groups.map((g) => 'ABC'.indexOf(g)); close(cmp.p_adjusted, EXP.tukey_revenue_p[i][j], 2e-4); }
    await c.close();
  }
});

test('guided: an A/B test follows the six steps (SRM in step 2, lift-based power in step 4) and the report highlights the winner', async () => {
  const out = mkdtempSync(join(tmpdir(), 'se-ab-'));
  const c = await connect({ confirm: false, env: { STATS_EXPLORER_ROOTS: `${FIXTURES}${process.platform === 'win32' ? ';' : ':'}${out}` } });
  await call(c, 'start_analysis', { question: 'Did variant B increase conversion compared with A?', mode: 'hypothesis_test', file: 'experiment.csv' });
  const s1 = await call(c, 'state_hypotheses', { test: 'ab_test', test_arguments: { metric: 'conversion', file: 'experiment.csv', variant_column: 'variant', outcome_column: 'converted', control: 'A', variants_to_include: ['A', 'B'] } });
  assert.ok(!s1.isError, text(s1));
  const s2 = sc(await call(c, 'check_assumptions'));
  const srm = s2.checks.find((x) => /Sample ratio/.test(x.check));
  assert.equal(srm.status, 'ok');
  await call(c, 'check_spread');
  const ask = sc(await call(c, 'power_analysis', {}));
  assert.equal(ask.status, 'needs_input');
  const p4 = sc(await call(c, 'power_analysis', { smallest_effect: 0.03 }));
  assert.ok(p4.power > 0 && p4.power < 1 && p4.n_needed > 0);
  const r5 = await call(c, 'run_test');
  assert.ok(!r5.isError, text(r5));
  assert.match(text(r5), /★ B vs A/);
  await call(c, 'skip_step', { step: 6, reason: 'Not a rare-event question.' });
  const rep = await call(c, 'build_report', { save_to: join(out, 'ab.md') });
  assert.ok(!rep.isError, text(rep));
  const md = readFileSync(join(out, 'ab.md'), 'utf8');
  assert.match(md, /Sample ratio check: ok/);
  assert.match(md, /\*\*B\*\*: \+/);
  assert.match(md, /\*\*Decision:\*\* B beats A/);
  await c.close();
  rmSync(out, { recursive: true, force: true });
});

test('guided: ANOVA report names the groups that differ (Tukey)', async () => {
  const out = mkdtempSync(join(tmpdir(), 'se-tk-'));
  const c = await connect({ confirm: false, env: { STATS_EXPLORER_ROOTS: `${FIXTURES}${process.platform === 'win32' ? ';' : ':'}${out}` } });
  await call(c, 'start_analysis', { question: 'Does revenue differ between variants?', mode: 'hypothesis_test', file: 'experiment.csv' });
  await call(c, 'state_hypotheses', { test: 'anova', test_arguments: { file: 'experiment.csv', column: 'revenue', group_column: 'variant' } });
  await call(c, 'check_assumptions'); await call(c, 'check_spread');
  await call(c, 'power_analysis', { use_conventional: true });
  const r5 = sc(await call(c, 'run_test'));
  assert.ok(r5.post_hoc && r5.post_hoc.groups_that_differ.includes('B'));
  await call(c, 'skip_step', { step: 6, reason: 'n/a' });
  await call(c, 'build_report', { save_to: join(out, 'tk.md') });
  const md = readFileSync(join(out, 'tk.md'), 'utf8');
  assert.match(md, /Which groups differ \(Tukey HSD/);
  assert.match(md, /\*\*B > A\*\*/);
  assert.match(md, /Groups sharing a letter/);
  await c.close();
  rmSync(out, { recursive: true, force: true });
});

test('guided exploration: ab_test_plan sizes a future test', async () => {
  const c = await connect({ confirm: false });
  await call(c, 'start_analysis', { question: 'How many visitors do I need for a checkout test?', mode: 'explore' });
  const r = await call(c, 'ab_test_plan', { metric: 'conversion', baseline_rate: 0.04, mde: 0.1, mde_type: 'relative', daily_traffic: 3000 });
  assert.ok(!r.isError, text(r));
  assert.ok(sc(r).n_per_variant > 30000 && sc(r).days_needed > 20);
  await c.close();
});
