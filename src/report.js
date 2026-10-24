// create_visualization and build_report (guided mode).
// Charts and report sections exist only for selections the user confirmed, and the report contains
// only the results the user confirms for it. Exploration analyses never get a hypothesis section.
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { openTable, numericColumn, isNumericColumn, isMissing, categoryKey, requireColumn, resolveWritablePath, UserError } from './data.js';
import { bigChart } from './big/bigcharts.js';
import { confirmSelection } from './confirm.js';
import { groupValues, pairedColumns } from './tools.js';
import { linearRegression } from './engine/regression.js';
import { histogram, boxPlot, scatter, bar, line, pie, CHART_CSS } from './charts.js';
import { fmt, formatPEq, mean } from './stats.js';
import { APP_NAME, VERSION } from './brand.js';
import { SOURCE_LABEL, CHECKPOINT_LABEL } from './jev/gate.js';
import { basename } from 'node:path';

const token = z.string().optional().describe('Only after the user has confirmed the proposed choices: the confirmation_token from the previous response.');
export const CHART_TYPES = ['histogram', 'box_plot', 'scatter', 'bar', 'line', 'pie'];
const CHART_LABELS = { histogram: 'Histogram', box_plot: 'Box plot', scatter: 'Scatter plot', bar: 'Bar chart', line: 'Line chart', pie: 'Pie chart' };
const NONE = '(none)';

// What each chart needs: [role, title, numericOnly, optional]
const NEEDS = {
  histogram: [['column', 'Numeric column', true, false]],
  box_plot: [['column', 'Numeric column', true, false], ['group_column', 'Split by (optional)', false, true]],
  scatter: [['x_column', 'X axis (numeric)', true, false], ['y_column', 'Y axis (numeric)', true, false]],
  bar: [['x_column', 'Categories', false, false], ['y_column', 'Value: mean of (optional; counts if none)', true, true]],
  line: [['x_column', 'X axis (in order)', false, false], ['y_column', 'Y axis (numeric)', true, false]],
  pie: [['x_column', 'Slices (categories)', false, false], ['y_column', 'Size: sum of (optional; counts if none)', true, true]],
};

function writeTarget(path) {
  const e = extname(path).toLowerCase();
  if (!['.svg', '.html', '.htm', '.md'].includes(e)) throw new UserError('save_to must end in .svg (charts) or .html / .md (reports).');
  return e;
}

// ------------------------------------------------------------------ create_visualization

