// find_relationships: "what drives X?" — how strongly each column relates to a numeric target.
// Numeric columns: Pearson r. Categorical columns (2–50 groups): the correlation ratio η (sqrt of η²,
// the share of the target's variance explained by the groups) and the best/worst group means.
// Descriptive only (no p-values): a ranked starting point for follow-up questions or tests.
import { openTable, isNumericColumn, requireColumn, categories, UserError } from './data.js';
import { groupValues, pairedColumns } from './tools.js';
import { accumulate } from './big/service.js';
import { sMean, sVar } from './big/sumstats.js';
import { mean, variance, fmt } from './stats.js';
import { z } from 'zod';
import { confirmSelection } from './confirm.js';

const MAX_GROUPS = 200;

function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy))) : null;
}

/** η² and group means from per-group { n, mean, var }. */
function etaFromGroups(groups) {
  const N = groups.reduce((s, g) => s + g.n, 0);
  if (N < 3 || groups.length < 2) return null;
  const grand = groups.reduce((s, g) => s + g.n * g.mean, 0) / N;
  const ssb = groups.reduce((s, g) => s + g.n * (g.mean - grand) ** 2, 0);
  const ssw = groups.reduce((s, g) => s + (g.n > 1 ? g.var * (g.n - 1) : 0), 0);
  if (ssb + ssw <= 0) return null;
  const sorted = [...groups].sort((a, b) => b.mean - a.mean);
  return { eta2: ssb / (ssb + ssw), n: N, highest: { group: sorted[0].name, mean: sorted[0].mean, n: sorted[0].n }, lowest: { group: sorted.at(-1).name, mean: sorted.at(-1).mean, n: sorted.at(-1).n } };
}

const strengthLabel = (s) => (s >= 0.5 ? 'strong' : s >= 0.3 ? 'moderate' : s >= 0.1 ? 'weak' : 'negligible');

export async function findRelationships(a) {
  const table = await openTable(a.file);
  requireColumn(table, a.target);
  if (!isNumericColumn(table, a.target)) throw new UserError(`${a.target} is not numeric. find_relationships needs a numeric target (an outcome such as revenue, score or time).`);
  const candidates = (a.columns?.length ? a.columns : table.headers).filter((h) => h !== a.target);
  for (const c of candidates) requireColumn(table, c);
  const numeric = candidates.filter((h) => isNumericColumn(table, h));
  const cats = candidates.filter((h) => !numeric.includes(h));
  const skipped = [];
  const rows = [];

  if (table.big) {
    const specs = [...numeric.map((h) => ({ type: 'pair', x: h, y: a.target })), ...cats.map((h) => ({ type: 'grouped', col: a.target, by: h }))];
    let res;
    try { res = await accumulate(table.path, specs); } catch (e) { throw e instanceof UserError ? e : new UserError(e.message); }
    numeric.forEach((h, i) => {
      const st = res.states[i];
      if (st.bad || st.n < 3 || !(st.x.m2 > 0) || !(st.y.m2 > 0)) { skipped.push(`${h} (not enough numeric values or no variation)`); return; }
      const r = st.x.exact && st.y.exact ? pearson(st.x.exact, st.y.exact) : Math.max(-1, Math.min(1, st.cxy / Math.sqrt(st.x.m2 * st.y.m2)));
      rows.push({ column: h, kind: 'numeric', measure: 'Pearson r', value: r, strength: Math.abs(r), n: st.n });
    });
    cats.forEach((h, j) => {
      const st = res.states[numeric.length + j];
      if (st.bad) { skipped.push(`${h} (${a.target} has non-numeric values)`); return; }
      if (st.groups.size > MAX_GROUPS || st.overflow) { skipped.push(`${h} (${st.overflow ? 'over 1,000' : st.groups.size} categories; looks like an ID or free text)`); return; }
      const e = etaFromGroups([...st.groups].map(([name, S]) => ({ name, n: S.n, mean: sMean(S), var: S.n > 1 ? sVar(S) : 0 })));
      if (!e) { skipped.push(`${h} (fewer than 2 groups)`); return; }
      rows.push({ column: h, kind: 'categorical', measure: 'correlation ratio η', value: Math.sqrt(e.eta2), eta_squared: e.eta2, strength: Math.sqrt(e.eta2), n: e.n, groups: st.groups.size, highest: e.highest, lowest: e.lowest });
    });
  } else {
    for (const h of numeric) {
      const [y, x] = pairedColumns(table, a.target, h);
      const r = x.length >= 3 ? pearson(x, y) : null;
      if (r === null) { skipped.push(`${h} (not enough numeric values or no variation)`); continue; }
      rows.push({ column: h, kind: 'numeric', measure: 'Pearson r', value: r, strength: Math.abs(r), n: x.length });
    }
    for (const h of cats) {
      const k = categories(table, h).length;
      if (k > MAX_GROUPS) { skipped.push(`${h} (${k} categories; looks like an ID or free text)`); continue; }
      const g = groupValues(table, a.target, h);
      const e = etaFromGroups([...g].map(([name, v]) => ({ name, n: v.length, mean: mean(v), var: v.length > 1 ? variance(v) : 0 })));
      if (!e) { skipped.push(`${h} (fewer than 2 groups)`); continue; }
      rows.push({ column: h, kind: 'categorical', measure: 'correlation ratio η', value: Math.sqrt(e.eta2), eta_squared: e.eta2, strength: Math.sqrt(e.eta2), n: e.n, groups: g.size, highest: e.highest, lowest: e.lowest });
    }
  }
  rows.sort((p, q) => q.strength - p.strength);
  rows.forEach((r) => { r.label = strengthLabel(r.strength); });
  const top = rows.slice(0, a.top || 15);
  return {
    data: {
      target: a.target, file: table.path, relationships: top, more: Math.max(0, rows.length - top.length), skipped,
      method: 'Pearson r for numeric columns; correlation ratio η (√η², share of the target\'s variance explained by the groups) for categorical columns. Both run 0 to 1 in strength and are comparable. Descriptive, no p-values.',
      warnings: ['These are associations in this data, not causes. Columns can be related through a third factor. To check whether a specific difference or relationship is real, run a hypothesis test on it.'],
    },
    summary: [
      `What relates to ${a.target} (${table.path}), strongest first:`,
      ...top.map((r, i) => `  ${i + 1}. ${r.column}: ${r.kind === 'numeric' ? `r = ${fmt(r.value, 3)}` : `η = ${fmt(r.value, 3)} (explains ${fmt(r.eta_squared * 100, 3)}% of the variance; highest mean ${r.highest.group} ${fmt(r.highest.mean)}, lowest ${r.lowest.group} ${fmt(r.lowest.mean)})`} — ${r.label}`),
      ...(rows.length > top.length ? [`  … ${rows.length - top.length} more`] : []),
      ...(skipped.length ? [`Skipped: ${skipped.join('; ')}.`] : []),
    ],
  };
}

