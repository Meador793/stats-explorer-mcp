// Guided mode (the default): every analysis starts by classifying the request, hypothesis tests follow
// the six "Bring it all together" steps from the app's Learn tab in order, and every column / group /
// chart selection is confirmed by the user before it runs.
import { z } from 'zod';
import { IMPL, TOOLS, groupValues, pairedColumns, crosstab, rowsFor } from './tools.js';
import { loadTable, openTable, largeFilePath, numericColumn, requireColumn, isNumericColumn, categories, missingCount, assertTabularSource, UserError } from './data.js';
import * as BIG from './big/bigtools.js';
import { accumulate } from './big/service.js';
import { sSummarize, sMean, sSd, sVar, sQuantile, sOutliersZ, sOutliersIQR } from './big/sumstats.js';
import { confirmSelection } from './confirm.js';
import { STEPS, MODES } from './session.js';
import {
  summarize, mean, variance, stdDev, skewness, kurtosis, percentile, fmt, magnitude, normalityWarnings,
  inverseNormalCDF, formatPEq,
} from './stats.js';
import { tTestPower, normalCDF, fPValue } from './engine/statsUtils.js';

// ------------------------------------------------------------------ the tests step 1 can choose

const classic = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
export const TESTS = {
  t_test: { impl: IMPL.tTest, label: 't-test', directional: true },
  z_test: { impl: IMPL.zTest, label: 'z-test', directional: true },
  anova: { impl: IMPL.anova, label: 'one-way ANOVA', directional: false },
  ancova: { impl: IMPL.ancova, label: 'one-way ANCOVA', directional: false },
  manova: { impl: IMPL.manova, label: 'one-way MANOVA', directional: false },
  chi_square: { impl: IMPL.chiSquare, label: 'chi-square test', directional: false },
  fisher_exact: { impl: IMPL.fisherExact, label: "Fisher's exact test", directional: true },
  binomial_test: { impl: IMPL.binomialTest, label: 'exact binomial test', directional: true },
  correlation: { impl: IMPL.correlation, label: 'correlation test', directional: true },
};

const NUMERIC_ROLES = ['column', 'column2', 'x_column', 'y_column', 'outcome_column', 'covariate_column'];
const CATEGORY_ROLES = ['group_column', 'row_column', 'col_column'];
const ROLE_TITLES = {
  column: 'Measurement column', column2: 'Second column', x_column: 'X column', y_column: 'Y column',
  outcome_column: 'Outcome column', covariate_column: 'Covariate column', group_column: 'Group column',
  row_column: 'Row variable', col_column: 'Column variable', group1: 'First group', group2: 'Second group',
  outcome_columns: 'Outcome columns',
};

const token = z.string().optional().describe('Only after the user has confirmed the proposed choices: the confirmation_token from the previous response.');
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false };

// ------------------------------------------------------------------ selection fields from a table

function columnField(table, key, value, numericOnly) {
  const options = table.headers.filter((h) => !numericOnly || isNumericColumn(table, h));
  if (!options.includes(value)) options.unshift(value);
  return { key, title: ROLE_TITLES[key] || key, type: 'select', value, options };
}

/** Confirmation fields for the column / group choices in a set of tool arguments. */
function selectionFields(table, args) {
  const fields = [];
  for (const k of NUMERIC_ROLES) if (args[k]) fields.push(columnField(table, k, args[k], true));
  for (const k of CATEGORY_ROLES) if (args[k]) fields.push(columnField(table, k, args[k], false));
  if (args.group_column && table.headers.includes(args.group_column)) {
    const cats = categories(table, args.group_column);
    for (const k of ['group1', 'group2']) {
      if (args[k]) fields.push({ key: k, title: ROLE_TITLES[k], type: 'select', value: String(args[k]), options: cats.includes(String(args[k])) ? cats : [String(args[k]), ...cats] });
    }
  }
  if (args.outcome_columns) {
    const opts = table.headers.filter((h) => isNumericColumn(table, h));
    fields.push({ key: 'outcome_columns', title: ROLE_TITLES.outcome_columns, type: 'multiselect', value: args.outcome_columns, options: [...new Set([...args.outcome_columns, ...opts])] });
  }
  return fields;
}

// ------------------------------------------------------------------ start_analysis

async function startAnalysis(a, { session }) {
  if (a.file) assertTabularSource(a.file);
  const an = session.startAnalysis({ question: a.question, mode: a.mode, file: a.file });
  if (a.mode === 'hypothesis_test') {
    return {
      data: { analysis_id: an.id, mode: a.mode, steps: STEPS.map((s) => ({ step: s.number, title: s.title, what_to_do: s.detail, tool: s.tool, can_skip: s.skippable })) },
      summary: [
        `Started analysis ${an.id}: hypothesis test for "${a.question}".`,
        'Follow the six steps from Stats Explorer\'s "Bring it all together" guide, in order:',
        ...STEPS.map((s) => `${s.number}. ${s.title}: ${s.tool}${s.skippable ? ` (or skip_step with a reason, ${s.skipHint})` : ''}.`),
        'Step 1 fixes the question, hypotheses, test and columns before looking at any results. Use inspect_data_file to see the columns and choose_test if the right test is unclear. Every column and group choice is shown to the user to confirm.',
      ],
    };
  }
  return {
    data: { analysis_id: an.id, mode: a.mode, tools: ['describe', 'confidence_interval', 'correlation', 'create_visualization', 'power_analysis', 'base_rate_check', 'build_report'] },
    summary: [
      `Started analysis ${an.id}: exploring the data for "${a.question}".`,
      'Use only what the user asked for: describe (summary statistics, shape, spread), confidence_interval (estimates), correlation (strength of a relationship, no p-value), create_visualization (charts), power_analysis (sample-size planning), base_rate_check (rare-event screening).',
      'This is not a hypothesis test: do not state hypotheses or p-values, and the report will have no hypothesis section. If the user later asks whether a difference or relationship is real or significant, call start_analysis again with mode "hypothesis_test".',
      'Each column and chart choice is shown to the user to confirm before it runs; only include columns the user asked about.',
    ],
  };
}

// ------------------------------------------------------------------ step 1: state_hypotheses

function defaultHypotheses(test, args) {
  const g = (k, d) => args[k] || d;
  switch (test) {
    case 't_test':
      if (args.type === 'one_sample') return [`The mean of ${g('column', g('group1', 'the sample'))} equals ${args.mu0 ?? 0}.`, `The mean of ${g('column', g('group1', 'the sample'))} differs from ${args.mu0 ?? 0}.`];
      return [`There is no difference between the mean of ${g('group1', g('column', 'group 1'))} and ${g('group2', g('column2', 'group 2'))}.`, `The means of ${g('group1', g('column', 'group 1'))} and ${g('group2', g('column2', 'group 2'))} differ.`];
    case 'anova': return [`All groups of ${g('group_column', 'the grouping')} have the same mean ${g('column', 'outcome')}.`, `At least one group's mean ${g('column', 'outcome')} differs.`];
    case 'ancova': return [`After adjusting for ${args.covariate_column}, the groups of ${args.group_column} have the same mean ${args.outcome_column}.`, `After adjusting for ${args.covariate_column}, at least one group's mean ${args.outcome_column} differs.`];
    case 'manova': return [`The groups of ${args.group_column} have the same means on ${(args.outcome_columns || []).join(', ')}.`, 'The groups differ on the combined outcomes.'];
    case 'chi_square': return args.type === 'goodness_of_fit'
      ? ['The category counts follow the expected distribution.', 'The category counts differ from the expected distribution.']
      : [`${g('row_column', 'The row variable')} and ${g('col_column', 'the column variable')} are independent.`, `${g('row_column', 'The row variable')} and ${g('col_column', 'the column variable')} are associated.`];
    case 'fisher_exact': return ['There is no association between the two variables (odds ratio = 1).', 'The two variables are associated.'];
    case 'binomial_test': return [`The true success rate is ${args.p0 ?? 0.5}.`, `The true success rate differs from ${args.p0 ?? 0.5}.`];
    case 'z_test': return args.type === 'proportion' ? [`The true proportion is ${args.p0}.`, `The true proportion differs from ${args.p0}.`] : [`The true mean is ${args.mu0}.`, `The true mean differs from ${args.mu0}.`];
    case 'correlation': return [`There is no ${args.method === 'spearman' ? 'monotonic' : 'linear'} relationship between ${g('x_column', 'x')} and ${g('y_column', 'y')}.`, `${g('x_column', 'x')} and ${g('y_column', 'y')} are related.`];
    default: return ['', ''];
  }
}