async function createVisualization(a, ctx) {
  const { session } = ctx;
  session.requireAnalysis();
  if (!a.file) throw new UserError('create_visualization needs file (the data file) and the columns the user asked to see.');
  const table = await openTable(a.file);
  const numeric = table.headers.filter((h) => isNumericColumn(table, h));
  const fields = [{ key: 'chart', title: 'Chart type', type: 'select', value: a.chart, options: CHART_TYPES }];
  for (const [role, title, numOnly, optional] of NEEDS[a.chart]) {
    const value = a[role] || (optional ? NONE : '');
    if (!value) throw new UserError(`A ${CHART_LABELS[a.chart].toLowerCase()} needs ${role}.`);
    const opts = [...(optional ? [NONE] : []), ...(numOnly ? numeric : table.headers)];
    fields.push({ key: role, title, type: 'select', value, options: opts.includes(value) ? opts : [value, ...opts] });
  }
  fields.push({ key: 'title', title: 'Chart title', type: 'text', value: a.title || '' });
  const c = await confirmSelection(ctx, { kind: `viz:${table.path}`, intro: `Add a ${CHART_LABELS[a.chart].toLowerCase()} from ${table.path}${a.save_to ? `, saved to ${a.save_to}` : ''}.`, fields, token: a.confirmation_token });
  if (!c.ok) return c.result;
  const v = { ...c.values };
  for (const k of Object.keys(v)) if (v[k] === NONE) delete v[k];
  const chart = v.chart;
  // The user may have switched chart type in the form: check it still has what it needs.
  for (const [role, , , optional] of NEEDS[chart]) {
    if (!optional && !v[role] && !a[role]) throw new UserError(`The user chose a ${CHART_LABELS[chart].toLowerCase()}, which needs ${role}. Ask which column to use, then call again.`);
    if (!v[role] && a[role] && !optional) v[role] = a[role];
  }
  const t = v.title || undefined;
  let out;
  if (table.big) out = await bigChart(chart, v, table, a, t);
  else if (chart === 'histogram') out = histogram(numericColumn(table, v.column), { title: t, column: v.column, bins: a.bins });
  else if (chart === 'box_plot') {
    const groups = v.group_column ? [...groupValues(table, v.column, v.group_column)].map(([name, values]) => ({ name, values })) : [{ name: v.column, values: numericColumn(table, v.column) }];
    if (groups.length > 20) throw new UserError(`${v.group_column} has ${groups.length} groups; a box plot is readable up to about 20.`);
    out = boxPlot(groups, { title: t, column: v.column, groupColumn: v.group_column });
  } else if (chart === 'scatter') {
    const [x, y] = pairedColumns(table, v.x_column, v.y_column);
    if (x.length < 2) throw new UserError('Need at least 2 rows with both values.');
    out = scatter(x, y, { title: t, xName: v.x_column, yName: v.y_column, fit: linearRegression(x.map((xi, i) => ({ x: xi, y: y[i] }))) });
  } else {
    requireColumn(table, v.x_column);
    const xNum = isNumericColumn(table, v.x_column);
    const rows = table.rowsOf(v.y_column ? [v.x_column, v.y_column] : [v.x_column]).filter((r) => !isMissing(r[v.x_column]) && (!v.y_column || !isMissing(r[v.y_column])));
    if (v.y_column && !isNumericColumn(table, v.y_column)) throw new UserError(`${v.y_column} is not numeric.`);
    const groups = new Map();
    for (const r of rows) {
      const k = chart === 'line' && xNum ? r[v.x_column] : categoryKey(r[v.x_column]);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v.y_column ? r[v.y_column] : 1);
    }
    let keys = [...groups.keys()];
    if (chart === 'line') keys.sort((p, q) => (xNum ? p - q : 0));
    if (chart !== 'line' && keys.length > 40) throw new UserError(`${v.x_column} has ${keys.length} categories; pick a column with fewer (bar/pie charts stay readable up to about 40 / 8).`);
    const agg = (vals) => (chart === 'pie' ? vals.reduce((s, x) => s + x, 0) : v.y_column ? mean(vals) : vals.length);
    const vals = keys.map((k) => agg(groups.get(k)));
    const counts = keys.map((k) => groups.get(k).length);
    if (chart === 'bar') out = bar(keys, vals, { title: t || (v.y_column ? `Mean ${v.y_column} by ${v.x_column}` : `Count by ${v.x_column}`), xName: v.x_column, yLabel: v.y_column ? `Mean ${v.y_column}` : 'Count', counts, note: v.y_column ? 'Bar height = mean of each category' : 'Number of rows per category' });
    else if (chart === 'pie') {
      if (vals.some((x) => x < 0)) throw new UserError('A pie chart needs non-negative values.');
      out = pie(keys, vals, { title: t || (v.y_column ? `Share of ${v.y_column} by ${v.x_column}` : `Rows by ${v.x_column}`), note: v.y_column ? `Slice = sum of ${v.y_column}` : 'Slice = number of rows' });
    } else out = line(keys, vals, { title: t || `${v.y_column} by ${v.x_column}`, xName: v.x_column, yName: v.y_column, categorical: !xNum, note: counts.some((n) => n > 1) ? 'Mean of y at each x' : '' });
  }
  const title = `${CHART_LABELS[chart]}: ${[v.column, v.y_column, v.x_column].filter(Boolean).filter((x, i, arr) => arr.indexOf(x) === i).join(' / ')}${v.group_column ? ` by ${v.group_column}` : ''}`;
  let saved = null;
  if (a.save_to) {
    if (writeTarget(a.save_to) !== '.svg') throw new UserError('Charts are saved as .svg.');
    saved = await resolveWritablePath(a.save_to, { overwrite: a.overwrite });
    await writeFile(saved, out.svg, 'utf8');
  }
  const r = session.addResult({ kind: 'visualization', title, data: { chart, ...v, ...out.data }, summary: [], svg: out.svg, selection: v });
  return {
    data: { result_id: r.id, chart, columns: v, ...out.data, ...(saved ? { saved_to: saved } : {}) },
    summary: [`${title} created (${r.id}).`, saved ? `Saved to ${saved}.` : 'It will appear in the report if the user includes it (build_report).'],
  };
}

// ------------------------------------------------------------------ build_report

const REPORTABLE = ['hypothesis_test', 'describe', 'confidence_interval', 'correlation', 'group_summary', 'relationships', 'visualization', 'base_rate', 'power', 'ab_plan'];

