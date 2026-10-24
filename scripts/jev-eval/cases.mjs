// Labeled cases for measuring how well Jev checks Stats Explorer's two default checkpoints.
// Each case is the exact packet the MCP server would send, built with the server's own packet
// builders and with results computed by the real engine on the bundled fixture files, plus the
// answer a careful statistician would give (true = the item is fine and should pass).
import { fileURLToPath } from 'node:url';
import { IMPL } from '../../src/tools.js';
import { setAllowedRoots } from '../../src/data.js';
import { planPacket, conclusionsPacket } from '../../src/jev/checks.js';
import { fmt } from '../../src/stats.js';

const FIX = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
const B = { alpha: 0.05, confidence: 0.95, alternative: 'two-sided' };

const col = (role, name, type) => ({ role, name, type });
const plan = (label, h0, h1, alternative = 'two-sided') => ({ label, alternative, alpha: 0.05, h0, h1 });

// ------------------------------------------------------------------ plan checkpoint
// expect: { test_fits, hypotheses_match, columns_relevant }
const PLAN = [
  // Good plans.
  { id: 'plan-ttest-good', question: 'Is the average score different between Control and Drug A?', plan: plan('t-test', 'There is no difference between the mean score of Control and Drug A.', 'The mean scores of Control and Drug A differ.'), columns: [col('column', 'score', 'numeric'), col('group_column', 'group', 'categorical'), col('group1', 'Control'), col('group2', 'Drug A')], expect: { test_fits: true, hypotheses_match: true, columns_relevant: true } },
  { id: 'plan-anova-good', question: 'Do the three treatment groups differ in average score?', plan: plan('one-way ANOVA', 'All groups of group have the same mean score.', "At least one group's mean score differs."), columns: [col('column', 'score', 'numeric'), col('group_column', 'group', 'categorical')], expect: { test_fits: true, hypotheses_match: true, columns_relevant: true } },
  { id: 'plan-chisq-good', question: 'Is improvement related to which treatment group a patient was in?', plan: plan('chi-square test', 'group and improved are independent.', 'group and improved are associated.'), columns: [col('row_column', 'group', 'categorical'), col('col_column', 'improved', 'categorical')], expect: { test_fits: true, hypotheses_match: true, columns_relevant: true } },
  { id: 'plan-corr-good', question: 'Is blood pressure related to age?', plan: plan('correlation test', 'There is no linear relationship between age and bp.', 'age and bp are related.'), columns: [col('x_column', 'age', 'numeric'), col('y_column', 'bp', 'numeric'), col('method', 'pearson')], expect: { test_fits: true, hypotheses_match: true, columns_relevant: true } },
  { id: 'plan-ab-good', question: 'Did the new checkout page (B) increase conversion compared with the old one (A)?', plan: plan('A/B test', 'Every variant has the same conversion rate as A.', "At least one variant's conversion rate differs from A."), columns: [col('variant_column', 'variant', 'categorical'), col('outcome_column', 'converted', 'categorical')], expect: { test_fits: true, hypotheses_match: true, columns_relevant: true } },
  { id: 'plan-ab-onesided-good', question: 'Does variant B increase conversion over A? We only care whether it is better.', plan: plan('A/B test', 'B converts no better than A.', 'B converts better than A.', 'greater'), columns: [col('variant_column', 'variant', 'categorical'), col('outcome_column', 'converted', 'categorical')], expect: { test_fits: true, hypotheses_match: true, columns_relevant: true } },
  { id: 'plan-paired-good', question: 'Did patients\' blood pressure change between the first and second visit?', plan: plan('t-test', 'The mean of bp_before − bp_after is 0.', 'The mean difference between visits is not 0.'), columns: [col('column', 'bp_before', 'numeric'), col('column2', 'bp_after', 'numeric'), col('type', 'paired')], expect: { test_fits: true, hypotheses_match: true, columns_relevant: true } },
  // Wrong test.
  { id: 'plan-ttest-3groups', question: 'Do the three treatment groups differ in average score?', plan: plan('t-test', 'There is no difference between the mean score of the groups.', 'The mean scores differ.'), columns: [col('column', 'score', 'numeric'), col('group_column', 'group', 'categorical')], expect: { test_fits: false, hypotheses_match: true, columns_relevant: true } },
  { id: 'plan-chisq-numeric', question: 'Is the average score different between Control and Drug A?', plan: plan('chi-square test', 'score and group are independent.', 'score and group are associated.'), columns: [col('row_column', 'score', 'numeric'), col('col_column', 'group', 'categorical')], expect: { test_fits: false, hypotheses_match: false, columns_relevant: true } },
  { id: 'plan-corr-for-groups', question: 'Do men and women spend different amounts on average?', plan: plan('correlation test', 'There is no linear relationship between gender and spend.', 'gender and spend are related.'), columns: [col('x_column', 'gender', 'categorical'), col('y_column', 'spend', 'numeric')], expect: { test_fits: false, hypotheses_match: false, columns_relevant: true } },
  { id: 'plan-independent-for-paired', question: 'Did the same patients\' blood pressure change between the first and second visit?', plan: plan('t-test', 'There is no difference between the mean of bp_before and bp_after.', 'The means differ.'), columns: [col('column', 'bp_before', 'numeric'), col('column2', 'bp_after', 'numeric'), col('type', 'independent')], expect: { test_fits: false, hypotheses_match: true, columns_relevant: true } },
  { id: 'plan-anova-yesno', question: 'Did conversion rates differ between the three page variants?', plan: plan('one-way ANOVA', 'All variants have the same mean converted.', 'At least one mean differs.'), columns: [col('column', 'converted', 'categorical'), col('group_column', 'variant', 'categorical')], expect: { test_fits: false, hypotheses_match: true, columns_relevant: true } },
  // Wrong hypotheses.
  { id: 'plan-swapped', question: 'Is the average score different between Control and Drug A?', plan: plan('t-test', 'The mean scores of Control and Drug A differ.', 'There is no difference between the mean scores.'), columns: [col('column', 'score', 'numeric'), col('group_column', 'group', 'categorical'), col('group1', 'Control'), col('group2', 'Drug A')], expect: { test_fits: true, hypotheses_match: false, columns_relevant: true } },
  { id: 'plan-onesided-unasked', question: 'Is there any difference in average score between Control and Drug A?', plan: plan('t-test', 'Drug A does not score higher than Control.', 'Drug A scores higher than Control.', 'greater'), columns: [col('column', 'score', 'numeric'), col('group_column', 'group', 'categorical'), col('group1', 'Control'), col('group2', 'Drug A')], expect: { test_fits: true, hypotheses_match: false, columns_relevant: true } },
  { id: 'plan-wrong-direction', question: 'Does variant B convert better than A? We only care whether it is better.', plan: plan('A/B test', 'B converts no worse than A.', 'B converts worse than A.', 'less'), columns: [col('variant_column', 'variant', 'categorical'), col('outcome_column', 'converted', 'categorical')], expect: { test_fits: true, hypotheses_match: false, columns_relevant: true } },
  { id: 'plan-h0-not-null', question: 'Do the three treatment groups differ in average score?', plan: plan('one-way ANOVA', 'Drug B has the highest mean score.', 'Drug B does not have the highest mean score.'), columns: [col('column', 'score', 'numeric'), col('group_column', 'group', 'categorical')], expect: { test_fits: true, hypotheses_match: false, columns_relevant: true } },
  // Wrong columns.
  { id: 'plan-wrong-outcome', question: 'Is the average score different between Control and Drug A?', plan: plan('t-test', 'There is no difference between the mean age of Control and Drug A.', 'The mean ages differ.'), columns: [col('column', 'age', 'numeric'), col('group_column', 'group', 'categorical'), col('group1', 'Control'), col('group2', 'Drug A')], expect: { test_fits: true, hypotheses_match: false, columns_relevant: false } },
  { id: 'plan-extra-columns', question: 'Is blood pressure related to age?', plan: plan('correlation test', 'There is no linear relationship between chol and bp.', 'chol and bp are related.'), columns: [col('x_column', 'chol', 'numeric'), col('y_column', 'bp', 'numeric')], expect: { test_fits: true, hypotheses_match: false, columns_relevant: false } },
  { id: 'plan-ab-wrong-metric', question: 'Did variant B increase revenue per visitor compared with A?', plan: plan('A/B test', 'Every variant has the same conversion rate as A.', "At least one variant's conversion rate differs from A."), columns: [col('variant_column', 'variant', 'categorical'), col('outcome_column', 'converted', 'categorical')], expect: { test_fits: true, hypotheses_match: false, columns_relevant: false } },
  { id: 'plan-ab-device-as-arm', question: 'Did variant B increase conversion compared with A?', plan: plan('A/B test', 'Every device has the same conversion rate as mobile.', "At least one device's conversion rate differs from mobile."), columns: [col('variant_column', 'device', 'categorical'), col('outcome_column', 'converted', 'categorical')], expect: { test_fits: true, hypotheses_match: false, columns_relevant: false } },
];

