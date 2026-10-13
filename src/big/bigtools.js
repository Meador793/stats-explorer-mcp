// Tool implementations for large files (streamed, see service.js).
//
// Every tool reads what it needs in one pass. When every sample involved is small enough to keep its
// actual values (acc.js EXACT_CAP), the values are handed to the normal in-memory implementation, so
// the output is identical. Otherwise the same output is computed from the one-pass summaries:
// counts, means, variances, sums of squares and cross-products are exact; medians, quartiles and the
// Spearman correlation are estimated (and say so).
import { IMPL, groupSummaryResult } from '../tools.js';
import { accumulate } from './service.js';
import { UserError } from '../errors.js';
import {
  sMedian,
  sMean, sVar, sSd, sSummarize, sNormalityWarnings, sCohensD, isExact,
} from './sumstats.js';
import {
  tPValue, magnitude, fmt, verdict, altPhrase, inverseTCDF, inverseNormalCDF, formatPEq, checkLevel,
} from '../stats.js';
import { fPValue } from '../engine/statsUtils.js';
import { hllEstimate } from './acc.js';
import { matrixDet } from '../engine/hypothesisTests.js';

const toUser = (e) => (e instanceof UserError ? e : new UserError(e?.message || String(e)));

async function acc(path, specs, prefetch = []) {
  try { return await accumulate(path, specs, { prefetch }); } catch (e) { throw toUser(e); }
}

export function checkBad(st) {
  if (st?.bad) throw new UserError(`Column "${st.badCol}" has ${st.bad} non-numeric value(s), e.g. "${st.firstBad}". Clean the column or pick a numeric one.`);
}

/** Adds what was read (rows, sampling, cache) to a result. */
export function withMeta(res, meta, { approximate = [] } = {}) {
  const info = { rows_read: meta.rows, from_cache: !!meta.fromCache, seconds: Math.round((meta.seconds || 0) * 10) / 10 };
  const notes = [];
  if (meta.sampled) {
    info.sampled_fraction = meta.sampled.fraction;
    notes.push(`Based on a sample of about ${Math.round(meta.sampled.fraction * 100)}% of the file (${meta.rows} rows, in blocks spread across it), not every row. For exact results, choose "full" with large_file_plan.`);
  }
  if (approximate.length) { info.approximate = approximate; notes.push(`Estimated from a quantile sketch or random sample (the file is too large to keep every value): ${approximate.join(', ')}. Everything else is exact.`); }
  const data = { ...res.data, large_file: info };
  if (notes.length) data.warnings = [...(res.data.warnings || []), ...notes];
  return { ...res, data };
}

const exact = (...S) => S.every(isExact);

// ------------------------------------------------------------------ t-test

export async function tTest(a, path) {
  if (!a.column) throw new UserError('column is required when reading from a file.');
  const type = a.type;
  const missing = { type: 'missing', cols: [a.column, a.column2, a.group_column].filter(Boolean) };
  if (type === 'one_sample') {
    const { states: [st], meta } = await acc(path, [{ type: 'num', col: a.column }], [missing]);
    checkBad(st);
    if (exact(st.s)) return withMeta(await IMPL.tTest({ ...a, file: undefined, sample1: st.s.exact, group1: a.column }), meta);
    return withMeta(tSummary(a, 'one_sample', st.s, null, [a.column]), meta, { approximate: ['medians and quartiles in details'] });
  }
  if (type === 'paired') {
    if (!a.column2) throw new UserError('Paired tests from a file need column (before) and column2 (after), measured on the same rows.');
    const { states: [st], meta } = await acc(path, [{ type: 'pair', x: a.column, y: a.column2 }], [missing]);
    checkBad(st);
    if (exact(st.x, st.y)) return withMeta(await IMPL.tTest({ ...a, file: undefined, sample1: st.x.exact, sample2: st.y.exact, group1: a.column, group2: a.column2 }), meta);
    return withMeta(tSummary(a, 'paired', st.x, st.y, [a.column, a.column2], st.d), meta, { approximate: ['medians and quartiles in details'] });
  }
  let X, Y, names, meta;
  if (a.group_column) {
    const r = await acc(path, [{ type: 'grouped', col: a.column, by: a.group_column }], [missing]);
    const st = r.states[0]; meta = r.meta;
    checkBad(st);
    const groups = st.groups;
    let keys = [a.group1, a.group2].filter(Boolean).map(String);
    if (keys.length === 0 && groups.size === 2) keys = [...groups.keys()];
    if (keys.length !== 2) throw new UserError(`Pick two groups with group1 and group2. "${a.group_column}" has: ${[...groups.keys()].slice(0, 20).join(', ')}`);
    for (const k of keys) if (!groups.has(k)) throw new UserError(`Group "${k}" not found in "${a.group_column}". Groups: ${[...groups.keys()].slice(0, 20).join(', ')}`);
    [X, Y] = keys.map((k) => groups.get(k)); names = keys;
  } else if (a.column2) {
    const r = await acc(path, [{ type: 'num', col: a.column }, { type: 'num', col: a.column2 }], [missing]);
    r.states.forEach(checkBad); meta = r.meta;
    [X, Y] = r.states.map((s) => s.s); names = [a.column, a.column2];
  } else throw new UserError('Independent tests from a file need group_column (long format) or column2 (two columns).');
  if (exact(X, Y)) return withMeta(await IMPL.tTest({ ...a, file: undefined, sample1: X.exact, sample2: Y.exact, group1: names[0], group2: names[1] }), meta);
  return withMeta(tSummary(a, 'independent', X, Y, names), meta, { approximate: ['medians and quartiles in details'] });
}