/** Tukey HSD lines for a report: significant pairs (highlighted), letters and the best group. */
export function postHocReportLines(t, omnibusSignificant) {
  if (!t) return [];
  const out = [`Which groups differ (${t.method}, family-wise α = ${t.alpha}):`];
  if (!t.significant_pairs.length) out.push('- No pair of groups differs significantly after adjusting for multiple comparisons.');
  else out.push(...t.significant_pairs.map((x) => `- **${x.higher} > ${x.lower}**: difference ${fmt(x.mean_difference)}, adjusted p = ${fmt(x.p_adjusted)}`));
  const h = t.highlight.highest;
  if (t.significant_pairs.length) out.push(h.above_all_others ? `**${h.group}** has the highest mean (${fmt(h.mean)}) and is significantly above every other group.` : `${h.group} has the highest mean (${fmt(h.mean)})${h.significantly_above.length ? `, significantly above ${h.significantly_above.join(', ')}` : ', but not significantly above the others'}.`);
  out.push(`Groups sharing a letter do not differ significantly: ${Object.entries(t.letters).map(([g, l]) => `${g} (${l})`).join(', ')}.`);
  if (!omnibusSignificant && t.significant_pairs.length) out.push('The overall test was not significant, so treat these pairwise differences with caution.');
  return out;
}