// ------------------------------------------------------------------ tool definitions


const DESCRIPTION = 'For open analytics questions such as "what drives revenue?", "what is related to churn time?" or "which factors matter for score?": ranks every other column (or the ones given) by how strongly it relates to a numeric target column. Pearson r for numeric columns, correlation ratio η plus the highest/lowest group for categorical ones. Descriptive (no p-values); follow up on the top findings with group_summary, correlation, charts or a hypothesis test. Works on files of any size.';
const schema = {
  file: z.string().describe('The data file the user named or attached (path or name; never its contents).'),
  target: z.string().describe('The numeric outcome to explain, e.g. Revenue.'),
  columns: z.array(z.string()).optional().describe('Columns to consider (default: all others).'),
  top: z.number().int().min(1).max(100).default(15),
};
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const relationshipsTool = { name: 'find_relationships', title: 'What relates to a column', description: DESCRIPTION, inputSchema: schema, annotations: { title: 'Find relationships', ...RO }, run: findRelationships };

export const guidedRelationshipsTool = {
  name: 'find_relationships', title: 'What relates to a column',
  description: `${DESCRIPTION} Use it in an explore analysis. The user confirms the target and the columns first.`,
  inputSchema: { ...schema, confirmation_token: z.string().optional().describe('Only after the user has confirmed: the confirmation_token from the previous response.') },
  annotations: { title: 'Find relationships', ...RO },
  async run(a, ctx) {
    const { session } = ctx;
    session.requireAnalysis();
    const table = await openTable(a.file);
    const numeric = table.headers.filter((h) => isNumericColumn(table, h));
    const others = table.headers.filter((h) => h !== a.target);
    const fields = [
      { key: 'target', title: 'Outcome to explain (numeric)', type: 'select', value: a.target, options: numeric.includes(a.target) ? numeric : [a.target, ...numeric] },
      { key: 'columns', title: 'Columns to compare against it', type: 'multiselect', value: (a.columns?.length ? a.columns : others), options: others },
    ];
    const c = await confirmSelection(ctx, { kind: `relationships:${table.path}`, intro: `Rank the columns of ${table.path} by how strongly they relate to ${a.target}.`, fields, token: a.confirmation_token });
    if (!c.ok) return c.result;
    const res = await findRelationships({ ...a, ...c.values });
    const r = session.addResult({ kind: 'relationships', title: `What relates to ${c.values.target}`, data: res.data, summary: res.summary, selection: c.values });
    return { ...res, data: { ...res.data, result_id: r.id }, summary: [...res.summary, `(Saved as ${r.id} for the report.)`] };
  },
};