function need(S, label, min) { if (S.n < min) throw new UserError(`${label} needs at least ${min} values (got ${S.n}).`); }
function varies(S, label) { if (sVar(S) === 0) throw new UserError(`${label} has no variation (every value is ${S.min}), so the test is undefined.`); }

function tSummary(a, type, X, Y, names, D) {
  const warnings = [];
  need(X, names[0], 2); if (Y) need(Y, names[1], 2);
  const alt = a.alternative, conf = a.confidence;
  let t, df, diff, se, d, dName, method, extra;
  if (type === 'one_sample') {
    varies(X, names[0]);
    const n = X.n, m = sMean(X), s = sSd(X);
    t = (m - a.mu0) / (s / Math.sqrt(n)); df = n - 1;
    diff = m - a.mu0; se = s / Math.sqrt(n);
    d = diff / s; dName = "Cohen's d (one-sample)"; method = 'One-sample t-test';
    extra = { mu0: a.mu0, [names[0]]: sSummarize(X, conf) };
    warnings.push(...sNormalityWarnings(X, names[0]));
  } else if (type === 'paired') {
    varies(D, 'The paired differences');
    const n = D.n, m = sMean(D), s = sSd(D);
    t = m / (s / Math.sqrt(n)); df = n - 1;
    diff = m; se = s / Math.sqrt(n);
    d = diff / s; dName = "Cohen's d_z (paired)"; method = 'Paired t-test';
    extra = { pairs: n, differences: sSummarize(D, conf), [names[0]]: sSummarize(X, conf), [names[1]]: sSummarize(Y, conf) };
    warnings.push(...sNormalityWarnings(D, 'The paired differences'));
  } else {
    const n1 = X.n, n2 = Y.n, v1 = sVar(X), v2 = sVar(Y);
    if (v1 === 0 && v2 === 0) throw new UserError('Both groups have no variation, so the test is undefined.');
    diff = sMean(X) - sMean(Y);
    if (a.equal_variances) {
      const pooled = ((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2);
      t = diff / Math.sqrt(pooled * (1 / n1 + 1 / n2)); df = n1 + n2 - 2;
      se = Math.sqrt(pooled * (1 / n1 + 1 / n2));
      method = "Student's two-sample t-test (equal variances assumed)";
      const ratio = Math.max(v1, v2) / Math.min(v1, v2);
      if (ratio > 4 || (ratio > 2 && n1 !== n2)) warnings.push(`Group variances differ (ratio ${fmt(ratio, 3)}); Welch's test (equal_variances: false) is safer.`);
    } else {
      const a1 = v1 / n1, a2 = v2 / n2;
      se = Math.sqrt(a1 + a2); t = diff / se;
      df = (a1 + a2) ** 2 / (a1 ** 2 / (n1 - 1) + a2 ** 2 / (n2 - 1));
      method = "Welch's two-sample t-test (unequal variances)";
    }
    d = sCohensD(X, Y); dName = "Cohen's d (pooled SD)";
    extra = { hedges_g: d * (1 - 3 / (4 * (n1 + n2) - 9)), [names[0]]: sSummarize(X, conf), [names[1]]: sSummarize(Y, conf) };
    warnings.push(...sNormalityWarnings(X, names[0]), ...sNormalityWarnings(Y, names[1]));
  }
  const p = tPValue(t, df, alt);
  const crit = inverseTCDF(1 - (1 - conf) / 2, df);
  const ciOf = type === 'one_sample' ? `mean of ${names[0]}` : type === 'paired' ? `mean difference (${names[0]} − ${names[1]})` : `difference in means (${names[0]} − ${names[1]})`;
  const centre = type === 'one_sample' ? sMean(X) : diff;
  const ci = { level: conf, of: ciOf, lower: centre - crit * se, upper: centre + crit * se, note: 'Two-sided interval.' };
  const nullText = type === 'one_sample' ? `a true mean of ${a.mu0}` : type === 'paired' ? 'no average change between the paired measurements' : `equal means in ${names[0]} and ${names[1]}`;
  const altText = type === 'one_sample'
    ? altPhrase(alt, `a mean different from ${a.mu0}`, `a mean greater than ${a.mu0}`, `a mean less than ${a.mu0}`)
    : altPhrase(alt, `a difference between ${names[0]} and ${names[1]}`, `${names[0]} being greater than ${names[1]}`, `${names[0]} being less than ${names[1]}`);
  const v = verdict(p, a.alpha, nullText, altText);
  return {
    data: {
      test: method, alternative: alt, alpha: a.alpha,
      statistic: { name: 't', value: t }, df, p_value: p, significant: v.significant,
      estimate: { [type === 'one_sample' ? 'mean' : 'mean_difference']: centre, std_error: se },
      confidence_interval: ci,
      effect_size: { name: dName, value: d, magnitude: magnitude.d(d) },
      details: extra, interpretation: v.text, warnings,
    },
    summary: [
      `${method}`,
      `t = ${fmt(t)}, df = ${fmt(df)}, ${formatPEq(p)} (${alt})`,
      `${ciOf}: ${fmt(centre)}, ${Math.round(conf * 100)}% CI [${fmt(ci.lower)}, ${fmt(ci.upper)}]`,
      `${dName} = ${fmt(d, 3)} (${magnitude.d(d)})`,
      v.text,
    ],
  };
}

// ------------------------------------------------------------------ ANOVA

export async function anova(a, path) {
  if (!a.column || !a.group_column) throw new UserError('ANOVA from a file needs column (numeric outcome) and group_column.');
  const { states: [st], meta } = await acc(path, [{ type: 'grouped', col: a.column, by: a.group_column }], [{ type: 'missing', cols: [a.column, a.group_column] }]);
  checkBad(st);
  const map = st.groups;
  const keys = a.groups_to_include?.length ? a.groups_to_include.map(String) : [...map.keys()];
  for (const k of keys) if (!map.has(k)) throw new UserError(`Group "${k}" not found. Groups: ${[...map.keys()].join(', ')}`);
  const groups = keys.map((k) => ({ name: k, S: map.get(k) }));
  if (groups.every((g) => isExact(g.S))) return withMeta(await IMPL.anova({ ...a, file: undefined, groups: groups.map((g) => ({ name: g.name, values: g.S.exact })) }), meta);
  return withMeta(anovaSummary(a, groups), meta, { approximate: ['group medians and quartiles'] });
}

function anovaSummary(a, groups) {
  if (groups.length < 2) throw new UserError('ANOVA needs at least 2 groups.');
  if (groups.length > 50) throw new UserError('Too many groups (over 50). Is group_column really categorical?');
  const N = groups.reduce((s, g) => s + g.S.n, 0), k = groups.length;
  if (N - k < 1) throw new UserError('Not enough observations: need more values than groups.');
  const grand = groups.reduce((s, g) => s + g.S.n * sMean(g.S), 0) / N;
  const SSB = groups.reduce((s, g) => s + g.S.n * (sMean(g.S) - grand) ** 2, 0);
  const SSW = groups.reduce((s, g) => s + (g.S.n > 1 ? sVar(g.S) * (g.S.n - 1) : 0), 0);
  if (SSW === 0) throw new UserError('No within-group variation, so ANOVA is undefined.');
  const dfB = k - 1, dfW = N - k;
  const F = (SSB / dfB) / (SSW / dfW), p = fPValue(F, dfB, dfW);
  const eta2 = SSB / (SSB + SSW);
  const omega2 = Math.max(0, (SSB - dfB * (SSW / dfW)) / (SSB + SSW + SSW / dfW));
  const warnings = [];
  const vars = groups.filter((g) => g.S.n > 1).map((g) => sVar(g.S));
  const ratio = Math.max(...vars) / Math.min(...vars);
  if (ratio > 4) warnings.push(`Largest/smallest group variance ratio is ${fmt(ratio, 3)}; the equal-variance assumption is doubtful. Treat p near α with caution.`);
  for (const g of groups) if (g.S.n < 2) warnings.push(`Group "${g.name}" has only one value.`);
  groups.forEach((g) => warnings.push(...sNormalityWarnings(g.S, `Group "${g.name}"`)));
  let pairwise;
  if (a.pairwise) {
    const m = (k * (k - 1)) / 2;
    pairwise = [];
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
      const x = groups[i].S, y = groups[j].S;
      if (x.n < 2 || y.n < 2) continue;
      const a1 = sVar(x) / x.n, a2 = sVar(y) / y.n;
      const t = (sMean(x) - sMean(y)) / Math.sqrt(a1 + a2);
      const df = (a1 + a2) ** 2 / (a1 ** 2 / (x.n - 1) + a2 ** 2 / (y.n - 1));
      const praw = tPValue(t, df);
      pairwise.push({ groups: [groups[i].name, groups[j].name], mean_difference: sMean(x) - sMean(y), t, df, p_value: praw, p_bonferroni: Math.min(1, praw * m), significant: praw * m < a.alpha });
    }
  }
  const v = verdict(p, a.alpha, `equal means in all ${k} groups`, 'at least one group mean being different');
  return {
    data: {
      test: 'One-way ANOVA', alpha: a.alpha,
      statistic: { name: 'F', value: F }, df: { between: dfB, within: dfW }, p_value: p, significant: v.significant,
      effect_size: { name: 'eta squared', value: eta2, magnitude: magnitude.eta2(eta2), omega_squared: omega2 },
      groups: groups.map((g) => ({ name: g.name, ...sSummarize(g.S, a.confidence) })),
      anova_table: { ss_between: SSB, ss_within: SSW, ms_between: SSB / dfB, ms_within: SSW / dfW, total_n: N },
      ...(pairwise && { pairwise_comparisons: { method: 'Welch t-tests, Bonferroni-adjusted', comparisons: pairwise } }),
      interpretation: v.text + (v.significant && !a.pairwise ? ' Set pairwise: true to see which groups differ.' : ''),
      warnings,
    },
    summary: [
      'One-way ANOVA',
      `F(${dfB}, ${dfW}) = ${fmt(F)}, ${formatPEq(p)}`,
      `Means: ${groups.map((g) => `${g.name} = ${fmt(sMean(g.S))}`).join(', ')}`,
      `η² = ${fmt(eta2, 3)} (${magnitude.eta2(eta2)}), ω² = ${fmt(omega2, 3)}`,
      ...(pairwise ? pairwise.map((c) => `  ${c.groups[0]} vs ${c.groups[1]}: diff ${fmt(c.mean_difference)}, Bonferroni p = ${fmt(c.p_bonferroni)}${c.significant ? ' *' : ''}`) : []),
      v.text,
    ],
  };
}