const pctR = (x, d = 2) => (x == null || !isFinite(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const ppR = (x) => (x == null || !isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)} pp`);

/** A/B readout lines for a report. */
export function abReportLines(d) {
  const conv = d.metric === 'conversion';
  const out = [];
  const s = d.sample_ratio_check;
  out.push(`Traffic split: ${d.variants.map((v, i) => `${v.name} ${v.n.toLocaleString('en-US')} (${pctR(s.observed_share[i], 1)})`).join(', ')}. Sample ratio check: ${s.mismatch ? `**mismatch** (χ² p = ${fmt(s.p_value)}); the results should not be trusted until the cause is found` : `ok (p = ${fmt(s.p_value)})`}.`);
  out.push(...d.variants.map((v) => (conv ? `- ${v.name}: ${v.conversions.toLocaleString('en-US')} of ${v.n.toLocaleString('en-US')} converted, ${pctR(v.rate)} (${Math.round(d.confidence * 100)}% CI ${pctR(v.ci_lower)} to ${pctR(v.ci_upper)})` : `- ${v.name}: mean ${fmt(v.mean)}, SD ${fmt(v.sd)}, n = ${v.n} (${Math.round(d.confidence * 100)}% CI ${fmt(v.ci_lower)} to ${fmt(v.ci_upper)})`)));
  if (d.omnibus) out.push(`Across all variants: ${d.omnibus.test}, ${formatPEq(d.omnibus.p_value)}.`);
  out.push(`Each variant against ${d.control}${d.comparisons.length > 1 ? ` (p-values ${d.correction === 'none' ? 'not adjusted' : `${d.correction === 'holm' ? 'Holm' : 'Bonferroni'}-adjusted`})` : ''}:`);
  out.push(...d.comparisons.map((c) => `- ${c.significant ? '**' : ''}${c.variant}${c.significant ? '**' : ''}: ${conv ? ppR(c.absolute_lift) : fmt(c.absolute_lift)} (CI ${conv ? `${ppR(c.absolute_lift_ci[0])} to ${ppR(c.absolute_lift_ci[1])}` : `${fmt(c.absolute_lift_ci[0])} to ${fmt(c.absolute_lift_ci[1])}`}), relative ${c.relative_lift == null ? 'n/a' : `${c.relative_lift >= 0 ? '+' : ''}${fmt(c.relative_lift * 100, 3)}%`}, ${formatPEq(c.p_value)}${d.comparisons.length > 1 ? `, adjusted p = ${fmt(c.p_adjusted)}` : ''}${c.fisher_exact_p != null ? `, Fisher's exact p = ${fmt(c.fisher_exact_p)}` : ''}${c.practical ? `; ${c.practical}` : ''}`));
  if (d.post_hoc) out.push(...postHocReportLines(d.post_hoc, d.omnibus?.significant));
  if (d.bayesian) out.push(`Bayesian view (${d.bayesian.model}): ${d.bayesian.variants.filter((v) => v.prob_beats_control != null).map((v) => `P(${v.name} beats ${d.control}) = ${pctR(v.prob_beats_control, 1)}`).join('; ')}${d.bayesian.variants[0].prob_best != null ? `. Probability of being best: ${d.bayesian.variants.map((v) => `${v.name} ${pctR(v.prob_best, 1)}`).join(', ')}. Expected loss if shipped: ${d.bayesian.variants.map((v) => `${v.name} ${ppR(v.expected_loss)}`).join(', ')}` : ''}.`);
  if (d.minimum_detectable_effect) { const m = d.minimum_detectable_effect; out.push(`With these sample sizes the test could reliably (80% power) detect a lift of about ${conv ? `${ppR(m.absolute)} (${fmt(m.relative * 100, 3)}% relative)` : fmt(m.absolute)}.`); }
  if (d.segments) out.push(`By segment (exploratory):`, ...d.segments.map((sg) => (sg.skipped ? `- ${sg.segment}: skipped (${sg.skipped})` : `- ${sg.segment} (n = ${sg.n}): ${sg.comparisons.map((c) => `${c.variant} ${conv ? ppR(c.absolute_lift) : fmt(c.absolute_lift)}, p = ${fmt(c.p_value)}${c.significant ? ' (significant)' : ''}`).join('; ')}`)));
  out.push(`**Decision:** ${d.decision}`);
  out.push(...(d.notes || []).map((n) => `- ${n}`));
  return out;
}

function hypothesisStory(res, session) {
  const an = session.analyses.find((x) => x.id === res.analysisId);
  const d = res.data;
  const step = (n) => an.steps[n - 1];
  const resultOf = (n) => session.results.find((r) => r.id === step(n).resultId);
  const sig = d.significant;
  const p = d.p_value;
  const assumptions = resultOf(2)?.data.checks || [];
  const spread = resultOf(3)?.data;
  const power = resultOf(4)?.data;
  const base = resultOf(6)?.data;
  const sections = [];
  sections.push(['1 · The question', [an.question]]);
  sections.push(['2 · The hypotheses', [`**H₀ (null):** ${d.h0}`, `**H₁ (alternative):** ${d.h1}`, `Direction: ${d.alternative || 'two-sided'}. Significance level α = ${d.alpha}. Both were fixed before the test was run.`]]);
  const how = [`We ran a ${d.test}.`];
  if (assumptions.length) how.push('Assumption checks (step 2):', ...assumptions.filter((c) => c.status !== 'question').map((c) => `- ${c.status === 'warning' ? '⚠ ' : ''}${c.check}: ${c.detail}`));
  if (spread) how.push('Spread (step 3):', ...spread.spread.map((s) => `- ${s.name}: SD ${fmt(s.std_dev)}, IQR ${fmt(s.iqr)}${s.outliers_1_5_iqr ? `, ${s.outliers_1_5_iqr} outlier(s)` : ''}`), ...spread.notes.map((n) => `- ${n}`));
  if (step(4).status === 'skipped') how.push(`Power (step 4): skipped. ${step(4).note}`);
  else if (power) how.push(`Power (step 4): ${fmt(power.power, 3)} to detect ${power.unit} = ${power.effect}${power.conventional ? ' (a conventional medium effect)' : ''}; about ${power.needed} ${power.n_unit || ''} would be needed for ${power.target} power${power.basis ? ` (${power.basis})` : ''}.`.replace('  ', ' '));
  else if (step(4).note) how.push(`Power (step 4): ${step(4).note}.`);
  sections.push(['3 · How we tested it', how]);
  const found = d.sample_ratio_check ? [`${d.comparisons.length > 1 ? 'Smallest adjusted p-value' : 'p-value'} against the control: ${formatPEq(p)}.`] : [`${d.statistic ? `${d.statistic.name} = ${fmt(d.statistic.value)}` : 'Exact test'}${d.df !== undefined ? `, df = ${typeof d.df === 'object' ? Object.values(d.df).map((x) => fmt(x)).join(', ') : fmt(d.df)}` : ''}, ${formatPEq(p)}.`];
  if (d.effect_size) found.push(`Effect size: ${d.effect_size.name} = ${fmt(d.effect_size.value, 3)}${d.effect_size.magnitude ? ` (${d.effect_size.magnitude})` : ''}.`);
  if (d.confidence_interval) found.push(`${Math.round(d.confidence_interval.level * 100)}% confidence interval for the ${d.confidence_interval.of}: ${fmt(d.confidence_interval.lower)} to ${fmt(d.confidence_interval.upper)}.`);
  if (d.post_hoc && d.test === 'One-way ANOVA') found.push(...postHocReportLines(d.post_hoc, d.significant));
  if (d.pairwise_comparisons) {
    found.push(`Pairwise comparisons (${d.pairwise_comparisons.method}):`, ...d.pairwise_comparisons.comparisons.map((x) => `- ${x.groups[0]} vs ${x.groups[1]}: difference ${fmt(x.mean_difference)}, adjusted p = ${fmt(x.p_bonferroni)}${x.significant ? ' (significant)' : ''}`));
  }
  if (d.sample_ratio_check) found.push(...abReportLines(d));
  if (d.warnings?.length) found.push(...d.warnings.map((w) => `⚠ ${w}`));
  sections.push(['4 · What we found', found]);
  const verdict = sig
    ? `**Reject H₀.** Since p (${fmt(p)}) is below α (${d.alpha}), a result this extreme would be unlikely if the null hypothesis held.`
    : `**Fail to reject H₀.** Since p (${fmt(p)}) is not below α (${d.alpha}), the evidence is not strong enough to rule out chance. This does not prove H₀.`;
  const verdictLines = [verdict];
  if (d.effect_size?.magnitude && sig && ['negligible', 'small'].includes(d.effect_size.magnitude)) verdictLines.push('The effect is statistically significant but small; decide whether it is large enough to act on.');
  if (power && power.power < power.target && !sig) verdictLines.push('Power was low, so this non-significant result is uninformative rather than reassuring.');
  verdictLines.push('Correlation or a difference in observational data does not by itself show cause and effect.');
  sections.push(['5 · The verdict', verdictLines]);
  if (step(6).status === 'skipped') sections.push(['6 · Base rates', [`Not applicable: ${step(6).note}`]]);
  else if (base) sections.push(['6 · Base rates', [`Prevalence ${fmt(base.prevalence * 100, 3)}%, sensitivity ${fmt(base.sensitivity * 100, 3)}%, specificity ${fmt(base.specificity * 100, 3)}%: of everything flagged, ${fmt(base.ppv * 100, 3)}% is really positive. Per 10,000: ${base.per_10000.true_positive} true alarms, ${base.per_10000.false_positive} false alarms.`]]);
  return sections;
}

function genericSection(res) {
  const d = res.data;
  switch (res.kind) {
    case 'describe': {
      const rows = d.descriptives.map((s) => [s.name, s.n, fmt(s.mean), fmt(s.std_dev), fmt(s.median), `${fmt(s.q1)} – ${fmt(s.q3)}`, `${fmt(s.min)} – ${fmt(s.max)}`, s.shape ? s.shape.label : '—']);
      return { table: { head: ['Group / column', 'n', 'Mean', 'SD', 'Median', 'IQR', 'Range', 'Shape'], rows }, lines: d.descriptives.filter((s) => s.mean_ci).map((s) => `${s.name}: ${Math.round(s.mean_ci.level * 100)}% CI for the mean ${fmt(s.mean_ci.lower)} to ${fmt(s.mean_ci.upper)}.`) };
    }
    case 'confidence_interval': {
      const ci = d.confidence_interval;
      return { lines: [`${ci.of === 'mean' ? 'Mean' : 'Proportion'} = ${fmt(ci.estimate)}; ${Math.round(ci.level * 100)}% CI ${fmt(ci.lower)} to ${fmt(ci.upper)} (${ci.method}).`] };
    }
    case 'correlation':
      return { lines: [`${d.effect_size.name} = ${fmt(d.statistic.value, 4)} (${d.effect_size.magnitude}), n = ${d.n}.`, ...(d.confidence_interval ? [`${Math.round(d.confidence_interval.level * 100)}% CI ${fmt(d.confidence_interval.lower, 4)} to ${fmt(d.confidence_interval.upper, 4)}.`] : []), ...(d.linear_fit ? [`Least-squares line: ${d.linear_fit.formula} (R² = ${fmt(d.linear_fit.r_squared, 3)}).`] : []), d.interpretation] };
    case 'group_summary': {
      const cols = Object.keys(d.groups[0] || {}).filter((k) => k !== 'group');
      const rows = d.groups.map((g) => [g.group, ...cols.map((k) => (k === 'share_of_rows' ? `${fmt(g[k] * 100, 3)}%` : fmt(g[k])))]);
      return { table: { head: [d.summary_of.split(' by ').pop(), ...cols.map((k) => (k === 'share_of_rows' ? '% of rows' : k.replace('_', ' ')))], rows }, lines: [`${d.groups_total} groups, ${d.rows_total} rows${d.groups_total > d.groups.length ? `; showing the top ${d.groups.length} by ${d.sorted_by}` : ''}.`] };
    }
    case 'relationships':
      return {
        table: { head: ['Column', 'Type', 'Measure', 'Strength', 'Detail'], rows: d.relationships.map((r) => [r.column, r.kind, r.kind === 'numeric' ? `r = ${fmt(r.value, 3)}` : `η = ${fmt(r.value, 3)}`, r.label, r.kind === 'numeric' ? `n = ${r.n}` : `highest ${r.highest.group} (${fmt(r.highest.mean)}), lowest ${r.lowest.group} (${fmt(r.lowest.mean)})`]) },
        lines: [`Ranked by how strongly each column relates to ${d.target}. ${d.method}`, d.warnings[0]],
      };
    case 'base_rate':
      return { lines: [`Prevalence ${fmt(d.prevalence * 100, 3)}%, sensitivity ${fmt(d.sensitivity * 100, 3)}%, specificity ${fmt(d.specificity * 100, 3)}%.`, `PPV ${fmt(d.ppv * 100, 3)}%: of everything flagged positive, that share is really positive. Per 10,000 cases: ${d.per_10000.true_positive} true alarms, ${d.per_10000.false_positive} false alarms, ${d.per_10000.false_negative} missed.`] };
    case 'power':
      return { lines: res.summary.length ? res.summary.slice(1) : [`Power ${fmt(d.power, 3)} for ${d.unit} = ${d.effect}.`] };
    case 'ab_plan':
      return { lines: res.summary.slice(1) };
    default:
      return { lines: [] };
  }
}

const mdEscape = (s) => String(s).replace(/\|/g, '\\|');
const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mdInline = (s) => htmlEsc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

function render(blocks, { title, format, embedCharts }) {
  const date = new Date().toISOString().slice(0, 10);
  if (format === 'markdown') {
    const out = [`# ${title}`, '', `_${APP_NAME} · ${date}_`, ''];
    for (const b of blocks) {
      out.push(`## ${b.title}`, '');
      if (b.source) out.push(`_${b.source}_`, '');
      for (const [h, lines] of b.story || []) out.push(`### ${h}`, '', ...lines.map((l) => (l.startsWith('- ') ? l : `${l}\n`)), '');
      if (b.svg) out.push(embedCharts ? `![${b.title}](data:image/svg+xml;base64,${Buffer.from(b.svg).toString('base64')})` : `_[Chart ${b.id}: ${b.title}. Save the report to a .html or .md file to include the image.]_`, '');
      if (b.table) out.push(`| ${b.table.head.join(' | ')} |`, `| ${b.table.head.map(() => '---').join(' | ')} |`, ...b.table.rows.map((r) => `| ${r.map(mdEscape).join(' | ')} |`), '');
      for (const l of b.lines || []) out.push(l, '');
    }
    out.push('---', `_Statistics computed by ${APP_NAME} (engine verified against SciPy and statsmodels). Sections included only with the user's confirmation._`);
    return out.join('\n');
  }
  const body = blocks.map((b) => {
    const story = (b.story || []).map(([h, lines]) => {
      const items = []; let list = [];
      const flush = () => { if (list.length) { items.push(`<ul>${list.map((l) => `<li>${mdInline(l)}</li>`).join('')}</ul>`); list = []; } };
      for (const l of lines) { if (l.startsWith('- ')) list.push(l.slice(2)); else { flush(); items.push(`<p>${mdInline(l)}</p>`); } }
      flush();
      return `<h3>${htmlEsc(h)}</h3>${items.join('')}`;
    }).join('');
    const table = b.table ? `<table><thead><tr>${b.table.head.map((h) => `<th>${htmlEsc(h)}</th>`).join('')}</tr></thead><tbody>${b.table.rows.map((r) => `<tr>${r.map((c) => `<td>${htmlEsc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
    return `<section><h2>${htmlEsc(b.title)}</h2>${b.source ? `<p class="src">${htmlEsc(b.source)}</p>` : ''}${story}${b.svg ? `<figure>${b.svg.replace(/<svg /, '<svg style="max-width:100%;height:auto" ')}</figure>` : ''}${table}${(b.lines || []).map((l) => `<p>${mdInline(l)}</p>`).join('')}</section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlEsc(title)}</title>
<style>${CHART_CSS}
body{margin:0;background:var(--surface-1);color:var(--text-primary);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:820px;margin:0 auto;padding:32px 16px 48px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 8px;padding-top:12px;border-top:1px solid var(--grid)}
h3{font-size:15px;margin:18px 0 4px}.meta,.src,footer{color:var(--text-secondary);font-size:13px}figure{margin:16px 0}table{border-collapse:collapse;width:100%;font-size:13px;margin:12px 0;display:block;overflow-x:auto}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--grid);white-space:nowrap}th{color:var(--text-secondary);font-weight:600}ul{padding-left:20px}
@media print{body{background:#fff}h2{break-before:auto}figure,table{break-inside:avoid}}</style></head>
<body><main><h1>${htmlEsc(title)}</h1><p class="meta">${APP_NAME} · ${date}</p>
${body}
<footer><p>Statistics computed by ${APP_NAME} MCP ${VERSION} (engine verified against SciPy and statsmodels). Sections were included only with the user's confirmation.</p></footer></main></body></html>`;
}

async function buildReport(a, ctx) {
  const { session } = ctx;
  const candidates = session.results.filter((r) => REPORTABLE.includes(r.kind));
  if (!candidates.length) throw new UserError('There is nothing to report yet. Run the analysis the user asked for first.');
  const label = (r) => `${r.id} · ${r.title}${r.kind === 'hypothesis_test' ? ' (full hypothesis-test write-up, steps 1–6)' : ''}`;
  const proposed = a.include?.length ? a.include : candidates.filter((r) => r.analysisId === session.current?.id).map((r) => r.id);
  const unknown = proposed.filter((id) => !candidates.some((r) => r.id === id));
  if (unknown.length) throw new UserError(`Unknown result id(s): ${unknown.join(', ')}. Available: ${candidates.map(label).join('; ')}`);
  if (!proposed.length) throw new UserError(`Pass include with the result ids the user wants. Available: ${candidates.map(label).join('; ')}`);
  const format = a.format || (a.save_to && extname(a.save_to).toLowerCase() === '.md' ? 'markdown' : 'html');
  if (a.save_to) {
    const e = writeTarget(a.save_to);
    if ((e === '.md') !== (format === 'markdown')) throw new UserError('save_to extension and format disagree (.html → html, .md → markdown).');
  }
  const c = await confirmSelection(ctx, {
    kind: `report:${a.save_to || ''}:${format}`,
    intro: `Build a ${format === 'html' ? 'HTML' : 'Markdown'} report${a.save_to ? ` saved to ${a.save_to}` : ''}. Only the sections ticked below will be included.`,
    fields: [
      { key: 'sections', title: 'Include', type: 'multiselect', value: proposed.map((id) => label(candidates.find((r) => r.id === id))), options: candidates.map(label) },
      { key: 'title', title: 'Report title', type: 'text', value: a.title || `${APP_NAME} report` },
    ],
    token: a.confirmation_token,
  });
  if (!c.ok) return c.result;
  const ids = c.values.sections.map((s) => s.split(' · ')[0]);
  if (!ids.length) throw new UserError('The user did not tick any sections, so there is nothing to put in the report.');
  const chosen = candidates.filter((r) => ids.includes(r.id));
  const blocks = chosen.map((r) => {
    const src = r.selection?.file ? `Data: ${r.selection.file}` : r.data?.source ? `Data: ${r.data.source}` : null;
    if (r.kind === 'hypothesis_test') return { id: r.id, title: `Hypothesis test: ${r.title}`, source: src, story: hypothesisStory(r, session) };
    return { id: r.id, title: r.title, source: src, svg: r.svg, ...genericSection(r) };
  });
  let checked = null;
  if (ctx.jev?.enabled) {
    // Conclusions the AI wrote, included only if they passed check_conclusions.
    const packets = [];
    if (a.conclusions_check) {
      const v = ctx.jev.verdicts.get(a.conclusions_check);
      if (!v || v.checkpoint !== 'conclusions') throw new UserError(`conclusions_check must be the packet_id of a finished check_conclusions call (got "${a.conclusions_check}").`);
      const ok = v.items.filter((i) => i.outcome === 'pass');
      if (!ok.length) throw new UserError('None of the checked claims passed, so there are no conclusions to include. Revise them and run check_conclusions again.');
      packets.push(v.packet_id);
      checked = { total: v.items.length, passed: ok.length };
      blocks.unshift({ id: 'conclusions', title: 'Key findings', story: [['Checked against the computed results', ok.map((i) => `- ${i.claim}`)]], lines: [`Written by the AI assistant and checked before inclusion (${SOURCE_LABEL[v.source] || v.source}). ${ok.length < v.items.length ? `${v.items.length - ok.length} claim(s) that did not pass were left out.` : 'All claims passed.'}`] });
    }
    const files = chosen.map((r) => r.selection?.file).filter(Boolean).map((f) => basename(String(f)));
    const verdicts = ctx.jev.forReport({ analysisIds: [...new Set(chosen.map((r) => r.analysisId).filter(Boolean))], files: [], conclusionPackets: packets })
      .concat([...ctx.jev.verdicts.values()].filter((v) => v.checkpoint === 'data' && files.includes(basename(String(v.subject)))));
    if (verdicts.length) {
      blocks.push({
        id: 'checks', title: 'Independent checks',
        story: verdicts.map((v) => [`${CHECKPOINT_LABEL[v.checkpoint]}: ${v.overall}`, [
          `${SOURCE_LABEL[v.source] || v.source}${v.model ? ` (${v.model})` : ''}, ${v.at.slice(0, 16).replace('T', ' ')} UTC.${v.note ? ` ${v.source === 'override' ? 'Reason' : 'Note'}: ${v.note}` : ''}`,
          ...(v.checkpoint === 'conclusions'
            ? [`- ${v.items.filter((i) => i.outcome === 'pass').length} of ${v.items.length} claims passed and appear under Key findings; the others were left out.`]
            : v.items).map((i) => (typeof i === 'string' ? i : `- ${i.outcome === 'pass' ? 'Passed' : i.outcome === 'review' ? 'Flagged for review' : 'Failed'}: ${i.claim ? `"${i.claim}"` : i.label}${i.probability_ok != null ? ` (${Math.round(i.probability_ok * 100)}% OK)` : ''}${i.issues.length ? `. ${i.issues.join(' ')}` : ''}`)),
        ]]),
        lines: ['Jev (TypeSafe) judges choices and wording; it does not compute statistics. Every number in this report comes from Stats Explorer.'],
      });
    }
  }
  const doc = render(blocks, { title: c.values.title, format, embedCharts: !!a.save_to });
  let saved = null;
  if (a.save_to) {
    saved = await resolveWritablePath(a.save_to, { overwrite: a.overwrite });
    await writeFile(saved, doc, 'utf8');
  }
  const hasHyp = chosen.some((r) => r.kind === 'hypothesis_test');
  return {
    data: { included: chosen.map((r) => r.id), format, ...(saved ? { saved_to: saved } : { report: doc }), hypothesis_section: hasHyp, ...(checked ? { conclusions: checked } : {}) },
    summary: saved
      ? [`Report saved to ${saved} with ${chosen.length} section(s): ${chosen.map((r) => r.title).join('; ')}.`, hasHyp ? '' : 'No hypothesis section (none of the included results is a hypothesis test).'].filter(Boolean)
      : [`Report with ${chosen.length} section(s):`, '', format === 'markdown' ? doc : '(HTML report in structuredContent.report; pass save_to to write it to a file.)'],
  };
}

export const createVisualizationTool = {
  name: 'create_visualization', title: 'Create a chart',
  description: 'Creates a chart for the columns the user asked to see: histogram (column), box_plot (column, optional group_column), scatter (x_column, y_column), bar (x_column categories, optional y_column mean), line (x_column, y_column), pie (x_column categories, optional y_column sum). The user confirms the chart type and columns first. Optional save_to (.svg). Charts are kept for build_report.',
  inputSchema: {
    chart: z.enum(CHART_TYPES), file: z.string(),
    column: z.string().optional(), x_column: z.string().optional(), y_column: z.string().optional(), group_column: z.string().optional(),
    bins: z.number().int().min(2).max(100).optional(), title: z.string().optional(),
    save_to: z.string().optional(), overwrite: z.boolean().optional(), confirmation_token: token,
  },
  annotations: { title: 'Create chart', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  run: createVisualization,
};

export const buildReportTool = {
  name: 'build_report', title: 'Build a report',
  description: 'Builds a report from results created in this session, only when the user asks for one. include = the result ids the user wants (default: the current analysis). The user confirms the sections. A hypothesis-test write-up (question, hypotheses, how it was tested, findings, verdict, base rates) appears only for completed hypothesis tests; explorations get no hypothesis section. format html (default) or markdown; save_to writes a file in the workspace.',
  inputSchema: {
    include: z.array(z.string()).optional(), title: z.string().optional(), format: z.enum(['html', 'markdown']).optional(),
    save_to: z.string().optional(), overwrite: z.boolean().optional(), confirmation_token: token,
  },
  annotations: { title: 'Build report', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  run: buildReport,
};

/** build_report with the Jev additions: checked conclusions and an "Independent checks" section. */
export function withChecks(tool) {
  return {
    ...tool,
    description: `${tool.description} When Jev checks are on, pass conclusions_check (the packet_id from check_conclusions) to open the report with your findings that passed; an "Independent checks" section lists every Jev decision for the included analyses.`,
    inputSchema: { ...tool.inputSchema, conclusions_check: z.string().optional().describe('packet_id of a check_conclusions call whose passed claims open the report.') },
  };
}