// ------------------------------------------------------------------ conclusions checkpoint

async function results() {
  setAllowedRoots([FIX]);
  const mk = (id, kind, res, selection) => ({ id, kind, title: res.data.test, data: res.data, summary: res.summary, selection });
  const tArgs = { ...B, type: 'independent', file: `${FIX}trial.csv`, column: 'score', group_column: 'group', group1: 'Control', group2: 'Drug A', equal_variances: false };
  const t = await IMPL.tTest(tArgs);
  const corrArgs = { ...B, file: `${FIX}trial.csv`, x_column: 'age', y_column: 'bp', method: 'pearson' };
  const r = await IMPL.correlation(corrArgs);
  const abArgs = { ...B, metric: 'conversion', file: `${FIX}experiment.csv`, variant_column: 'variant', outcome_column: 'converted', control: 'A', correction: 'holm', srm_alpha: 0.001, bayesian: true, post_hoc: 'tukey' };
  const ab2 = await IMPL.abTest({ ...abArgs, variants_to_include: ['A', 'B'] });
  const ab3 = await IMPL.abTest(abArgs);
  const anArgs = { ...B, file: `${FIX}experiment.csv`, column: 'revenue', group_column: 'variant', pairwise: false, post_hoc: 'tukey' };
  const an = await IMPL.anova(anArgs);
  return {
    t: mk('R1', 'hypothesis_test', t, tArgs), r: mk('R2', 'hypothesis_test', r, corrArgs),
    ab2: mk('R3', 'hypothesis_test', ab2, abArgs), ab3: mk('R4', 'hypothesis_test', ab3, abArgs), an: mk('R5', 'hypothesis_test', an, anArgs),
  };
}