async function stateHypotheses(a, ctx) {
  const { session } = ctx;
  const an = session.requireAnalysis('hypothesis_test');
  const def = TESTS[a.test];
  const extra = Object.keys(a.test_arguments || {}).filter((k) => ['alpha', 'alternative', 'confidence'].includes(k));
  if (extra.length) throw new UserError(`Pass ${extra.join(', ')} as top-level arguments of state_hypotheses, not inside test_arguments.`);
  if (!def.directional && a.alternative !== 'two-sided') throw new UserError(`The ${def.label} has no one-sided version; use alternative "two-sided".`);
  const schema = z.object(classic[a.test].inputSchema).strict();
  let args;
  try {
    args = schema.parse({ ...(a.test_arguments || {}), ...(def.directional ? { alternative: a.alternative } : {}), alpha: a.alpha, ...(classic[a.test].inputSchema.confidence ? { confidence: a.confidence } : {}) });
  } catch (e) {
    const issues = e.issues?.map((i) => `${i.path.join('.') || 'test_arguments'}: ${i.message}`).join('; ') || e.message;
    throw new UserError(`test_arguments don't fit the ${def.label}: ${issues}. Expected fields: ${Object.keys(classic[a.test].inputSchema).filter((k) => !['alpha', 'alternative', 'confidence'].includes(k)).join(', ')}.`);
  }
  const file = args.file || an.file;
  if (file && !args.file && Object.keys(args).some((k) => NUMERIC_ROLES.includes(k) || CATEGORY_ROLES.includes(k))) args.file = file;

  const [dh0, dh1] = defaultHypotheses(a.test, args);
  const fields = [];
  let table = null;
  if (args.file) { table = await openTable(args.file); fields.push(...selectionFields(table, args)); }
  if (def.directional) fields.push({ key: 'alternative', title: 'Direction (alternative hypothesis)', type: 'select', value: a.alternative, options: ['two-sided', 'greater', 'less'], description: 'Fixed before seeing results. greater/less only if the question is about one direction.' });
  fields.push({ key: 'alpha', title: 'Significance level α', type: 'number', value: a.alpha, min: 0.0001, max: 0.5 });
  fields.push({ key: 'h0', title: 'Null hypothesis H₀', type: 'text', value: a.h0 || dh0 });
  fields.push({ key: 'h1', title: 'Alternative hypothesis H₁', type: 'text', value: a.h1 || dh1 });

  const c = await confirmSelection(ctx, {
    kind: `state_hypotheses:${an.id}:${a.test}:${JSON.stringify(Object.fromEntries(Object.entries(args).filter(([k]) => !fields.some((f) => f.key === k))))}`,
    intro: `Step 1 of 6 for "${an.question}": run a ${def.label}${table ? ` on ${table.path}` : ' on the values given'}.`,
    fields, token: a.confirmation_token,
  });
  if (!c.ok) return c.result;

  const v = c.values;
  for (const f of fields) if (!['h0', 'h1'].includes(f.key)) args[f.key] = v[f.key];
  if (!def.directional) delete args.alternative;
  // Make sure the confirmed choices actually work with the data before moving on.
  await extractData(a.test, args);

  const first = an.steps[0].status !== 'pending';
  session.resetStepsFrom(1);
  an.plan = { test: a.test, label: def.label, args, h0: v.h0, h1: v.h1, alpha: args.alpha, alternative: args.alternative || 'two-sided', file: args.file || null };
  session.completeStep(1, { note: `${def.label}${args.file ? `, ${Object.entries(args).filter(([k]) => NUMERIC_ROLES.includes(k) || CATEGORY_ROLES.includes(k) || k === 'outcome_columns' || k === 'group1' || k === 'group2').map(([k, x]) => `${k} = ${Array.isArray(x) ? x.join('+') : x}`).join(', ')}` : ''}` });
  return {
    data: { step: 1, status: 'done', plan: an.plan, revised: first },
    summary: [
      `Step 1 done${first ? ' (revised: later steps restart, which is a principled revision, not p-hacking, as long as it follows from the assumption checks)' : ''}.`,
      `Test: ${def.label}${args.alternative && def.directional ? ` (${args.alternative})` : ''}, α = ${args.alpha}.`,
      `H₀: ${v.h0}`, `H₁: ${v.h1}`,
      ...(c.changedByUser ? ['The user changed some choices in the confirmation form; the values above are the confirmed ones.'] : []),
      'Next: step 2, check_assumptions.',
    ],
  };
}

// ------------------------------------------------------------------ data for steps 2–4

/** The data the planned test will use, in a test-independent shape. */
async function extractData(test, args) {
  if (args.file) { const big = await largeFilePath(args.file); if (big) return extractBig(test, args, big); }
  const table = args.file ? await loadTable(args.file) : null;
  const S = (name, values) => ({ name, values });
  switch (test) {
    case 't_test': {
      if (!table) {
        if (args.type === 'one_sample') return { kind: 'numeric', samples: [S(args.group1 || 'Sample', args.sample1 || [])] };
        if (args.type === 'paired') return { kind: 'paired', samples: [S(args.group1 || 'Sample 1', args.sample1 || []), S(args.group2 || 'Sample 2', args.sample2 || [])] };
        return { kind: 'numeric', samples: [S(args.group1 || 'Sample 1', args.sample1 || []), S(args.group2 || 'Sample 2', args.sample2 || [])] };
      }
      if (args.type === 'one_sample') return { kind: 'numeric', samples: [S(args.column, numericColumn(table, args.column))] };
      if (args.type === 'paired') { const [x, y] = pairedColumns(table, args.column, args.column2); return { kind: 'paired', samples: [S(args.column, x), S(args.column2, y)] }; }
      if (args.group_column) {
        const g = groupValues(table, args.column, args.group_column);
        const keys = [args.group1, args.group2].filter(Boolean).map(String);
        const use = keys.length === 2 ? keys : [...g.keys()];
        if (use.length !== 2) throw new UserError(`Pick two groups (group1, group2) from ${args.group_column}: ${[...g.keys()].join(', ')}`);
        for (const k of use) if (!g.has(k)) throw new UserError(`Group "${k}" not found in ${args.group_column}. Groups: ${[...g.keys()].join(', ')}`);
        return { kind: 'numeric', samples: use.map((k) => S(k, g.get(k))) };
      }
      return { kind: 'numeric', samples: [S(args.column, numericColumn(table, args.column)), S(args.column2, numericColumn(table, args.column2))] };
    }
    case 'z_test':
      if (args.type === 'proportion') return { kind: 'proportion', k: args.successes, n: args.n, p0: args.p0 };
      return args.values ? { kind: 'numeric', samples: [S('values', args.values)], knownSd: args.population_sd } : { kind: 'summary', n: args.n };
    case 'anova': {
      if (!table) return { kind: 'numeric', samples: (args.groups || []).map((g, i) => S(g.name || `Group ${i + 1}`, g.values)) };
      const g = groupValues(table, args.column, args.group_column);
      const keys = args.groups_to_include?.length ? args.groups_to_include.map(String) : [...g.keys()];
      for (const k of keys) if (!g.has(k)) throw new UserError(`Group "${k}" not found in ${args.group_column}.`);
      return { kind: 'numeric', samples: keys.map((k) => S(k, g.get(k))) };
    }
    case 'ancova': case 'manova': {
      const outs = test === 'ancova' ? [args.outcome_column] : args.outcome_columns;
      const nums = test === 'ancova' ? [args.outcome_column, args.covariate_column] : outs;
      const rows = await rowsFor(args, nums, args.group_column);
      const groups = [...new Set(rows.map((r) => r[args.group_column]))];
      return { kind: test, rows, groups, outs, groupCol: args.group_column, covariate: args.covariate_column };
    }
    case 'chi_square': case 'fisher_exact': {
      if (args.type === 'goodness_of_fit') {
        if (table) {
          const counts = new Map();
          for (const v of table.column(args.column)) if (v !== null && v !== undefined) counts.set(String(v), (counts.get(String(v)) || 0) + 1);
          return { kind: 'gof', observed: [...counts.values()], categories: [...counts.keys()], expected: args.expected };
        }
        return { kind: 'gof', observed: args.observed || [], categories: args.categories, expected: args.expected };
      }
      if (table) { const { m, rl, cl } = crosstab(table, args.row_column, args.col_column); return { kind: 'table', m, rl, cl }; }
      return { kind: 'table', m: args.table || [], rl: args.row_labels, cl: args.col_labels };
    }
    case 'binomial_test': return { kind: 'proportion', k: args.successes, n: args.trials, p0: args.p0 };
    case 'correlation': {
      if (table) { const [x, y] = pairedColumns(table, args.x_column, args.y_column); return { kind: 'pairs', samples: [S(args.x_column, x), S(args.y_column, y)] }; }
      return { kind: 'pairs', samples: [S(args.x_name || 'x', args.x || []), S(args.y_name || 'y', args.y || [])] };
    }
    default: throw new UserError(`Unknown test ${test}`);
  }
}