// ------------------------------------------------------------------ counts: chi-square, Fisher

export async function crosstabOf(path, rowCol, colCol, extraPrefetch = []) {
  const { states: [st], meta } = await acc(path, [{ type: 'crosstab', row: rowCol, col: colCol }], extraPrefetch);
  if (st.overflow) throw new UserError('Over 100 categories in a column; is it really categorical?');
  const rl = [...st.pairs.keys()].sort();
  const cl = [...new Set([...st.pairs.values()].flatMap((row) => [...row.keys()]))].sort();
  if (rl.length > 100 || cl.length > 100) throw new UserError('Over 100 categories in a column; is it really categorical?');
  const m = rl.map((r) => cl.map((c) => st.pairs.get(r).get(c) || 0));
  return { m, rl, cl, meta };
}

export async function countsOf(path, col, extraPrefetch = []) {
  const { states: [st], meta } = await acc(path, [{ type: 'counts', col }], extraPrefetch);
  if (st.overflow) throw new UserError(`"${col}" has over 10,000 different values; is it really categorical?`);
  return { counts: st.counts, meta };
}

export async function chiSquare(a, path) {
  if (a.type === 'goodness_of_fit') {
    if (!a.column) throw new UserError('Goodness-of-fit from a file needs column (categorical).');
    const { counts, meta } = await countsOf(path, a.column, [{ type: 'missing', cols: [a.column] }]);
    const cats = [...counts.keys()].sort();
    let expected = a.expected;
    if (a.expected_by_category) {
      for (const k of Object.keys(a.expected_by_category)) if (!counts.has(k)) cats.push(k);
      const missing = cats.filter((k) => a.expected_by_category[k] == null);
      if (missing.length) throw new UserError(`expected_by_category is missing: ${missing.join(', ')}`);
      expected = cats.map((k) => a.expected_by_category[k]);
    }
    const observed = cats.map((k) => counts.get(k) || 0);
    return withMeta(await IMPL.chiSquare({ ...a, file: undefined, expected_by_category: undefined, observed, categories: cats, expected }), meta);
  }
  if (!a.row_column || !a.col_column) throw new UserError('Independence test from a file needs row_column and col_column (both categorical).');
  const { m, rl, cl, meta } = await crosstabOf(path, a.row_column, a.col_column, [{ type: 'missing', cols: [a.row_column, a.col_column] }]);
  return withMeta(await IMPL.chiSquare({ ...a, file: undefined, table: m, row_labels: rl, col_labels: cl }), meta);
}