const p4 = (x) => fmt(x, 4);
const pct = (x, d = 2) => `${(x * 100).toFixed(d)}%`;

function conclusionCases(R) {
  const t = R.t.data, r = R.r.data, ab = R.ab2.data, ab3 = R.ab3.data, an = R.an.data;
  const cB = ab.comparisons[0];
  const c3 = Object.fromEntries(ab3.comparisons.map((c) => [c.variant, c]));
  const g = Object.fromEntries(an.groups.map((x) => [x.name, x.mean]));
  const tk = an.post_hoc;
  const pair = (a, b) => tk.comparisons.find((c) => c.groups.includes(a) && c.groups.includes(b));
  const vB = ab.variants.find((v) => v.name === 'B'), vA = ab.variants.find((v) => v.name === 'A');
  return [
    // t-test (not significant)
    { results: [R.t], question: 'Is the average score different between Control and Drug A?', claim: `The difference in mean score between Control and Drug A is not statistically significant (p = ${p4(t.p_value)}).`, expect: true },
    { results: [R.t], question: 'Is the average score different between Control and Drug A?', claim: `Drug A significantly improves scores compared with Control (p = ${p4(t.p_value)}).`, expect: false },
    { results: [R.t], question: 'Is the average score different between Control and Drug A?', claim: 'This proves Drug A and Control are equally effective.', expect: false },
    { results: [R.t], question: 'Is the average score different between Control and Drug A?', claim: `The effect size is negligible (Cohen's d = ${fmt(t.effect_size.value, 3)}).`, expect: true },
    { results: [R.t], question: 'Is the average score different between Control and Drug A?', claim: 'The difference is not significant (p = 0.04).', expect: false },
    // correlation (significant)
    { results: [R.r], question: 'Is blood pressure related to age?', claim: `Age and blood pressure are positively correlated (r = ${fmt(r.statistic.value, 3)}, p < 0.0001).`, expect: true },
    { results: [R.r], question: 'Is blood pressure related to age?', claim: 'Getting older causes blood pressure to rise.', expect: false },
    { results: [R.r], question: 'Is blood pressure related to age?', claim: `Age explains about ${Math.round(r.linear_fit.r_squared * 100)}% of the variation in blood pressure in this sample.`, expect: true },
    { results: [R.r], question: 'Is blood pressure related to age?', claim: 'Age and blood pressure are strongly negatively correlated (r = -0.58).', expect: false },
    { results: [R.r], question: 'Is blood pressure related to age?', claim: 'There is no meaningful relationship between age and blood pressure.', expect: false },
    // A/B (B vs A, significant)
    { results: [R.ab2], question: 'Did variant B increase conversion compared with A?', claim: `B converted at ${pct(vB.rate)} versus ${pct(vA.rate)} for A, a significant lift (p = ${p4(cB.p_value)}).`, expect: true },
    { results: [R.ab2], question: 'Did variant B increase conversion compared with A?', claim: `B's relative lift over A is ${(cB.relative_lift * 100).toFixed(1)}%, but the 95% interval is wide (${(cB.relative_lift_ci[0] * 100).toFixed(1)}% to ${(cB.relative_lift_ci[1] * 100).toFixed(1)}%).`, expect: true },
    { results: [R.ab2], question: 'Did variant B increase conversion compared with A?', claim: `B increases conversion by ${(cB.relative_lift * 100).toFixed(1)}% for every future visitor.`, expect: false },
    { results: [R.ab2], question: 'Did variant B increase conversion compared with A?', claim: `B converted at ${pct(vB.rate + 0.02)} versus ${pct(vA.rate)} for A.`, expect: false },
    { results: [R.ab2], question: 'Did variant B increase conversion compared with A?', claim: 'The traffic split between A and B looks as planned, so there is no sign of a sample ratio mismatch.', expect: true },
    { results: [R.ab2], question: 'Did variant B increase conversion compared with A?', claim: `There is a ${(ab.bayesian.variants.find((v) => v.name === 'B').prob_beats_control * 100).toFixed(1)}% probability that B's true conversion rate is higher than A's (Bayesian, uniform prior).`, expect: true },
    // A/B/n (B vs A not significant after Holm)
    { results: [R.ab3], question: 'Did B or C beat A?', claim: `After adjusting for comparing two variants with A, B's lift is not statistically significant (adjusted p = ${p4(c3.B.p_adjusted)}).`, expect: true },
    { results: [R.ab3], question: 'Did B or C beat A?', claim: `B significantly beats A (p = ${p4(c3.B.p_value)}).`, expect: false },
    { results: [R.ab3], question: 'Did B or C beat A?', claim: `C converts worse than A, but the difference is not significant (adjusted p = ${p4(c3.C.p_adjusted)}).`, expect: true },
    { results: [R.ab3], question: 'Did B or C beat A?', claim: 'C is the winning variant.', expect: false },
    // ANOVA + Tukey (B > A significant, others not)
    { results: [R.an], question: 'Does revenue per visitor differ between variants?', claim: `Mean revenue per visitor differs between variants (ANOVA p = ${p4(an.p_value)}).`, expect: an.significant },
    { results: [R.an], question: 'Does revenue per visitor differ between variants?', claim: `According to Tukey's test, B has significantly higher revenue per visitor than A (adjusted p = ${p4(pair('A', 'B').p_adjusted)}).`, expect: true },
    { results: [R.an], question: 'Does revenue per visitor differ between variants?', claim: `B has significantly higher revenue per visitor than C (adjusted p = ${p4(pair('B', 'C').p_adjusted)}).`, expect: false },
    { results: [R.an], question: 'Does revenue per visitor differ between variants?', claim: `B had the highest mean revenue per visitor (${fmt(g.B)}).`, expect: true },
    { results: [R.an], question: 'Does revenue per visitor differ between variants?', claim: `Variant B drives more revenue because its design is better.`, expect: false },
  ].map((c, i) => ({ ...c, id: `concl-${String(i + 1).padStart(2, '0')}` }));
}

export async function buildCases() {
  const plan = PLAN.map((c) => ({ id: c.id, checkpoint: 'plan', built: planPacket({ question: c.question, plan: c.plan, columns: c.columns }), expect: c.expect }));
  const R = await results();
  const conclusions = conclusionCases(R).map((c) => ({
    id: c.id, checkpoint: 'conclusions', claim: c.claim,
    built: conclusionsPacket({ question: c.question, claims: [c.claim], results: c.results }),
    expect: { c1: c.expect },
  }));
  return [...plan, ...conclusions];
}