/** Columns the plan uses (for the missing-values check), in a fixed order. */
function usedColumns(args, headers) {
  return Object.entries(args).filter(([k]) => NUMERIC_ROLES.includes(k) || CATEGORY_ROLES.includes(k)).map(([, v]) => v).concat(args.outcome_columns || []).filter((c) => headers.includes(c));
}

const toUser = (e) => (e instanceof UserError ? e : new UserError(e?.message || String(e)));

/**
 * extractData() for a large (streamed) file. Samples carry their values when small enough (then
 * every step is identical to the in-memory path) and otherwise a one-pass summary in `stats`.
 * The missing-value counts for step 2 are read in the same pass.
 */
async function extractBig(test, args, path) {
  const table = await openTable(path);
  const missing = { type: 'missing', cols: usedColumns(args, table.headers) };
  const one = async (spec) => { try { return (await accumulate(path, [spec], { prefetch: [missing] })).states[0]; } catch (e) { throw toUser(e); } };
  const S = (name, st) => ({ name, values: st.exact || null, stats: st });
  switch (test) {
    case 't_test': {
      if (args.type === 'one_sample') { const st = await one({ type: 'num', col: args.column }); BIG.checkBad(st); return { kind: 'numeric', samples: [S(args.column, st.s)] }; }
      if (args.type === 'paired') {
        const st = await one({ type: 'pair', x: args.column, y: args.column2 }); BIG.checkBad(st);
        const exact = st.x.exact && st.y.exact;
        return { kind: 'paired', samples: [S(args.column, exact ? st.x : { ...st.x, exact: null }), S(args.column2, exact ? st.y : { ...st.y, exact: null })], diff: st.d };
      }
      if (args.group_column) {
        const st = await one({ type: 'grouped', col: args.column, by: args.group_column }); BIG.checkBad(st);
        const g = st.groups;
        const keys = [args.group1, args.group2].filter(Boolean).map(String);
        const use = keys.length === 2 ? keys : [...g.keys()];
        if (use.length !== 2) throw new UserError(`Pick two groups (group1, group2) from ${args.group_column}: ${[...g.keys()].join(', ')}`);
        for (const k of use) if (!g.has(k)) throw new UserError(`Group "${k}" not found in ${args.group_column}. Groups: ${[...g.keys()].join(', ')}`);
        return { kind: 'numeric', samples: use.map((k) => S(k, g.get(k))) };
      }
      const a = await one({ type: 'num', col: args.column }), b = await one({ type: 'num', col: args.column2 });
      BIG.checkBad(a); BIG.checkBad(b);
      return { kind: 'numeric', samples: [S(args.column, a.s), S(args.column2, b.s)] };
    }
    case 'anova': {
      const st = await one({ type: 'grouped', col: args.column, by: args.group_column }); BIG.checkBad(st);
      const keys = args.groups_to_include?.length ? args.groups_to_include.map(String) : [...st.groups.keys()];
      for (const k of keys) if (!st.groups.has(k)) throw new UserError(`Group "${k}" not found in ${args.group_column}.`);
      return { kind: 'numeric', samples: keys.map((k) => S(k, st.groups.get(k))) };
    }
    case 'ancova': case 'manova': {
      const outs = test === 'ancova' ? [args.outcome_column] : args.outcome_columns;
      const nums = test === 'ancova' ? [args.outcome_column, args.covariate_column] : outs;
      for (const c of [args.group_column, ...nums]) if (!table.headers.includes(c)) throw new UserError(`No column named "${c}". Columns: ${table.headers.join(', ')}`);
      const { st } = await BIG.groupedMultiOf(path, args.group_column, nums, [missing]).catch((e) => { throw toUser(e); });
      const groups = [...st.groups.keys()];
      if (st.rows) {
        const rows = st.rows.map(([g, ...xs]) => Object.fromEntries([[args.group_column, g], ...nums.map((c, i) => [c, xs[i]])]));
        return { kind: test, rows, groups, outs, groupCol: args.group_column, covariate: args.covariate_column };
      }
      return { kind: test, rows: null, multi: st, nums, groups, outs, groupCol: args.group_column, covariate: args.covariate_column };
    }
    case 'chi_square': case 'fisher_exact': {
      if (args.type === 'goodness_of_fit') {
        const { counts } = await BIG.countsOf(path, args.column, [missing]);
        return { kind: 'gof', observed: [...counts.values()], categories: [...counts.keys()], expected: args.expected };
      }
      const { m, rl, cl } = await BIG.crosstabOf(path, args.row_column, args.col_column, [missing]);
      return { kind: 'table', m, rl, cl };
    }
    case 'correlation': {
      const st = await one({ type: 'pair', x: args.x_column, y: args.y_column }); BIG.checkBad(st);
      const exact = st.x.exact && st.y.exact;
      return { kind: 'pairs', samples: [S(args.x_column, exact ? st.x : { ...st.x, exact: null }), S(args.y_column, exact ? st.y : { ...st.y, exact: null })] };
    }
    default: return extractData(test, { ...args, file: undefined });
  }
}

// Sample accessors that work for both value arrays and one-pass summaries.
const nOf = (s) => (s.values ? s.values.length : s.stats.n);
const varOf = (s) => (s.values ? variance(s.values) : sVar(s.stats));
const summOf = (s) => (s.values ? summarize(s.values) : sSummarize(s.stats));
const outZOf = (s) => (s.values ? outliersZ(s.values) : sOutliersZ(s.stats));