export async function fisherExact(a, path) {
  if (!a.row_column || !a.col_column) throw new UserError("Fisher's test from a file needs row_column and col_column.");
  const { m, rl, cl, meta } = await crosstabOf(path, a.row_column, a.col_column, [{ type: 'missing', cols: [a.row_column, a.col_column] }]);
  return withMeta(await IMPL.fisherExact({ ...a, file: undefined, table: m, row_labels: rl, col_labels: cl }), meta);
}

// ------------------------------------------------------------------ correlation

function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const out = new Array(arr.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = r;
    i = j + 1;
  }
  return out;
}
function pearsonArr(x, y) {
  let mx = 0, my = 0; for (let i = 0; i < x.length; i++) { mx += x[i]; my += y[i]; } mx /= x.length; my /= y.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

/** Least-squares line from the pair summary, in the engine's linearRegression() format. */
export function fitFromPair(st) {
  const sxx = st.x.m2, syy = st.y.m2;
  if (!(sxx > 0)) return null;
  const slope = st.cxy / sxx, intercept = st.my - slope * st.mx;
  const r2 = syy > 0 ? (st.cxy * st.cxy) / (sxx * syy) : 1;
  const sign = slope >= 0 ? '+' : '−';
  return { type: 'linear', slope, intercept, r2, predict: (x) => intercept + slope * x, formula: `y = ${intercept.toFixed(4)} ${sign} ${Math.abs(slope).toFixed(4)}·x` };
}

export async function correlation(a, path) {
  if (!a.x_column || !a.y_column) throw new UserError('Correlation from a file needs x_column and y_column.');
  const { states: [st], meta } = await acc(path, [{ type: 'pair', x: a.x_column, y: a.y_column }], [{ type: 'missing', cols: [a.x_column, a.y_column] }]);
  checkBad(st);
  const xn = a.x_column, yn = a.y_column;
  if (exact(st.x, st.y)) return withMeta(await IMPL.correlation({ ...a, file: undefined, x: st.x.exact, y: st.y.exact, x_name: xn, y_name: yn }), meta);
  if (st.n < 3) throw new UserError(`${xn} needs at least 3 values (got ${st.n}).`);
  if (sVar(st.x) === 0) throw new UserError(`${xn} has no variation (every value is ${st.x.min}), so the test is undefined.`);
  if (sVar(st.y) === 0) throw new UserError(`${yn} has no variation (every value is ${st.y.min}), so the test is undefined.`);
  const n = st.n, spearman = a.method === 'spearman';
  let r;
  if (spearman) {
    const xs = st.res.items.map((p) => p[0]), ys = st.res.items.map((p) => p[1]);
    r = pearsonArr(ranks(xs), ranks(ys));
  } else r = Math.max(-1, Math.min(1, st.cxy / Math.sqrt(st.x.m2 * st.y.m2)));
  const df = n - 2;
  const t = Math.abs(r) === 1 ? Math.sign(r) * Infinity : r * Math.sqrt(df / (1 - r * r));
  const p = tPValue(t, df, a.alternative);
  let ci;
  if (!spearman && n > 3 && Math.abs(r) < 1) {
    const zr = Math.atanh(r), se = 1 / Math.sqrt(n - 3), zc = inverseNormalCDF(1 - (1 - a.confidence) / 2);
    ci = { level: a.confidence, of: 'Pearson r', lower: Math.tanh(zr - zc * se), upper: Math.tanh(zr + zc * se), method: 'Fisher z' };
  }
  const fit = fitFromPair(st);
  const name = spearman ? "Spearman's ρ" : "Pearson's r";
  const warnings = [];
  const approximate = spearman ? [`Spearman's ρ (from a random sample of ${st.res.items.length} of the ${n} pairs)`] : [];
  const fitLine = fit ? [`Least-squares line: ${fit.formula}, R² = ${fmt(fit.r2, 4)}`] : [];
  const lf = fit && { slope: fit.slope, intercept: fit.intercept, r_squared: fit.r2, formula: fit.formula };
  if (a.descriptive_only) {
    const dir = r > 0 ? 'positive' : r < 0 ? 'negative' : 'no';
    return withMeta({
      data: {
        measure: `${name} correlation (descriptive)`, n, x: xn, y: yn, statistic: { name: spearman ? 'rho' : 'r', value: r },
        ...(ci && { confidence_interval: ci }), effect_size: { name, value: r, magnitude: magnitude.r(r), r_squared: r * r }, linear_fit: lf,
        interpretation: `A ${magnitude.r(r)} ${dir} ${spearman ? 'monotonic' : 'linear'} association between ${xn} and ${yn}. This describes the sample; it is not a significance test, and correlation does not show causation.`,
        warnings,
      },
      summary: [`${name} between ${xn} and ${yn} (n = ${n}, descriptive)`, `${spearman ? 'ρ' : 'r'} = ${fmt(r, 4)} (${magnitude.r(r)}), r² = ${fmt(r * r, 3)}`, ...(ci ? [`${Math.round(a.confidence * 100)}% CI [${fmt(ci.lower, 4)}, ${fmt(ci.upper, 4)}]`] : []), ...fitLine],
    }, meta, { approximate });
  }
  const v = verdict(p, a.alpha, `no ${spearman ? 'monotonic' : 'linear'} relationship between ${xn} and ${yn}`, altPhrase(a.alternative, 'a relationship', 'a positive relationship', 'a negative relationship'));
  return withMeta({
    data: {
      test: `${name} correlation`, alternative: a.alternative, alpha: a.alpha,
      statistic: { name: spearman ? 'rho' : 'r', value: r }, t, df, p_value: p, significant: v.significant, n,
      ...(ci && { confidence_interval: ci }), effect_size: { name, value: r, magnitude: magnitude.r(r), r_squared: r * r }, linear_fit: lf,
      interpretation: v.text + ' Correlation does not show causation.', warnings,
    },
    summary: [`${name} correlation (n = ${n})`, `${spearman ? 'ρ' : 'r'} = ${fmt(r, 4)}, t(${df}) = ${fmt(t)}, ${formatPEq(p)} (${a.alternative})`, ...(ci ? [`${Math.round(a.confidence * 100)}% CI [${fmt(ci.lower, 4)}, ${fmt(ci.upper, 4)}]`] : []), ...fitLine, v.text],
  }, meta, { approximate });
}

// ------------------------------------------------------------------ ANCOVA / MANOVA

/** Group + numeric columns, complete rows (rowsFor). Returns { st, meta }. */
export async function groupedMultiOf(path, by, nums, extraPrefetch = []) {
  const { states: [st], meta } = await acc(path, [{ type: 'groupedMulti', by, nums }], extraPrefetch);
  if (st.bad) throw new UserError(`Column "${st.badCol}" has a non-numeric value "${st.firstBad}".`);
  if (st.overflow) throw new UserError(`${by} has over 1,000 groups; is it really categorical?`);
  return { st, meta };
}
const rowsFromExact = (st, by, nums) => st.rows.map(([g, ...xs]) => Object.fromEntries([[by, g], ...nums.map((c, i) => [c, xs[i]])]));

/** Within-group and total sums of squares and cross-products from group summaries. */
export function pooledSSCP(st) {
  const groups = [...st.groups.entries()];
  const p = st.p, N = groups.reduce((s, [, G]) => s + G.n, 0);
  const grand = new Array(p).fill(0);
  for (const [, G] of groups) for (let i = 0; i < p; i++) grand[i] += G.n * G.mean[i];
  for (let i = 0; i < p; i++) grand[i] /= N;
  const W = Array.from({ length: p }, () => new Array(p).fill(0)), H = Array.from({ length: p }, () => new Array(p).fill(0));
  for (const [, G] of groups) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) {
    W[i][j] += G.C[i][j];
    H[i][j] += G.n * (G.mean[i] - grand[i]) * (G.mean[j] - grand[j]);
  }
  return { groups, N, grand, W, H, T: W.map((r, i) => r.map((v, j) => v + H[i][j])) };
}

export async function ancova(a, path) {
  const nums = [a.outcome_column, a.covariate_column];
  const { st, meta } = await groupedMultiOf(path, a.group_column, nums, [{ type: 'missing', cols: [a.group_column, ...nums] }]);
  if (st.rows) return withMeta(await IMPL.ancova({ ...a, file: undefined, rows: rowsFromExact(st, a.group_column, nums) }), meta);
  const { groups, N, W, T } = pooledSSCP(st);
  const k = groups.length;
  if (N < 4) throw new UserError('Not enough complete cases for ANCOVA');
  if (k < 2) throw new UserError('Group column must have at least 2 groups');
  const SSwinY = W[0][0], SSwinX = W[1][1], SPwin = W[0][1], SStotY = T[0][0], SStotX = T[1][1], SPtot = T[0][1];
  if (SSwinX <= 0 || SStotX <= 0) throw new UserError('Covariate has no variation');
  const ssE = SSwinY - (SPwin * SPwin) / SSwinX;
  const ssG = SStotY - (SPtot * SPtot) / SStotX - ssE;
  const df1 = k - 1, df2 = N - k - 1;
  if (df2 <= 0) throw new UserError('Not enough degrees of freedom (need more observations)');
  const F = (ssG / df1) / (ssE / df2), p = fPValue(F, df1, df2), slope = SPwin / SSwinX;
  const pEta = ssG / (ssG + ssE);
  const v = verdict(p, a.alpha, `equal ${a.outcome_column} means across groups after adjusting for ${a.covariate_column}`, 'a group difference after adjustment');
  return withMeta({
    data: {
      test: 'One-way ANCOVA (Type II / adjusted sums of squares)', alpha: a.alpha,
      statistic: { name: 'F', value: F }, df: { group: df1, error: df2 }, p_value: p, significant: v.significant,
      effect_size: { name: 'partial eta squared', value: pEta, magnitude: magnitude.eta2(pEta) },
      details: { groups: groups.map(([g]) => g), n: N, pooled_within_slope: slope, ss_group_adjusted: ssG, ss_error: ssE },
      interpretation: v.text,
      warnings: ['ANCOVA assumes the covariate has the same slope in every group (no group × covariate interaction) and that the covariate is not affected by group membership.'],
    },
    summary: [
      `One-way ANCOVA: ${a.outcome_column} by ${a.group_column}, adjusting for ${a.covariate_column}`,
      `F(${df1}, ${df2}) = ${fmt(F)}, ${formatPEq(p)}, N = ${N}`,
      `Partial η² = ${fmt(pEta, 3)} (${magnitude.eta2(pEta)}); pooled covariate slope ${fmt(slope)}`,
      v.text,
    ],
  }, meta);
}