/** Samples for each outcome within each group (ANCOVA / MANOVA), from rows or from summaries. */
function groupSamples(d) {
  if (d.rows) return d.outs.flatMap((o) => d.groups.map((g) => ({ name: `${o} in ${g}`, values: d.rows.filter((r) => r[d.groupCol] === g).map((r) => r[o]) })));
  return d.outs.flatMap((o) => d.groups.map((g) => { const G = d.multi.groups.get(g); const S = G.each[d.nums.indexOf(o)]; return { name: `${o} in ${g}`, values: S.exact || null, stats: S }; }));
}

const outliersZ = (v) => { const m = mean(v), s = stdDev(v); return s > 0 ? v.filter((x) => Math.abs(x - m) > 3 * s).length : 0; };
const outliersIQR = (v) => { const q1 = percentile(v, 0.25), q3 = percentile(v, 0.75), k = 1.5 * (q3 - q1); return v.filter((x) => x < q1 - k || x > q3 + k).length; };

// ------------------------------------------------------------------ step 2: check_assumptions

async function checkAssumptions(a, ctx) {
  const { session } = ctx;
  const an = session.requireStepsBefore(2);
  const { test, args } = an.plan;
  const d = await extractData(test, args);
  const checks = [];
  const add = (status, check, detail) => checks.push({ status, check, detail });
  const shape = (s) => {
    const n = nOf(s);
    if (n < 3 || varOf(s) === 0) { add('warning', `Shape of ${s.name}`, `Only ${n} value(s) or no variation; the shape cannot be judged.`); return; }
    const sum = summOf(s);
    const sk = sum.skewness, ek = sum.excess_kurtosis;
    const heavy = Math.abs(sk) > 1;
    add(heavy && n < 30 ? 'warning' : heavy ? 'info' : 'ok', `Shape of ${s.name}`,
      `n = ${n}; ${sum.shape ? sum.shape.label : 'shape not classified'} (skewness ${fmt(sk, 3)}${ek !== undefined ? `, excess kurtosis ${fmt(ek, 3)}` : ''}); mean ${fmt(sum.mean)} vs median ${fmt(sum.median)}${sum.approximate ? ' (median estimated)' : ''}.` +
      (heavy ? (n < 30 ? ' Heavy skew with a small sample can break the normality assumption; the median describes the centre better than the mean.' : ' Skewed, but with n ≥ 30 the mean-based test is usually robust (Central Limit Theorem).') : ''));
  };
  if (d.kind === 'numeric' || d.kind === 'paired' || d.kind === 'pairs') {
    for (const s of d.samples) shape(s);
    if (d.kind === 'paired') shape(d.samples[0].values ? { name: 'the paired differences', values: d.samples[0].values.map((x, i) => x - d.samples[1].values[i]) } : { name: 'the paired differences', values: null, stats: d.diff });
    if (d.kind === 'numeric' && d.samples.length > 1) {
      const ns = d.samples.map(nOf);
      if (Math.max(...ns) > 2 * Math.min(...ns)) add('info', 'Group sizes', `Unbalanced groups (${d.samples.map((s) => `${s.name}: ${nOf(s)}`).join(', ')}). Fine for Welch's t-test; ANOVA is more sensitive to unequal variances when sizes differ.`);
      else add('ok', 'Group sizes', d.samples.map((s) => `${s.name}: ${nOf(s)}`).join(', '));
    }
    if (d.kind === 'pairs') {
      const out = d.samples.map((s) => `${s.name}: ${outZOf(s)}`).join(', ');
      const anyOut = d.samples.some((s) => outZOf(s) > 0);
      add(anyOut ? 'warning' : 'ok', 'Outliers (beyond 3 SD)', `${out}.${anyOut && args.method !== 'spearman' ? ' Pearson\'s r is sensitive to outliers; Spearman (rank) correlation is the robust alternative.' : ''}`);
    }
  } else if ((d.kind === 'ancova' || d.kind === 'manova') && !d.rows) {
    // Large file: per-group summaries.
    for (const s of groupSamples(d)) shape(s);
    if (d.kind === 'ancova') {
      const y = args.outcome_column, x = d.covariate;
      let sseSep = 0, sxxW = 0, sxyW = 0, syyW = 0, N = 0;
      for (const g of d.groups) {
        const G = d.multi.groups.get(g);
        const syy = G.C[0][0], sxx = G.C[1][1], sxy = G.C[0][1];
        sseSep += sxx > 0 ? syy - (sxy * sxy) / sxx : syy;
        sxxW += sxx; sxyW += sxy; syyW += syy; N += G.n;
      }
      const sseCommon = syyW - (sxyW * sxyW) / sxxW;
      const k = d.groups.length, df2 = N - 2 * k;
      if (df2 > 0 && sseSep > 0) {
        const F = ((sseCommon - sseSep) / (k - 1)) / (sseSep / df2);
        const p = fPValue(F, k - 1, df2);
        add(p < 0.05 ? 'warning' : 'ok', 'Equal covariate slopes (group × covariate interaction)',
          `F(${k - 1}, ${df2}) = ${fmt(F)}, ${formatPEq(p)}. ${p < 0.05 ? `The effect of ${x} on ${y} differs between groups, so ANCOVA's adjusted comparison is not trustworthy. Consider analysing groups separately or modelling the interaction.` : 'No evidence the slopes differ; the ANCOVA assumption holds.'}`);
        checks[checks.length - 1].stats = { F, df1: k - 1, df2, p_value: p };
      }
    } else {
      const small = d.groups.filter((g) => d.multi.groups.get(g).n <= d.outs.length);
      add(small.length ? 'warning' : 'ok', 'Group size vs number of outcomes', small.length ? `Groups ${small.join(', ')} have no more rows than outcomes (${d.outs.length}); MANOVA needs more.` : `Every group has more rows than outcomes (${d.outs.length}).`);
    }
  } else if (d.kind === 'ancova' || d.kind === 'manova') {
    for (const o of d.outs) for (const g of d.groups) shape({ name: `${o} in ${g}`, values: d.rows.filter((r) => r[d.groupCol] === g).map((r) => r[o]) });
    if (d.kind === 'ancova') {
      // Homogeneity of regression slopes: does the covariate's slope differ between groups?
      const y = args.outcome_column, x = d.covariate;
      let sseSep = 0, sxxW = 0, sxyW = 0, syyW = 0;
      for (const g of d.groups) {
        const rs = d.rows.filter((r) => r[d.groupCol] === g);
        const mx = mean(rs.map((r) => r[x])), my = mean(rs.map((r) => r[y]));
        let sxx = 0, sxy = 0, syy = 0;
        for (const r of rs) { sxx += (r[x] - mx) ** 2; sxy += (r[x] - mx) * (r[y] - my); syy += (r[y] - my) ** 2; }
        sseSep += sxx > 0 ? syy - (sxy * sxy) / sxx : syy;
        sxxW += sxx; sxyW += sxy; syyW += syy;
      }
      const sseCommon = syyW - (sxyW * sxyW) / sxxW;
      const k = d.groups.length, N = d.rows.length, df2 = N - 2 * k;
      if (df2 > 0 && sseSep > 0) {
        const F = ((sseCommon - sseSep) / (k - 1)) / (sseSep / df2);
        const p = fPValue(F, k - 1, df2);
        add(p < 0.05 ? 'warning' : 'ok', 'Equal covariate slopes (group × covariate interaction)',
          `F(${k - 1}, ${df2}) = ${fmt(F)}, ${formatPEq(p)}. ${p < 0.05 ? `The effect of ${x} on ${y} differs between groups, so ANCOVA's adjusted comparison is not trustworthy. Consider analysing groups separately or modelling the interaction.` : 'No evidence the slopes differ; the ANCOVA assumption holds.'}`);
        checks[checks.length - 1].stats = { F, df1: k - 1, df2, p_value: p };
      }
    } else {
      const small = d.groups.filter((g) => d.rows.filter((r) => r[d.groupCol] === g).length <= d.outs.length);
      add(small.length ? 'warning' : 'ok', 'Group size vs number of outcomes', small.length ? `Groups ${small.join(', ')} have no more rows than outcomes (${d.outs.length}); MANOVA needs more.` : `Every group has more rows than outcomes (${d.outs.length}).`);
    }
  } else if (d.kind === 'table' || d.kind === 'gof') {
    let exp;
    if (d.kind === 'table') {
      const rt = d.m.map((r) => r.reduce((s, v) => s + v, 0)), ct = d.m[0].map((_, j) => d.m.reduce((s, r) => s + r[j], 0)), N = rt.reduce((s, v) => s + v, 0);
      exp = d.m.flatMap((r, i) => r.map((_, j) => (rt[i] * ct[j]) / N));
    } else {
      const tot = d.observed.reduce((s, v) => s + v, 0);
      const e = d.expected?.length ? d.expected : d.observed.map(() => 1);
      const es = e.reduce((s, v) => s + v, 0);
      exp = e.map((v) => (v / es) * tot);
    }
    const small = exp.filter((e) => e < 5).length;
    if (test === 'fisher_exact') add('ok', 'Expected counts', "Fisher's exact test is valid for any counts, including small ones.");
    else add(small / exp.length > 0.2 || exp.some((e) => e < 1) ? 'warning' : 'ok', 'Expected counts', `${small} of ${exp.length} expected counts are below 5 (smallest ${fmt(Math.min(...exp), 3)}).${small ? (exp.length === 4 ? " Use Fisher's exact test instead (revise step 1)." : ' Combine sparse categories (revise step 1).') : ''}`);
  } else if (d.kind === 'proportion') {
    if (test === 'z_test' && (d.n * d.p0 < 10 || d.n * (1 - d.p0) < 10)) add('warning', 'Normal approximation', `n·p₀ = ${fmt(d.n * d.p0, 3)} and n·(1−p₀) = ${fmt(d.n * (1 - d.p0), 3)}; below 10 the z-test is rough. The exact binomial test is the safer choice (revise step 1).`);
    else add('ok', 'Sample size', `${d.k} successes out of ${d.n} trials.`);
  } else if (d.kind === 'summary') {
    add('info', 'Data', 'Only summary numbers (mean, n) were given, so the shape of the data cannot be checked. The z-test assumes σ is truly known.');
  }
  add('question', 'Who is missing from the sample?', 'Ask the user how the data were collected. A biased sample (self-selection, survivors only, one site or time period) invalidates every number downstream, and no statistic can detect it.');
  if (an.plan.file) {
    const big = await largeFilePath(an.plan.file);
    let miss;
    if (big) {
      const table = await openTable(big);
      const cols = usedColumns(args, table.headers);
      const { states: [st] } = await accumulate(big, [{ type: 'missing', cols }]).catch((e) => { throw toUser(e); });
      miss = cols.map((c, i) => [c, st.miss[i]]).filter(([, m]) => m > 0);
    } else {
      const table = await loadTable(an.plan.file);
      const used = Object.entries(args).filter(([k]) => NUMERIC_ROLES.includes(k) || CATEGORY_ROLES.includes(k)).map(([, v]) => v).concat(args.outcome_columns || []);
      miss = used.filter((c) => table.headers.includes(c)).map((c) => [c, missingCount(table, c)]).filter(([, m]) => m > 0);
    }
    add(miss.length ? 'info' : 'ok', 'Missing values', miss.length ? `${miss.map(([c, m]) => `${c}: ${m}`).join(', ')} missing; those rows are left out. If missingness is related to the outcome, results can be biased.` : 'No missing values in the columns used.');
  }
  const warnings = checks.filter((c) => c.status === 'warning').length;
  const step = STEPS[1];
  const r = session.addResult({ kind: 'assumptions', title: 'Assumption checks', data: { checks }, summary: [] });
  session.completeStep(2, { note: warnings ? `${warnings} warning(s)` : 'assumptions look reasonable', resultId: r.id });
  return {
    data: { step: 2, checks, result_id: r.id },
    summary: [
      `Step 2: ${step.title}`,
      ...checks.map((c) => `  [${c.status}] ${c.check}: ${c.detail}`),
      warnings ? 'Some assumptions look doubtful. Switching tests (or transforming) now is a principled revision: call state_hypotheses again with the better test, then repeat this step.' : 'Assumptions look reasonable for this test.',
      'Next: step 3, check_spread.',
    ],
  };
}

// ------------------------------------------------------------------ step 3: check_spread

async function checkSpread(a, ctx) {
  const { session } = ctx;
  const an = session.requireStepsBefore(3);
  const { test, args } = an.plan;
  const d = await extractData(test, args);
  let samples = [];
  if (['numeric', 'paired', 'pairs'].includes(d.kind)) samples = d.samples;
  else if (d.kind === 'ancova' || d.kind === 'manova') samples = groupSamples(d);
  const rows = samples.filter((s) => nOf(s) >= 2).map((s) => {
    if (!s.values) {
      const S = s.stats, m = sMean(S), sd = sSd(S), q1 = sQuantile(S, 0.25), q3 = sQuantile(S, 0.75);
      return { name: s.name, n: S.n, mean: m, std_dev: sd, iqr: q3 - q1, coefficient_of_variation: m !== 0 ? sd / Math.abs(m) : null, min: S.min, max: S.max, outliers_1_5_iqr: sOutliersIQR(S), approximate: ['iqr', 'outliers_1_5_iqr'] };
    }
    const v = s.values, m = mean(v), sd = stdDev(v), q1 = percentile(v, 0.25), q3 = percentile(v, 0.75);
    return { name: s.name, n: v.length, mean: m, std_dev: sd, iqr: q3 - q1, coefficient_of_variation: m !== 0 ? sd / Math.abs(m) : null, min: v.reduce((x, y) => (y < x ? y : x), Infinity), max: v.reduce((x, y) => (y > x ? y : x), -Infinity), outliers_1_5_iqr: outliersIQR(v) };
  });
  const lines = rows.map((r) => `  ${r.name}: SD ${fmt(r.std_dev)}, IQR ${fmt(r.iqr)}${r.approximate ? ' (estimated)' : ''}, range ${fmt(r.min)} to ${fmt(r.max)}${r.coefficient_of_variation !== null ? `, CV ${fmt(r.coefficient_of_variation * 100, 3)}%` : ''}${r.outliers_1_5_iqr ? `, ${r.outliers_1_5_iqr} outlier(s) beyond 1.5×IQR` : ''}`);
  const notes = [];
  if (rows.length >= 2 && (d.kind === 'numeric' || d.kind === 'ancova')) {
    const vars = rows.map((r) => r.std_dev ** 2).filter((v) => v > 0);
    const ratio = Math.max(...vars) / Math.min(...vars);
    notes.push(ratio > 4 ? `Largest/smallest variance ratio ${fmt(ratio, 3)}: spreads differ a lot.${test === 't_test' ? (args.equal_variances ? " Welch's t-test (equal_variances: false) is safer; revise step 1." : " Welch's t-test (the default) already allows this.") : test === 'anova' ? ' ANOVA assumes similar spreads; treat a borderline p-value with caution and look at the pairwise Welch comparisons.' : ''}` : `Variance ratio ${fmt(ratio, 3)}: spreads are comparable.`);
  }
  if (rows.some((r) => r.outliers_1_5_iqr)) notes.push('Check the outliers before going further: a data-entry error, a tracking glitch or a real extreme? Do not delete them just to get a result.');
  if (!rows.length) notes.push('This test works on counts, so there is no spread to check. Step 3 is satisfied by looking at the counts in step 2.');
  const r = session.addResult({ kind: 'spread', title: 'Spread check', data: { spread: rows, notes }, summary: [] });
  session.completeStep(3, { note: rows.length ? `${rows.length} sample(s) checked` : 'counts only', resultId: r.id });
  return { data: { step: 3, spread: rows, notes, result_id: r.id }, summary: [`Step 3: ${STEPS[2].title}`, ...lines, ...notes.map((n) => `  ${n}`), 'Next: step 4, power_analysis (ask the user for the smallest effect that would matter to them).'] };
}

// ------------------------------------------------------------------ step 4: power_analysis (guided)

function powerNormal(ncp, alpha, twoSided) {
  const z = inverseNormalCDF(1 - (twoSided ? alpha / 2 : alpha));
  const p = twoSided ? 1 - normalCDF(z - ncp) + normalCDF(-z - ncp) : 1 - normalCDF(z - Math.abs(ncp));
  return Math.max(0, Math.min(1, p));
}

async function guidedPower(a, ctx) {
  const { session } = ctx;
  if (!session.current || session.current.mode === 'explore') {
    session.requireAnalysis();
    const res = await IMPL.powerAnalysis(a);
    const r = session.addResult({ kind: 'power', title: 'Power analysis (planning)', data: res.data, summary: res.summary });
    return { ...res, data: { ...res.data, result_id: r.id } };
  }
  const an = session.requireStepsBefore(4);
  const { test, args, alpha, alternative } = an.plan;
  const twoSided = alternative === 'two-sided';
  const target = a.power ?? 0.8;
  const d = await extractData(test, args);
  let es = a.smallest_effect;
  const conventional = { means: 0.5, r: 0.3, h: 0.5 };
  let family, n, unit;
  if (test === 't_test' || (test === 'z_test' && d.kind !== 'proportion') || test === 'anova') { family = 'means'; unit = "Cohen's d"; }
  else if (test === 'correlation') { family = 'r'; unit = 'correlation r'; }
  else if (test === 'binomial_test' || (test === 'z_test' && d.kind === 'proportion')) { family = 'h'; unit = 'true proportion p₁'; }
  else {
    session.completeStep(4, { note: `power not computed for the ${an.plan.label}` });
    return { data: { step: 4, status: 'done', computed: false }, summary: [`Step 4: ${STEPS[3].title}`, `Stats Explorer does not compute power for the ${an.plan.label}. Tell the user that a non-significant result will be hard to interpret if the groups or cells are small, and judge whether the sample is large enough for the effect they care about.`, 'Next: step 5, run_test.'] };
  }
  if (es == null) {
    if (!a.use_conventional) {
      return { data: { step: 4, status: 'needs_input', effect_unit: unit }, summary: [`Step 4 needs one number from the user: the smallest effect that would matter to them, as ${unit}${family === 'h' ? ` (the true rate that would be worth detecting, compared with p₀ = ${d.p0})` : ''}.`, `Ask them. If they don't know, call power_analysis again with use_conventional: true (uses a conventional "medium" effect${family === 'h' ? ', Cohen\'s h = 0.5' : `, ${unit} = ${conventional[family]}`}) and say so in the report.`] };
    }
    es = family === 'h' ? null : conventional[family];
  }
  let power, needed, perGroup = false, ncpUnit, basis = null;
  if (family === 'means') {
    if (test === 't_test' && args.type === 'independent' || test === 'anova') {
      const ns = d.samples.map(nOf).sort((x, y) => x - y);
      const [n1, n2] = test === 'anova' ? [ns[0], ns[1]] : ns;
      n = Math.round((2 * n1 * n2) / (n1 + n2)); perGroup = true;
      power = powerNormal(es / Math.sqrt(1 / n1 + 1 / n2), alpha, twoSided);
      needed = 2; while (powerNormal(es * Math.sqrt(needed / 2), alpha, twoSided) < target && needed < 1e7) needed++;
      ncpUnit = 'per group';
      if (test === 'anova') basis = 'based on the two smallest groups, as a pairwise comparison within the ANOVA';
    } else {
      n = d.kind === 'summary' ? d.n : nOf(d.samples[0]);
      power = powerNormal(es * Math.sqrt(n), alpha, twoSided);
      needed = 2; while (powerNormal(es * Math.sqrt(needed), alpha, twoSided) < target && needed < 1e7) needed++;
      ncpUnit = args.type === 'paired' ? 'pairs' : 'observations';
    }
  } else if (family === 'r') {
    n = nOf(d.samples[0]);
    const zr = Math.atanh(Math.abs(es));
    power = powerNormal(zr * Math.sqrt(n - 3), alpha, twoSided);
    needed = 4; while (powerNormal(zr * Math.sqrt(needed - 3), alpha, twoSided) < target && needed < 1e7) needed++;
    ncpUnit = 'pairs';
  } else {
    n = d.n;
    const p1 = es ?? null;
    const h = p1 == null ? 0.5 : 2 * Math.asin(Math.sqrt(p1)) - 2 * Math.asin(Math.sqrt(d.p0));
    if (!h) throw new UserError('smallest_effect must be a proportion different from p₀.');
    power = powerNormal(Math.abs(h) * Math.sqrt(n), alpha, twoSided);
    needed = 2; while (powerNormal(Math.abs(h) * Math.sqrt(needed), alpha, twoSided) < target && needed < 1e7) needed++;
    ncpUnit = 'trials';
    es = p1 == null ? 'h = 0.5' : p1;
  }
  const low = power < target;
  const r = session.addResult({ kind: 'power_step', title: 'Power check', data: { effect: es, unit, n, power, target, needed, n_unit: ncpUnit, basis, conventional: a.smallest_effect == null }, summary: [] });
  session.completeStep(4, { note: `power ${fmt(power, 3)} for ${unit} ${es}`, resultId: r.id });
  return {
    data: { step: 4, smallest_effect: es, effect_unit: unit, n, power, target_power: target, n_needed: needed, n_unit: ncpUnit, method: 'normal approximation', result_id: r.id },
    summary: [
      `Step 4: ${STEPS[3].title}`,
      `With ${n} ${ncpUnit}${perGroup && test === 't_test' ? ' (harmonic mean of the two groups)' : ''}, power to detect ${unit} = ${es}${a.smallest_effect == null ? ' (conventional medium effect, not the user\'s own threshold)' : ''} is ${fmt(power, 3)}.`,
      `For ${target} power you would need about ${needed} ${ncpUnit}${basis ? ` (${basis})` : ''}.`,
      low ? `Power is below ${target}: if the test comes back non-significant, that result is uninformative, not reassuring. Say this when reporting.` : 'The sample is large enough to detect that effect most of the time.',
      'Normal approximation (typically within about 0.01 of exact power).',
      'Next: step 5, run_test.',
    ],
  };
}

// ------------------------------------------------------------------ step 5: run_test

async function runTest(a, ctx) {
  const { session } = ctx;
  const an = session.requireStepsBefore(5);
  const { test, args, h0, h1, label } = an.plan;
  const res = await TESTS[test].impl({ ...args });
  const v = res.data.significant;
  const verdict = res.data.p_value == null ? null : v ? 'Reject H₀' : 'Fail to reject H₀';
  const r = session.addResult({ kind: 'hypothesis_test', title: `${res.data.test}`, data: { ...res.data, h0, h1, verdict, question: an.question }, summary: res.summary, selection: args });
  session.completeStep(5, { note: `${verdict}, ${formatPEq(res.data.p_value)}`, resultId: r.id });
  return {
    data: { step: 5, ...res.data, h0, h1, verdict, result_id: r.id },
    summary: [
      `Step 5: ${STEPS[4].title}`,
      `H₀: ${h0}`, `H₁: ${h1}`,
      ...res.summary,
      ...(res.data.warnings?.length ? ['Warnings:', ...res.data.warnings.map((w) => `- ${w}`)] : []),
      'Report honestly: give the p-value together with the effect size and the confidence interval. A significant result can be too small to act on, and a correlation or difference in observational data does not prove cause.',
      (() => { const pw = session.results.find((x) => x.id === an.steps[3].resultId); return pw && pw.data.power < pw.data.target && !v ? 'Power was low (step 4), so this non-significant result does not show there is no effect.' : null; })(),
      `Next: step 6, base_rate_check if this is about detecting a rare event (fraud, defects, a diagnosis, churn); otherwise skip_step 6 with that reason.`,
    ].filter(Boolean),
  };
}

// ------------------------------------------------------------------ step 6: base_rate_check

async function baseRateCheck(a, ctx) {
  const { session } = ctx;
  const inWorkflow = session.current?.mode === 'hypothesis_test';
  if (inWorkflow) session.requireStepsBefore(6); else session.requireAnalysis();
  let prev = a.prevalence, sens = a.sensitivity, spec = a.specificity, source = 'given rates';
  if (a.file) {
    if (!a.condition_column || !a.test_column) throw new UserError('From a file, give condition_column (1 = really positive) and test_column (1 = flagged positive), both 0/1.');
    const table = await openTable(a.file);
    const c = await confirmSelection(ctx, {
      kind: 'base_rate', intro: `Base-rate check on ${table.path}.`,
      fields: [columnField(table, 'condition_column', a.condition_column, true), columnField(table, 'test_column', a.test_column, true)].map((f) => ({ ...f, title: f.key === 'condition_column' ? 'Actual condition (0/1)' : 'Test / prediction (0/1)' })),
      token: a.confirmation_token,
    });
    if (!c.ok) return c.result;
    requireColumn(table, c.values.condition_column); requireColumn(table, c.values.test_column);
    if (table.big) {
      const { c: k } = await BIG.baseRateCounts(table.path, c.values.condition_column, c.values.test_column).catch((e) => { throw toUser(e); });
      const [tn, fp, fn, tp] = [k[0], k[1], k[2], k[3]], total = tn + fp + fn + tp;
      if (total === 0) throw new UserError('No rows where both columns are 0 or 1.');
      prev = (fn + tp) / total;
      sens = fn + tp ? tp / (fn + tp) : NaN;
      spec = tn + fp ? tn / (tn + fp) : NaN;
      source = `${total} rows of ${c.values.condition_column} vs ${c.values.test_column}`;
    } else {
    const rows = table.rowsOf([c.values.condition_column, c.values.test_column]).filter((r) => [0, 1].includes(r[c.values.condition_column]) && [0, 1].includes(r[c.values.test_column]));
    if (rows.length === 0) throw new UserError('No rows where both columns are 0 or 1.');
    const pos = rows.filter((r) => r[c.values.condition_column] === 1);
    const neg = rows.filter((r) => r[c.values.condition_column] === 0);
    prev = pos.length / rows.length;
    sens = pos.length ? pos.filter((r) => r[c.values.test_column] === 1).length / pos.length : NaN;
    spec = neg.length ? neg.filter((r) => r[c.values.test_column] === 0).length / neg.length : NaN;
    source = `${rows.length} rows of ${c.values.condition_column} vs ${c.values.test_column}`;
    }
  }
  for (const [n, v] of [['prevalence', prev], ['sensitivity', sens], ['specificity', spec]]) {
    if (!(v >= 0 && v <= 1)) throw new UserError(`${n} must be between 0 and 1 (got ${v}).`);
  }
  const tp = sens * prev, fp = (1 - spec) * (1 - prev), fn = (1 - sens) * prev, tn = spec * (1 - prev);
  const ppv = tp + fp > 0 ? tp / (tp + fp) : NaN, npv = tn + fn > 0 ? tn / (tn + fn) : NaN;
  const per = (x) => Math.round(x * 10000);
  const data = { prevalence: prev, sensitivity: sens, specificity: spec, ppv, npv, per_10000: { true_positive: per(tp), false_positive: per(fp), false_negative: per(fn), true_negative: per(tn) }, source };
  const r = session.addResult({ kind: inWorkflow ? 'base_rate_step' : 'base_rate', title: 'Base-rate check', data, summary: [] });
  if (inWorkflow) session.completeStep(6, { note: `PPV ${fmt(ppv * 100, 3)}%`, resultId: r.id });
  return {
    data: { ...(inWorkflow ? { step: 6 } : {}), ...data, result_id: r.id },
    summary: [
      ...(inWorkflow ? [`Step 6: ${STEPS[5].title}`] : ['Base-rate check']),
      `Prevalence ${fmt(prev * 100, 3)}%, sensitivity ${fmt(sens * 100, 3)}%, specificity ${fmt(spec * 100, 3)}% (${source}).`,
      `Of everything flagged positive, ${fmt(ppv * 100, 3)}% is really positive (PPV); ${fmt(npv * 100, 3)}% of negatives are really negative (NPV).`,
      `Per 10,000 cases: ${per(tp)} true alarms, ${per(fp)} false alarms, ${per(fn)} missed.`,
      ppv < 0.5 ? 'Most alarms are false: accuracy alone overstates how useful this is when the event is rare.' : '',
      ...(inWorkflow ? ['All six steps are done. If the user wants a report, call build_report.'] : []),
    ].filter(Boolean),
  };
}

async function skipStep(a, { session }) {
  const an = session.requireAnalysis('hypothesis_test');
  const def = STEPS[a.step - 1];
  if (!def.skippable) throw new UserError(`Step ${a.step} ("${def.title}") cannot be skipped.`);
  session.requireStepsBefore(a.step);
  if (!a.reason || a.reason.trim().length < 5) throw new UserError('Give the reason for skipping in a short sentence; it is shown in the report.');
  session.completeStep(a.step, { status: 'skipped', note: a.reason.trim() });
  const next = an.steps.find((s) => s.status === 'pending');
  return { data: { step: a.step, status: 'skipped', reason: a.reason }, summary: [`Step ${a.step} skipped: ${a.reason.trim()}`, next ? `Next: step ${next.number}, ${STEPS[next.number - 1].tool}.` : 'All six steps are done. If the user wants a report, call build_report.'] };
}

async function workflowStatus(a, { session }) {
  return { data: { analysis: session.current, results: session.results.map((r) => ({ id: r.id, analysis: r.analysisId, kind: r.kind, title: r.title })) }, summary: [session.statusText()] };
}

// ------------------------------------------------------------------ exploration tools with confirmation

async function confirmColumns(ctx, kind, a, intro, extraFields = []) {
  if (!a.file) return { ok: true, values: {} };
  const table = await openTable(a.file);
  const fields = [...selectionFields(table, a), ...extraFields];
  if (!fields.length) return { ok: true, values: {} };
  return confirmSelection(ctx, { kind: `${kind}:${table.path}`, intro: intro(table), fields, token: a.confirmation_token });
}

function guidedExplore(name, impl, makeIntro, { extra = () => [], descriptiveOnly = false } = {}) {
  return async (a, ctx) => {
    const { session } = ctx;
    session.requireAnalysis();
    const args = { ...a };
    if (args.group_column === '' || args.group_column === '(none)') delete args.group_column;
    const c = await confirmColumns(ctx, name, args, makeIntro, extra(args));
    if (!c.ok) return c.result;
    Object.assign(args, c.values);
    delete args.confirmation_token;
    const res = await impl({ ...args, ...(descriptiveOnly ? { descriptive_only: true } : {}) });
    const title = name === 'describe' ? `Descriptive statistics${args.column ? `: ${args.column}${args.group_column ? ` by ${args.group_column}` : ''}` : ''}`
      : name === 'confidence_interval' ? `Confidence interval${args.column ? `: ${args.column}` : ''}`
        : `Correlation${args.x_column ? `: ${args.x_column} vs ${args.y_column}` : ''}`;
    const r = session.addResult({ kind: name, title, data: res.data, summary: res.summary, selection: args });
    return { ...res, data: { ...res.data, result_id: r.id }, summary: [...res.summary, `(Saved as ${r.id} for the report.)`] };
  };
}

// ------------------------------------------------------------------ tool table

const testNames = Object.keys(TESTS);

export function guidedTools({ create_visualization, build_report }) {
  const describeSchema = { ...classic.describe.inputSchema, confirmation_token: token };
  const ciSchema = { ...classic.confidence_interval.inputSchema, confirmation_token: token };
  const corrSchema = { ...classic.correlation.inputSchema };
  delete corrSchema.alternative; delete corrSchema.alpha;
  corrSchema.confirmation_token = token;
  return [
    {
      name: 'start_analysis', title: 'Start an analysis',
      description: 'Call this first for every new question. Read the user\'s request and choose mode: "hypothesis_test" when they want to know whether a difference, effect or relationship is real / significant / caused by something, or want to test a claim; "explore" when they want to describe, summarise, visualise, estimate or plan, without testing a claim. If the request is ambiguous, ask the user before calling. Returns the steps to follow.',
      inputSchema: {
        question: z.string().min(3).describe("The user's request, in their own words."),
        mode: z.enum(MODES),
        file: z.string().optional().describe('The data file the user named or attached to the chat (CSV, TSV, Excel or Parquet): pass its path or name, never its contents. Large files are fine.'),
      },
      annotations: { title: 'Start an analysis', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      run: startAnalysis,
    },
    {
      name: 'state_hypotheses', title: 'Step 1: state the question, hypotheses and test',
      description: `Step 1 of a hypothesis test. Fix the test, the data selection and H₀/H₁ BEFORE looking at results. test_arguments are the same fields the test takes (e.g. t_test: {type, file, column, group_column, group1, group2, equal_variances, mu0}; anova: {file, column, group_column}; chi_square: {type, file, row_column, col_column}; correlation: {file, x_column, y_column, method}). Only use columns the user asked about. The user confirms every column/group choice, the direction and α. Calling it again later revises the plan and restarts steps 2–6.`,
      inputSchema: {
        test: z.enum(testNames),
        test_arguments: z.record(z.string(), z.any()).describe('Fields for the chosen test (file, columns, groups, type, method, ...). Not alpha/alternative.'),
        h0: z.string().optional().describe("Null hypothesis in plain words (a sensible default is proposed if omitted)."),
        h1: z.string().optional(),
        alternative: z.enum(['two-sided', 'greater', 'less']).default('two-sided').describe('Decide from the question, never from the data.'),
        alpha: z.number().gt(0).lt(1).default(0.05),
        confidence: z.number().gt(0).lt(1).default(0.95),
        confirmation_token: token,
      },
      annotations: { title: 'State hypotheses', ...RO },
      run: stateHypotheses,
    },
    { name: 'check_assumptions', title: "Step 2: validate the data against the test's assumptions", description: "Step 2. Checks shape (skew, kurtosis, small samples), group sizes, outliers, expected counts, ANCOVA slope equality and missing values for the test fixed in step 1. If an assumption fails, revising the test now (state_hypotheses again) is principled.", inputSchema: {}, annotations: { title: 'Check assumptions', ...RO }, run: checkAssumptions },
    { name: 'check_spread', title: 'Step 3: check spread', description: 'Step 3. Standard deviation, IQR, coefficient of variation, outliers and variance ratio for the data in the plan.', inputSchema: {}, annotations: { title: 'Check spread', ...RO }, run: checkSpread },
    {
      name: 'power_analysis', title: 'Step 4: calculate power / plan sample size',
      description: 'In a hypothesis test (step 4): power of the planned test for the smallest effect the user cares about, using the data\'s sample size. smallest_effect is Cohen\'s d for means, r for correlations, or the true proportion p₁ for proportion tests. Ask the user for it; if they don\'t know, pass use_conventional: true. In an exploration: give two of effect_size, n_per_group, power to plan a two-group study.',
      inputSchema: {
        smallest_effect: z.number().optional(), use_conventional: z.boolean().optional(), power: z.number().gt(0).lt(1).optional().describe('Target power (default 0.8 in a hypothesis test).'),
        effect_size: z.number().optional(), n_per_group: z.number().int().optional(),
        alpha: z.number().gt(0).lt(1).default(0.05), alternative: z.enum(['two-sided', 'one-sided']).default('two-sided'),
      },
      annotations: { title: 'Power analysis', ...RO },
      run: guidedPower,
    },
    { name: 'run_test', title: 'Step 5: run the test', description: 'Step 5. Runs exactly the test, columns and hypotheses the user confirmed in step 1 and returns the statistic, p-value, effect size, CI and verdict. Requires steps 1–4.', inputSchema: {}, annotations: { title: 'Run test', ...RO }, run: runTest },
    {
      name: 'base_rate_check', title: 'Step 6: sanity-check rare events against base rates',
      description: 'Step 6 (or standalone in an exploration). For rare-event questions (fraud, defects, diagnoses, churn): what share of positive flags is real (PPV). Give prevalence, sensitivity, specificity (0–1), or file + condition_column + test_column (0/1 columns). If the question is not about rare events, use skip_step 6 instead.',
      inputSchema: {
        prevalence: z.number().optional(), sensitivity: z.number().optional(), specificity: z.number().optional(),
        file: z.string().optional(), condition_column: z.string().optional(), test_column: z.string().optional(), confirmation_token: token,
      },
      annotations: { title: 'Base-rate check', ...RO },
      run: baseRateCheck,
    },
    {
      name: 'skip_step', title: 'Skip step 4 or 6 with a reason',
      description: 'Only steps 4 (power) and 6 (base rates) can be skipped, with a short reason that will appear in the report.',
      inputSchema: { step: z.union([z.literal(4), z.literal(6)]), reason: z.string() },
      annotations: { title: 'Skip step', ...RO },
      run: skipStep,
    },
    { name: 'workflow_status', title: 'Workflow status', description: 'Shows the current analysis, which of the six steps are done, and the saved results (for the report).', inputSchema: {}, annotations: { title: 'Workflow status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, run: workflowStatus },
    { ...classic.inspect_data_file, run: (a) => IMPL.inspectFile(a) },
    { ...classic.choose_test, run: (a) => IMPL.chooseTest(a) },
    {
      name: 'describe', title: 'Descriptive statistics',
      description: 'n, mean, SD, median, quartiles, range, skewness, kurtosis, shape and CI for the mean, for a column the user asked about (optionally by group). The user confirms the columns first.',
      inputSchema: describeSchema, annotations: { title: 'Describe', ...RO },
      run: guidedExplore('describe', IMPL.describe, (t) => `Descriptive statistics from ${t.path}.`),
    },
    {
      name: 'confidence_interval', title: 'Confidence interval',
      description: 'CI for a mean (column the user asked about) or a proportion. The user confirms the column first.',
      inputSchema: ciSchema, annotations: { title: 'Confidence interval', ...RO },
      run: guidedExplore('confidence_interval', IMPL.confidenceInterval, (t) => `Confidence interval from ${t.path}.`),
    },
    {
      name: 'correlation', title: 'Correlation (descriptive)',
      description: 'Strength and direction of the relationship between two numeric columns (r or ρ, CI, least-squares line), WITHOUT a p-value. To test whether a relationship is significant, use a hypothesis_test analysis with test "correlation". The user confirms the columns first.',
      inputSchema: corrSchema, annotations: { title: 'Correlation', ...RO },
      run: guidedExplore('correlation', IMPL.correlation, (t) => `Correlation from ${t.path}.`, { descriptiveOnly: true }),
    },
    create_visualization,
    build_report,
  ];
}