export async function manova(a, path) {
  if (!a.outcome_columns || a.outcome_columns.length < 2) throw new UserError('MANOVA needs at least 2 outcome_columns.');
  if (a.outcome_columns.length > 10) throw new UserError('At most 10 outcome columns.');
  const outs = a.outcome_columns;
  const { st, meta } = await groupedMultiOf(path, a.group_column, outs, [{ type: 'missing', cols: [a.group_column, ...outs] }]);
  if (st.rows) return withMeta(await IMPL.manova({ ...a, file: undefined, rows: rowsFromExact(st, a.group_column, outs) }), meta);
  const { groups, N, W: E, H } = pooledSSCP(st);
  const k = groups.length, p = outs.length;
  if (k < 2) throw new UserError('Group column must have at least 2 groups');
  if (N - k < 2) throw new UserError('Not enough complete cases for MANOVA');
  const EH = H.map((row, i) => row.map((v, j) => v + E[i][j]));
  const detE = matrixDet(E), detEH = matrixDet(EH);
  if (detE <= 0 || detEH <= 0) throw new UserError('Outcomes are collinear — choose less correlated outcomes');
  const Lambda = detE / detEH, q = k - 1, ve = N - k;
  const cDenom = p * p + q * q - 5, c = cDenom > 0 ? Math.sqrt((p * p * q * q - 4) / cDenom) : 1;
  const aa = ve + q - (p + q + 1) / 2, df1 = p * q, df2 = aa * c - (p * q) / 2 + 1;
  const F = ((1 - Math.pow(Lambda, 1 / c)) / Math.pow(Lambda, 1 / c)) * (df2 / df1);
  const pv = fPValue(F, df1, df2);
  const v = verdict(pv, a.alpha, 'equal mean vectors across groups', 'a group difference on the combined outcomes');
  return withMeta({
    data: {
      test: "One-way MANOVA (Wilks' lambda, Rao's F approximation)", alpha: a.alpha,
      statistic: { name: 'F', value: F }, wilks_lambda: Lambda, df: { numerator: df1, denominator: df2 }, p_value: pv, significant: v.significant,
      details: { groups: k, outcomes: outs, n: N },
      interpretation: v.text + (v.significant ? ' Follow up with ANOVA on each outcome to see which differ.' : ''),
      warnings: N < 10 * outs.length ? ['Small sample for the number of outcomes; results are unstable.'] : [],
    },
    summary: [`One-way MANOVA: ${outs.join(', ')} by ${a.group_column}`, `Wilks' Λ = ${fmt(Lambda)}, F(${fmt(df1)}, ${fmt(df2)}) = ${fmt(F)}, ${formatPEq(pv)}`, v.text],
  }, meta);
}

// ------------------------------------------------------------------ describe / confidence interval

export async function describe(a, path) {
  if (!a.column) throw new UserError('describe from a file needs column.');
  let sets, meta;
  if (a.group_column) {
    const r = await acc(path, [{ type: 'grouped', col: a.column, by: a.group_column }]);
    checkBad(r.states[0]); meta = r.meta;
    sets = [...r.states[0].groups].map(([name, S]) => ({ name, S }));
  } else {
    const r = await acc(path, [{ type: 'num', col: a.column }]);
    checkBad(r.states[0]); meta = r.meta;
    sets = [{ name: a.column, S: r.states[0].s }];
  }
  if (sets.length > 100) throw new UserError('Over 100 groups; for many categories use group_summary instead.');
  for (const s of sets) need(s.S, s.name, 1);
  const out = sets.map((s) => ({ name: s.name, ...sSummarize(s.S, a.confidence) }));
  const approx = out.some((s) => s.approximate);
  return withMeta({
    data: { descriptives: out },
    summary: out.flatMap((s) => [
      `${s.name}: n = ${s.n}, mean = ${fmt(s.mean)}, SD = ${fmt(s.std_dev)}, median = ${fmt(s.median)}, IQR [${fmt(s.q1)}, ${fmt(s.q3)}], range [${fmt(s.min)}, ${fmt(s.max)}]`,
      ...(s.mean_ci ? [`  ${Math.round(a.confidence * 100)}% CI for mean [${fmt(s.mean_ci.lower)}, ${fmt(s.mean_ci.upper)}]`] : []),
      ...(s.shape ? [`  Shape: ${s.shape.label} (skewness ${fmt(s.skewness, 3)}, excess kurtosis ${fmt(s.excess_kurtosis, 3)})`] : []),
    ]),
  }, meta, { approximate: approx ? ['median', 'quartiles', 'shape label'] : [] });
}

export async function confidenceInterval(a, path) {
  if (!a.column) throw new UserError('column is required with file.');
  const { states: [st], meta } = await acc(path, [{ type: 'num', col: a.column }]);
  checkBad(st);
  if (isExact(st.s)) return withMeta(await IMPL.confidenceInterval({ ...a, file: undefined, values: st.s.exact }), meta);
  need(st.s, 'values', 2);
  if (sVar(st.s) === 0) throw new UserError(`values has no variation (every value is ${st.s.min}), so the test is undefined.`);
  const s = sSummarize(st.s, a.confidence);
  return withMeta({
    data: { confidence_interval: { of: 'mean', method: 't distribution', level: a.confidence, estimate: s.mean, lower: s.mean_ci.lower, upper: s.mean_ci.upper, n: s.n, std_error: s.std_error } },
    summary: [`Mean = ${fmt(s.mean)} (n = ${s.n}); ${Math.round(a.confidence * 100)}% CI [${fmt(s.mean_ci.lower)}, ${fmt(s.mean_ci.upper)}]`],
  }, meta);
}

// ------------------------------------------------------------------ inspect

export async function inspectFile(a, path) {
  const { describe: describeFile } = await import('./service.js');
  const info = await describeFile(path);
  const { states: [st], meta } = await acc(path, [{ type: 'profile', cols: info.headers }]);
  const columns = info.headers.map((h, i) => {
    const c = st.cols[i];
    const numeric = c.allNumeric && c.nonMissing > 0;
    const col = { name: h, type: numeric ? 'numeric' : 'categorical', non_missing: c.nonMissing, missing: st.rows - c.nonMissing };
    if (numeric) Object.assign(col, { min: c.s.min, max: c.s.max, mean: sMean(c.s) });
    col.distinct = c.overflow ? Math.max(c.counts.size, Math.round(hllEstimate(c.hll))) : c.counts.size;
    if (c.overflow) col.distinct_estimated = true;
    if (!numeric || c.counts.size <= 10) col.top_values = [...c.counts].sort((p, q) => q[1] - p[1]).slice(0, 10).map(([value, count]) => ({ value, count }));
    if (!numeric && c.anyNumber) col.note = 'Mixes numbers and text; tools that need numbers will reject it.';
    return col;
  });
  const preview = st.preview.map((r) => Object.fromEntries(info.headers.map((h, i) => [h, r[i]])));
  const warnings = meta.warnings || [];
  return withMeta({
    data: { file: path, rows: st.rows, columns, preview, notes: warnings },
    summary: [
      `${path}: ${st.rows} rows, ${columns.length} columns`,
      ...warnings.map((w) => `  Note: ${w}`),
      ...columns.map((c) => `  ${c.name} (${c.type}${c.missing ? `, ${c.missing} missing` : ''}${c.type === 'numeric' ? `, ${fmt(c.min)} to ${fmt(c.max)}` : `, ${c.distinct}${c.distinct_estimated ? ' (estimated)' : ''} distinct: ${c.top_values.slice(0, 5).map((t) => (/[,"]/.test(t.value) ? JSON.stringify(t.value) : t.value)).join(', ')}${c.distinct > 5 ? ', …' : ''}`})`),
    ],
  }, { ...meta, warnings: [] }, { approximate: columns.some((c) => c.distinct_estimated) ? ['distinct counts (HyperLogLog, within about 2%) and most common values of columns with over 10,000 different values'] : [] });
}

// ------------------------------------------------------------------ base rates

export async function baseRateCounts(path, cond, test) {
  const { states: [st], meta } = await acc(path, [{ type: 'baseRate', cond, test }]);
  return { c: st.c, meta };
}

export { checkLevel };

// ------------------------------------------------------------------ group summary

export async function groupSummary(a, path) {
  let rows, meta, approximate = false;
  if (a.value_column) {
    const r = await acc(path, [{ type: 'grouped', col: a.value_column, by: a.group_column }]);
    checkBad(r.states[0]); meta = r.meta;
    if (r.states[0].overflow) throw new UserError(`${a.group_column} has over 1,000 groups; group_summary covers up to 1,000.`);
    rows = [...r.states[0].groups].map(([group, S]) => {
      if (!isExact(S)) approximate = true;
      const v = S.exact;
      return { group, count: S.n, sum: v ? v.reduce((s, x) => s + x, 0) : S.mean * S.n, mean: sMean(S), median: sMedian(S), min: S.min, max: S.max, std_dev: S.n > 1 ? sSd(S) : null };
    });
  } else {
    const { counts, meta: m } = await countsOf(path, a.group_column);
    meta = m;
    rows = [...counts].map(([group, count]) => ({ group, count }));
  }
  if (!rows.length) throw new UserError(`No rows with both ${a.group_column}${a.value_column ? ` and ${a.value_column}` : ''}.`);
  const stats = a.stats?.length ? a.stats : (a.value_column ? ['count', 'sum', 'mean', 'median'] : ['count']);
  return withMeta(groupSummaryResult(a, rows, { approximate: approximate && stats.includes('median') }), meta, { approximate: approximate && stats.includes('median') ? ['medians of groups with over 100,000 values'] : [] });
}
