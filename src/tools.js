// Tool implementations. Each run() returns { summary, data } or throws UserError.
// Core statistics come from the app's engine (computeTest); this layer adds data loading,
// one-sided alternatives, effect sizes, confidence intervals and assumption warnings.
import { z } from 'zod';
import { computeTest } from './engine/hypothesisTests.js';
import { proportionCI, tTestPower, cohensD } from './engine/statsUtils.js';
import { linearRegression } from './engine/regression.js';
import { loadTable, numericColumn, requireColumn, isMissing, toNumber, categoryKey, UserError, assertFlatRows } from './data.js';
import {
  ALTERNATIVES, tPValue, zPValue, checkSample, checkVaries, checkLevel, magnitude, fmt, verdict, altPhrase,
  summarize, normalityWarnings, mean, variance, stdDev, inverseTCDF, inverseNormalCDF, formatPEq,
} from './stats.js';

// ------------------------------------------------------------------ shared schema pieces

const num = z.number().finite();
const numArray = z.array(num);
const alternative = z.enum(ALTERNATIVES).default('two-sided')
  .describe('two-sided (default), greater (first > second / sample > value), or less.');
const alpha = z.number().gt(0).lt(1).default(0.05).describe('Significance level. Default 0.05.');
const confidence = z.number().gt(0).lt(1).default(0.95).describe('Confidence level for intervals. Default 0.95.');
const file = z.string().optional().describe('Path to a CSV, TSV, Excel (.xlsx/.xls) or Parquet file. Relative paths resolve against the workspace folder. JSON/BSON and other NoSQL data are not tabular and are not supported.');

const join = (arr) => arr.join(',');

/** Groups numeric values of `column` by the category in `groupColumn`. Rows missing either are skipped. */
export function groupValues(table, column, groupColumn) {
  requireColumn(table, column);
  requireColumn(table, groupColumn, 'group column');
  const map = new Map();
  const rows = table.rows.filter((r) => !isMissing(r[groupColumn]) && !isMissing(r[column]));
  for (const r of rows) {
    const key = categoryKey(r[groupColumn]);
    if (!map.has(key)) map.set(key, []);
  }
  for (const [key] of map) {
    map.set(key, numericColumn(table, column, rows.filter((r) => categoryKey(r[groupColumn]) === key)));
  }
  return map;
}

export function pairedColumns(table, a, b) {
  requireColumn(table, a); requireColumn(table, b);
  const rows = table.rows.filter((r) => !isMissing(r[a]) && !isMissing(r[b]));
  return [numericColumn(table, a, rows), numericColumn(table, b, rows)];
}

// ------------------------------------------------------------------ t-test

async function tTest(a) {
  const warnings = [];
  let x, y, names = [a.group1 || 'Sample 1', a.group2 || 'Sample 2'];
  const type = a.type;
  if (a.file) {
    const table = await loadTable(a.file);
    if (!a.column) throw new UserError('column is required when reading from a file.');
    if (type === 'one_sample') {
      x = numericColumn(table, a.column);
      names = [a.column];
    } else if (type === 'paired') {
      if (!a.column2) throw new UserError('Paired tests from a file need column (before) and column2 (after), measured on the same rows.');
      [x, y] = pairedColumns(table, a.column, a.column2);
      names = [a.column, a.column2];
    } else if (a.group_column) {
      const groups = groupValues(table, a.column, a.group_column);
      let keys = [a.group1, a.group2].filter(Boolean).map(String);
      if (keys.length === 0 && groups.size === 2) keys = [...groups.keys()];
      if (keys.length !== 2) {
        throw new UserError(`Pick two groups with group1 and group2. "${a.group_column}" has: ${[...groups.keys()].slice(0, 20).join(', ')}`);
      }
      for (const k of keys) if (!groups.has(k)) throw new UserError(`Group "${k}" not found in "${a.group_column}". Groups: ${[...groups.keys()].slice(0, 20).join(', ')}`);
      [x, y] = keys.map((k) => groups.get(k));
      names = keys;
    } else if (a.column2) {
      x = numericColumn(table, a.column); y = numericColumn(table, a.column2);
      names = [a.column, a.column2];
    } else {
      throw new UserError('Independent tests from a file need group_column (long format) or column2 (two columns).');
    }
  } else {
    x = a.sample1; y = a.sample2;
    if (type === 'one_sample') names = [a.group1 || 'Sample'];
  }

  checkSample(x, names[0]);
  if (type !== 'one_sample') checkSample(y, names[1]);
  const alt = a.alternative, conf = a.confidence;
  let t, df, diff, se, label, d, dName, method, extra = {};

  if (type === 'one_sample') {
    checkVaries(x, names[0]);
    const r = computeTest('ttest', { testType: 'one-sample', group1: join(x), populationMean: String(a.mu0) });
    t = r.testStatistic; df = r.df;
    diff = mean(x) - a.mu0; se = stdDev(x) / Math.sqrt(x.length);
    d = diff / stdDev(x); dName = "Cohen's d (one-sample)";
    method = 'One-sample t-test';
    extra = { mu0: a.mu0, [names[0]]: summarize(x, conf) };
    warnings.push(...normalityWarnings(x, names[0]));
  } else if (type === 'paired') {
    if (x.length !== y.length) throw new UserError(`Paired samples must be the same length (${x.length} vs ${y.length}).`);
    const diffs = x.map((v, i) => v - y[i]);
    checkVaries(diffs, 'The paired differences');
    const r = computeTest('ttest', { testType: 'paired', group1: join(x), group2: join(y) });
    t = r.testStatistic; df = r.df;
    diff = mean(diffs); se = stdDev(diffs) / Math.sqrt(diffs.length);
    d = diff / stdDev(diffs); dName = "Cohen's d_z (paired)";
    method = 'Paired t-test';
    extra = { pairs: x.length, differences: summarize(diffs, conf), [names[0]]: summarize(x, conf), [names[1]]: summarize(y, conf) };
    warnings.push(...normalityWarnings(diffs, 'The paired differences'));
  } else {
    const n1 = x.length, n2 = y.length, v1 = variance(x), v2 = variance(y);
    if (v1 === 0 && v2 === 0) throw new UserError('Both groups have no variation, so the test is undefined.');
    diff = mean(x) - mean(y);
    if (a.equal_variances) {
      const r = computeTest('ttest', { testType: 'independent', group1: join(x), group2: join(y) });
      t = r.testStatistic; df = r.df;
      se = Math.sqrt((((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2)) * (1 / n1 + 1 / n2));
      method = "Student's two-sample t-test (equal variances assumed)";
      const ratio = Math.max(v1, v2) / Math.min(v1, v2);
      if (ratio > 4 || (ratio > 2 && n1 !== n2)) warnings.push(`Group variances differ (ratio ${fmt(ratio, 3)}); Welch's test (equal_variances: false) is safer.`);
    } else {
      const a1 = v1 / n1, a2 = v2 / n2;
      se = Math.sqrt(a1 + a2);
      t = diff / se;
      df = (a1 + a2) ** 2 / (a1 ** 2 / (n1 - 1) + a2 ** 2 / (n2 - 1));
      method = "Welch's two-sample t-test (unequal variances)";
    }
    d = cohensD(x, y); dName = "Cohen's d (pooled SD)";
    extra = {
      hedges_g: d * (1 - 3 / (4 * (n1 + n2) - 9)),
      [names[0]]: summarize(x, conf), [names[1]]: summarize(y, conf),
    };
    warnings.push(...normalityWarnings(x, names[0]), ...normalityWarnings(y, names[1]));
  }

  const p = tPValue(t, df, alt);
  const crit = inverseTCDF(1 - (1 - conf) / 2, df);
  const ciOf = type === 'one_sample' ? `mean of ${names[0]}` : type === 'paired' ? `mean difference (${names[0]} − ${names[1]})` : `difference in means (${names[0]} − ${names[1]})`;
  const centre = type === 'one_sample' ? mean(x) : diff;
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

// ------------------------------------------------------------------ z-test

async function zTest(a) {
  const alt = a.alternative;
  if (a.type === 'proportion') {
    const { successes: k, n, p0 } = a;
    if (k == null || n == null || p0 == null) throw new UserError('Proportion z-test needs successes, n and p0.');
    if (!(n > 0) || k < 0 || k > n) throw new UserError('Need 0 ≤ successes ≤ n and n > 0.');
    checkLevel(p0, 'p0');
    const r = computeTest('ztest', { zTestType: 'proportion', successes: String(k), sampleSize: String(n), hypothesizedProportion: String(p0) });
    const z0 = r.testStatistic, p = zPValue(z0, alt), pHat = k / n;
    const ci = proportionCI(k, n, a.confidence);
    const h = 2 * Math.asin(Math.sqrt(pHat)) - 2 * Math.asin(Math.sqrt(p0));
    const warnings = [];
    if (n * p0 < 10 || n * (1 - p0) < 10) warnings.push(`n·p₀ or n·(1−p₀) is below 10, so the normal approximation is rough. binomial_test gives an exact p-value.`);
    const v = verdict(p, a.alpha, `a true proportion of ${p0}`, altPhrase(alt, `a proportion different from ${p0}`, `a proportion above ${p0}`, `a proportion below ${p0}`));
    return {
      data: {
        test: 'One-proportion z-test', alternative: alt, alpha: a.alpha,
        statistic: { name: 'z', value: z0 }, p_value: p, significant: v.significant,
        estimate: { proportion: pHat },
        confidence_interval: { level: a.confidence, of: 'proportion', lower: ci.lower, upper: ci.upper, method: 'Wilson score' },
        effect_size: { name: "Cohen's h", value: h, magnitude: magnitude.h(h) },
        details: { successes: k, n, p0 }, interpretation: v.text, warnings,
      },
      summary: [
        'One-proportion z-test',
        `p̂ = ${fmt(pHat)} vs p₀ = ${p0}; z = ${fmt(z0)}, ${formatPEq(p)} (${alt})`,
        `${Math.round(a.confidence * 100)}% Wilson CI [${fmt(ci.lower)}, ${fmt(ci.upper)}]; Cohen's h = ${fmt(h, 3)} (${magnitude.h(h)})`,
        v.text,
      ],
    };
  }
  // mean with known population SD
  let xbar = a.sample_mean, n = a.n;
  if (a.values) { checkSample(a.values, 'values', 1); xbar = mean(a.values); n = a.values.length; }
  if (xbar == null || n == null || a.population_sd == null || a.mu0 == null) {
    throw new UserError('Mean z-test needs mu0, population_sd and either values or sample_mean + n.');
  }
  if (!(a.population_sd > 0) || !(n > 0)) throw new UserError('population_sd and n must be positive.');
  const r = computeTest('ztest', { zTestType: 'mean', sampleMean: String(xbar), sampleSize: String(n), populationStdDev: String(a.population_sd), populationMean: String(a.mu0) });
  const z0 = r.testStatistic, p = zPValue(z0, alt);
  const se = a.population_sd / Math.sqrt(n), crit = inverseNormalCDF(1 - (1 - a.confidence) / 2);
  const d = (xbar - a.mu0) / a.population_sd;
  const v = verdict(p, a.alpha, `a true mean of ${a.mu0}`, altPhrase(alt, `a mean different from ${a.mu0}`, `a mean above ${a.mu0}`, `a mean below ${a.mu0}`));
  return {
    data: {
      test: 'One-sample z-test (known σ)', alternative: alt, alpha: a.alpha,
      statistic: { name: 'z', value: z0 }, p_value: p, significant: v.significant,
      estimate: { mean: xbar, std_error: se },
      confidence_interval: { level: a.confidence, of: 'mean', lower: xbar - crit * se, upper: xbar + crit * se },
      effect_size: { name: "Cohen's d", value: d, magnitude: magnitude.d(d) },
      details: { n, population_sd: a.population_sd, mu0: a.mu0 }, interpretation: v.text,
      warnings: ['Use a z-test only when σ is truly known; otherwise use t_test (one_sample).'],
    },
    summary: [
      'One-sample z-test (known σ)',
      `x̄ = ${fmt(xbar)}, z = ${fmt(z0)}, ${formatPEq(p)} (${alt})`,
      `${Math.round(a.confidence * 100)}% CI [${fmt(xbar - crit * se)}, ${fmt(xbar + crit * se)}]`,
      v.text,
    ],
  };
}

// ------------------------------------------------------------------ ANOVA

async function anova(a) {
  let groups; // [{name, values}]
  if (a.file) {
    if (!a.column || !a.group_column) throw new UserError('ANOVA from a file needs column (numeric outcome) and group_column.');
    const table = await loadTable(a.file);
    const map = groupValues(table, a.column, a.group_column);
    const keys = a.groups_to_include?.length ? a.groups_to_include.map(String) : [...map.keys()];
    for (const k of keys) if (!map.has(k)) throw new UserError(`Group "${k}" not found. Groups: ${[...map.keys()].join(', ')}`);
    groups = keys.map((k) => ({ name: k, values: map.get(k) }));
  } else {
    groups = (a.groups || []).map((g, i) => ({ name: g.name || `Group ${i + 1}`, values: g.values }));
  }
  if (groups.length < 2) throw new UserError('ANOVA needs at least 2 groups.');
  if (groups.length > 50) throw new UserError('Too many groups (over 50). Is group_column really categorical?');
  for (const g of groups) checkSample(g.values, `Group "${g.name}"`, 1);
  const N = groups.reduce((s, g) => s + g.values.length, 0);
  if (N - groups.length < 1) throw new UserError('Not enough observations: need more values than groups.');
  if (groups.every((g) => g.values.length < 2 || variance(g.values) === 0)) throw new UserError('No within-group variation, so ANOVA is undefined.');

  const r = computeTest('anova', { groupsData: groups.map((g) => join(g.values)).join('\n'), alpha: String(a.alpha) });
  const F = r.testStatistic, p = r.pValue;
  const SSB = r.additionalStats['SS Between'], SSW = r.additionalStats['SS Within'];
  const [dfB, dfW] = String(r.df).split(',').map(Number);
  const eta2 = SSB / (SSB + SSW);
  const omega2 = Math.max(0, (SSB - dfB * (SSW / dfW)) / (SSB + SSW + SSW / dfW));

  const warnings = [];
  const vars = groups.filter((g) => g.values.length > 1).map((g) => variance(g.values));
  const ratio = Math.max(...vars) / Math.min(...vars);
  if (ratio > 4) warnings.push(`Largest/smallest group variance ratio is ${fmt(ratio, 3)}; the equal-variance assumption is doubtful. Treat p near α with caution.`);
  for (const g of groups) if (g.values.length < 2) warnings.push(`Group "${g.name}" has only one value.`);
  groups.forEach((g) => warnings.push(...normalityWarnings(g.values, `Group "${g.name}"`)));

  let pairwise;
  if (a.pairwise) {
    const m = (groups.length * (groups.length - 1)) / 2;
    pairwise = [];
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const x = groups[i].values, y = groups[j].values;
      if (x.length < 2 || y.length < 2) continue;
      const a1 = variance(x) / x.length, a2 = variance(y) / y.length;
      const t = (mean(x) - mean(y)) / Math.sqrt(a1 + a2);
      const df = (a1 + a2) ** 2 / (a1 ** 2 / (x.length - 1) + a2 ** 2 / (y.length - 1));
      const praw = tPValue(t, df);
      pairwise.push({ groups: [groups[i].name, groups[j].name], mean_difference: mean(x) - mean(y), t, df, p_value: praw, p_bonferroni: Math.min(1, praw * m), significant: praw * m < a.alpha });
    }
  }

  const names = groups.map((g) => g.name);
  const v = verdict(p, a.alpha, `equal means in all ${groups.length} groups`, 'at least one group mean being different');
  return {
    data: {
      test: 'One-way ANOVA', alpha: a.alpha,
      statistic: { name: 'F', value: F }, df: { between: dfB, within: dfW }, p_value: p, significant: v.significant,
      effect_size: { name: 'eta squared', value: eta2, magnitude: magnitude.eta2(eta2), omega_squared: omega2 },
      groups: groups.map((g) => ({ name: g.name, ...summarize(g.values, a.confidence) })),
      anova_table: { ss_between: SSB, ss_within: SSW, ms_between: SSB / dfB, ms_within: SSW / dfW, total_n: N },
      ...(pairwise && { pairwise_comparisons: { method: "Welch t-tests, Bonferroni-adjusted", comparisons: pairwise } }),
      interpretation: v.text + (v.significant && !a.pairwise ? ' Set pairwise: true to see which groups differ.' : ''),
      warnings,
    },
    summary: [
      'One-way ANOVA',
      `F(${dfB}, ${dfW}) = ${fmt(F)}, ${formatPEq(p)}`,
      `Means: ${groups.map((g) => `${g.name} = ${fmt(mean(g.values))}`).join(', ')}`,
      `η² = ${fmt(eta2, 3)} (${magnitude.eta2(eta2)}), ω² = ${fmt(omega2, 3)}`,
      ...(pairwise ? pairwise.map((c) => `  ${c.groups[0]} vs ${c.groups[1]}: diff ${fmt(c.mean_difference)}, Bonferroni p = ${fmt(c.p_bonferroni)}${c.significant ? ' *' : ''}`) : []),
      v.text,
    ],
  };
}

// ------------------------------------------------------------------ chi-square

export function crosstab(table, rowCol, colCol) {
  requireColumn(table, rowCol); requireColumn(table, colCol);
  const rows = table.rows.filter((r) => !isMissing(r[rowCol]) && !isMissing(r[colCol]));
  const rl = [...new Set(rows.map((r) => categoryKey(r[rowCol])))].sort();
  const cl = [...new Set(rows.map((r) => categoryKey(r[colCol])))].sort();
  if (rl.length > 100 || cl.length > 100) throw new UserError('Over 100 categories in a column; is it really categorical?');
  const m = rl.map(() => cl.map(() => 0));
  for (const r of rows) m[rl.indexOf(categoryKey(r[rowCol]))][cl.indexOf(categoryKey(r[colCol]))]++;
  return { m, rl, cl };
}

async function chiSquare(a) {
  const warnings = [];
  if (a.type === 'goodness_of_fit') {
    let observed = a.observed, cats = a.categories, expected = a.expected;
    if (a.file) {
      if (!a.column) throw new UserError('Goodness-of-fit from a file needs column (categorical).');
      const table = await loadTable(a.file);
      requireColumn(table, a.column);
      const counts = new Map();
      for (const r of table.rows) if (!isMissing(r[a.column])) { const k = categoryKey(r[a.column]); counts.set(k, (counts.get(k) || 0) + 1); }
      cats = [...counts.keys()].sort();
      if (a.expected_by_category) {
        for (const k of Object.keys(a.expected_by_category)) if (!counts.has(k)) cats.push(k);
        const missing = cats.filter((k) => a.expected_by_category[k] == null);
        if (missing.length) throw new UserError(`expected_by_category is missing: ${missing.join(', ')}`);
        expected = cats.map((k) => a.expected_by_category[k]);
      }
      observed = cats.map((k) => counts.get(k) || 0);
    }
    if (!observed || observed.length < 2) throw new UserError('Need observed counts for at least 2 categories.');
    if (observed.some((o) => o < 0)) throw new UserError('Observed counts cannot be negative.');
    const total = observed.reduce((s, v) => s + v, 0);
    if (total <= 0) throw new UserError('Observed counts sum to zero.');
    let props;
    if (expected?.length) {
      if (expected.length !== observed.length) throw new UserError(`expected has ${expected.length} values but there are ${observed.length} categories.`);
      if (expected.some((e) => !(e > 0))) throw new UserError('Every expected value must be positive.');
      const es = expected.reduce((s, v) => s + v, 0);
      const looksLikeProps = Math.abs(es - 1) < 1e-6;
      if (!looksLikeProps && Math.abs(es - total) > 1e-6 * Math.max(1, total)) {
        throw new UserError(`expected must be proportions summing to 1 or counts summing to the observed total (${total}); it sums to ${es}.`);
      }
      props = expected.map((e) => e / es);
    } else props = observed.map(() => 1 / observed.length);
    // The engine treats all-≤1 expected values as proportions and scales them by the total.
    const r = computeTest('chisquare', { chiTestType: 'goodness', observed: join(observed), expected: join(props) });
    const exp = props.map((q) => q * total);
    if (exp.some((e) => e < 5)) warnings.push(`Some expected counts are below 5 (min ${fmt(Math.min(...exp), 3)}); the χ² approximation may be poor. Combine small categories.`);
    const w = Math.sqrt(r.testStatistic / total);
    const v = verdict(r.pValue, a.alpha, 'the expected distribution', 'a different distribution');
    const labels = cats || observed.map((_, i) => `Category ${i + 1}`);
    return {
      data: {
        test: 'Chi-square goodness-of-fit test', alpha: a.alpha,
        statistic: { name: 'chi_square', value: r.testStatistic }, df: r.df, p_value: r.pValue, significant: v.significant,
        effect_size: { name: "Cohen's w", value: w, magnitude: magnitude.r(w) },
        cells: labels.map((c, i) => ({ category: c, observed: observed[i], expected: exp[i], residual: (observed[i] - exp[i]) / Math.sqrt(exp[i]) })),
        interpretation: v.text, warnings,
      },
      summary: [
        'Chi-square goodness-of-fit test',
        `χ²(${r.df}) = ${fmt(r.testStatistic)}, ${formatPEq(r.pValue)}, N = ${total}`,
        `Observed vs expected: ${labels.map((c, i) => `${c} ${observed[i]}/${fmt(exp[i], 3)}`).join(', ')}`,
        `Cohen's w = ${fmt(w, 3)} (${magnitude.r(w)})`,
        v.text,
      ],
    };
  }

  // independence
  let m = a.table, rl = a.row_labels, cl = a.col_labels;
  if (a.file) {
    if (!a.row_column || !a.col_column) throw new UserError('Independence test from a file needs row_column and col_column (both categorical).');
    ({ m, rl, cl } = crosstab(await loadTable(a.file), a.row_column, a.col_column));
  }
  if (!m || m.length < 2 || m[0].length < 2) throw new UserError('Need a contingency table with at least 2 rows and 2 columns.');
  if (m.some((row) => row.length !== m[0].length)) throw new UserError('Every table row must have the same number of columns.');
  if (m.flat().some((v) => v < 0 || !Number.isFinite(v))) throw new UserError('Counts must be non-negative numbers.');
  const rt = m.map((row) => row.reduce((s, v) => s + v, 0));
  const ct = m[0].map((_, j) => m.reduce((s, row) => s + row[j], 0));
  if (rt.some((v) => v === 0) || ct.some((v) => v === 0)) throw new UserError('A row or column has a total of zero; remove it first.');
  const N = rt.reduce((s, v) => s + v, 0);
  const r = computeTest('chisquare', { chiTestType: 'independence', contingencyTable: m.map(join).join('\n') });
  const exp = m.map((row, i) => row.map((_, j) => (rt[i] * ct[j]) / N));
  const flatE = exp.flat();
  const small = flatE.filter((e) => e < 5).length;
  if (small / flatE.length > 0.2 || flatE.some((e) => e < 1)) warnings.push(`${small} of ${flatE.length} expected counts are below 5; the χ² approximation may be poor.${m.length === 2 && m[0].length === 2 ? " For a 2×2 table, Fisher's exact test is the usual alternative." : ' Combine sparse categories.'}`);
  const dfStar = Math.min(m.length, m[0].length) - 1;
  const V = Math.sqrt(r.testStatistic / (N * dfStar));
  rl = rl || m.map((_, i) => `Row ${i + 1}`); cl = cl || m[0].map((_, j) => `Col ${j + 1}`);
  const v = verdict(r.pValue, a.alpha, 'the two variables being independent', 'an association between them');
  return {
    data: {
      test: 'Chi-square test of independence (no continuity correction)', alpha: a.alpha,
      statistic: { name: 'chi_square', value: r.testStatistic }, df: r.df, p_value: r.pValue, significant: v.significant,
      effect_size: { name: "Cramér's V", value: V, magnitude: magnitude.cramersV(V, dfStar) },
      table: { row_labels: rl, col_labels: cl, observed: m, expected: exp }, n: N,
      interpretation: v.text, warnings,
    },
    summary: [
      'Chi-square test of independence',
      `χ²(${r.df}) = ${fmt(r.testStatistic)}, ${formatPEq(r.pValue)}, N = ${N}`,
      `Cramér's V = ${fmt(V, 3)} (${magnitude.cramersV(V, dfStar)})`,
      v.text,
    ],
  };
}

// ------------------------------------------------------------------ Fisher's exact (2×2)

function logChoose(n, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i); return s; }

async function fisherExact(a) {
  let m = a.table, rl = a.row_labels, cl = a.col_labels;
  if (a.file) {
    if (!a.row_column || !a.col_column) throw new UserError("Fisher's test from a file needs row_column and col_column.");
    ({ m, rl, cl } = crosstab(await loadTable(a.file), a.row_column, a.col_column));
  }
  if (!m || m.length !== 2 || m.some((r) => r.length !== 2)) throw new UserError("Fisher's exact test needs a 2×2 table of counts.");
  if (m.flat().some((v) => !Number.isInteger(v) || v < 0)) throw new UserError('Counts must be non-negative whole numbers.');
  const [[A, B], [C, D]] = m;
  const r1 = A + B, c1 = A + C, N = A + B + C + D;
  if (N > 1e6) throw new UserError('Table total above 1,000,000; use chi_square instead.');
  const lo = Math.max(0, r1 + c1 - N), hi = Math.min(r1, c1);
  const lp = (x) => logChoose(c1, x) + logChoose(N - c1, r1 - x) - logChoose(N, r1);
  const pObs = lp(A);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const l = lp(x);
    if (a.alternative === 'greater' ? x >= A : a.alternative === 'less' ? x <= A : l <= pObs + Math.log1p(1e-7)) p += Math.exp(l);
  }
  p = Math.min(1, p);
  const or = B * C === 0 ? (A * D === 0 ? NaN : Infinity) : (A * D) / (B * C);
  rl = rl || ['Row 1', 'Row 2']; cl = cl || ['Col 1', 'Col 2'];
  const v = verdict(p, a.alpha, 'no association between rows and columns',
    altPhrase(a.alternative, 'an association', 'odds ratio above 1', 'odds ratio below 1'));
  return {
    data: {
      test: "Fisher's exact test (2×2)", alternative: a.alternative, alpha: a.alpha, p_value: p, significant: v.significant,
      effect_size: { name: 'sample odds ratio', value: or },
      table: { row_labels: rl, col_labels: cl, observed: m }, n: N, interpretation: v.text, warnings: [],
    },
    summary: ["Fisher's exact test (2×2)", `Odds ratio = ${fmt(or)}, ${formatPEq(p)} (${a.alternative}), N = ${N}`, v.text],
  };
}

// ------------------------------------------------------------------ binomial

async function binomialTest(a) {
  const { successes: k, trials: n, p0 } = a;
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 0 || k > n) throw new UserError('Need whole numbers with 0 ≤ successes ≤ trials and trials ≥ 1.');
  checkLevel(p0, 'p0');
  if (n > 1e6) throw new UserError('trials above 1,000,000: use z_test (proportion) instead.');
  const r = computeTest('binomial', { trials: String(n), successes: String(k), hypothesizedProb: String(p0), alternative: a.alternative });
  const ci = proportionCI(k, n, a.confidence);
  const v = verdict(r.pValue, a.alpha, `a true success probability of ${p0}`, altPhrase(a.alternative, `a probability different from ${p0}`, `a probability above ${p0}`, `a probability below ${p0}`));
  return {
    data: {
      test: 'Exact binomial test', alternative: a.alternative, alpha: a.alpha,
      p_value: r.pValue, significant: v.significant,
      estimate: { proportion: k / n },
      confidence_interval: { level: a.confidence, of: 'proportion', lower: ci.lower, upper: ci.upper, method: 'Wilson score' },
      details: { successes: k, trials: n, p0, expected_successes: n * p0 }, interpretation: v.text, warnings: [],
    },
    summary: [
      'Exact binomial test',
      `${k}/${n} = ${fmt(k / n)} vs p₀ = ${p0}; ${formatPEq(r.pValue)} (${a.alternative})`,
      `${Math.round(a.confidence * 100)}% Wilson CI [${fmt(ci.lower)}, ${fmt(ci.upper)}]`,
      v.text,
    ],
  };
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
function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

async function correlation(a) {
  let x = a.x, y = a.y, xn = a.x_name || 'x', yn = a.y_name || 'y';
  if (a.file) {
    if (!a.x_column || !a.y_column) throw new UserError('Correlation from a file needs x_column and y_column.');
    [x, y] = pairedColumns(await loadTable(a.file), a.x_column, a.y_column);
    xn = a.x_column; yn = a.y_column;
  }
  checkSample(x, xn, 3); checkSample(y, yn, 3);
  if (x.length !== y.length) throw new UserError(`x and y must be the same length (${x.length} vs ${y.length}).`);
  checkVaries(x, xn); checkVaries(y, yn);
  const n = x.length, spearman = a.method === 'spearman';
  const r = spearman ? pearson(ranks(x), ranks(y)) : pearson(x, y);
  const df = n - 2;
  const t = Math.abs(r) === 1 ? Math.sign(r) * Infinity : r * Math.sqrt(df / (1 - r * r));
  const p = tPValue(t, df, a.alternative);
  let ci;
  if (!spearman && n > 3 && Math.abs(r) < 1) {
    const zr = Math.atanh(r), se = 1 / Math.sqrt(n - 3), zc = inverseNormalCDF(1 - (1 - a.confidence) / 2);
    ci = { level: a.confidence, of: 'Pearson r', lower: Math.tanh(zr - zc * se), upper: Math.tanh(zr + zc * se), method: 'Fisher z' };
  }
  const fit = linearRegression(x.map((xi, i) => ({ x: xi, y: y[i] })));
  const name = spearman ? "Spearman's ρ" : "Pearson's r";
  const v = verdict(p, a.alpha, `no ${spearman ? 'monotonic' : 'linear'} relationship between ${xn} and ${yn}`,
    altPhrase(a.alternative, 'a relationship', 'a positive relationship', 'a negative relationship'));
  const warnings = [];
  if (n < 10) warnings.push(`Only ${n} pairs; the correlation estimate is very imprecise.`);
  const fitLine = fit ? [`Least-squares line: ${fit.formula}, R² = ${fmt(fit.r2, 4)}`] : [];
  if (a.descriptive_only) {
    // Exploration: describe the relationship's strength and direction; no hypothesis, no p-value.
    const dir = r > 0 ? 'positive' : r < 0 ? 'negative' : 'no';
    return {
      data: {
        measure: `${name} correlation (descriptive)`, n, x: xn, y: yn,
        statistic: { name: spearman ? 'rho' : 'r', value: r },
        ...(ci && { confidence_interval: ci }),
        effect_size: { name, value: r, magnitude: magnitude.r(r), r_squared: r * r },
        linear_fit: fit && { slope: fit.slope, intercept: fit.intercept, r_squared: fit.r2, formula: fit.formula },
        interpretation: `A ${magnitude.r(r)} ${dir} ${spearman ? 'monotonic' : 'linear'} association between ${xn} and ${yn}. This describes the sample; it is not a significance test, and correlation does not show causation.`,
        warnings,
      },
      summary: [
        `${name} between ${xn} and ${yn} (n = ${n}, descriptive)`,
        `${spearman ? 'ρ' : 'r'} = ${fmt(r, 4)} (${magnitude.r(r)}), r² = ${fmt(r * r, 3)}`,
        ...(ci ? [`${Math.round(a.confidence * 100)}% CI [${fmt(ci.lower, 4)}, ${fmt(ci.upper, 4)}]`] : []),
        ...fitLine,
      ],
    };
  }
  if (spearman && n < 20) warnings.push('Spearman p-value uses the t approximation, which is rough below about 20 pairs.');
  return {
    data: {
      test: `${name} correlation`, alternative: a.alternative, alpha: a.alpha,
      statistic: { name: spearman ? 'rho' : 'r', value: r }, t, df, p_value: p, significant: v.significant, n,
      ...(ci && { confidence_interval: ci }),
      effect_size: { name, value: r, magnitude: magnitude.r(r), r_squared: r * r },
      linear_fit: fit && { slope: fit.slope, intercept: fit.intercept, r_squared: fit.r2, formula: fit.formula },
      interpretation: v.text + ' Correlation does not show causation.', warnings,
    },
    summary: [
      `${name} correlation (n = ${n})`,
      `${spearman ? 'ρ' : 'r'} = ${fmt(r, 4)}, t(${df}) = ${fmt(t)}, ${formatPEq(p)} (${a.alternative})`,
      ...(ci ? [`${Math.round(a.confidence * 100)}% CI [${fmt(ci.lower, 4)}, ${fmt(ci.upper, 4)}]`] : []),
      ...(fit ? [`Least-squares line: ${fit.formula}, R² = ${fmt(fit.r2, 4)}`] : []),
      v.text,
    ],
  };
}

// ------------------------------------------------------------------ ANCOVA / MANOVA

export async function rowsFor(a, numericCols, groupCol) {
  let rows;
  if (a.file) rows = (await loadTable(a.file)).rows;
  else if (Array.isArray(a.rows)) { assertFlatRows(a.rows); rows = a.rows; }
  else throw new UserError('Provide file or rows (an array of row objects).');
  const headers = new Set(rows.flatMap((r) => Object.keys(r)));
  for (const c of [groupCol, ...numericCols]) if (!headers.has(c)) throw new UserError(`No column named "${c}". Columns: ${[...headers].join(', ')}`);
  const out = [];
  for (const r of rows) {
    if (isMissing(r[groupCol]) || numericCols.some((c) => isMissing(r[c]))) continue;
    const o = { [groupCol]: categoryKey(r[groupCol]) };
    for (const c of numericCols) {
      const v = toNumber(r[c]);
      if (v === null) throw new UserError(`Column "${c}" has a non-numeric value "${r[c]}".`);
      o[c] = v;
    }
    out.push(o);
  }
  return out;
}

async function ancova(a) {
  const rows = await rowsFor(a, [a.outcome_column, a.covariate_column], a.group_column);
  const r = computeTest('ancova', { groupCol: a.group_column, outcomeCol: a.outcome_column, covariateCol: a.covariate_column, alpha: String(a.alpha) }, { rows });
  const [df1, df2] = String(r.df).split(',').map(Number);
  const ssG = r.additionalStats['Adj. SS group'], ssE = r.additionalStats['Adj. SS error'];
  const pEta = ssG / (ssG + ssE);
  const v = verdict(r.pValue, a.alpha, `equal ${a.outcome_column} means across groups after adjusting for ${a.covariate_column}`, 'a group difference after adjustment');
  const groups = [...new Set(rows.map((x) => x[a.group_column]))];
  return {
    data: {
      test: 'One-way ANCOVA (Type II / adjusted sums of squares)', alpha: a.alpha,
      statistic: { name: 'F', value: r.testStatistic }, df: { group: df1, error: df2 }, p_value: r.pValue, significant: v.significant,
      effect_size: { name: 'partial eta squared', value: pEta, magnitude: magnitude.eta2(pEta) },
      details: { groups, n: rows.length, pooled_within_slope: r.additionalStats['Covariate slope'], ss_group_adjusted: ssG, ss_error: ssE },
      interpretation: v.text,
      warnings: ['ANCOVA assumes the covariate has the same slope in every group (no group × covariate interaction) and that the covariate is not affected by group membership.'],
    },
    summary: [
      `One-way ANCOVA: ${a.outcome_column} by ${a.group_column}, adjusting for ${a.covariate_column}`,
      `F(${df1}, ${df2}) = ${fmt(r.testStatistic)}, ${formatPEq(r.pValue)}, N = ${rows.length}`,
      `Partial η² = ${fmt(pEta, 3)} (${magnitude.eta2(pEta)}); pooled covariate slope ${fmt(r.additionalStats['Covariate slope'])}`,
      v.text,
    ],
  };
}

async function manova(a) {
  if (!a.outcome_columns || a.outcome_columns.length < 2) throw new UserError('MANOVA needs at least 2 outcome_columns.');
  if (a.outcome_columns.length > 10) throw new UserError('At most 10 outcome columns.');
  const rows = await rowsFor(a, a.outcome_columns, a.group_column);
  const r = computeTest('manova', { groupCol: a.group_column, outcomeCols: a.outcome_columns, alpha: String(a.alpha) }, { rows });
  const [df1, df2] = String(r.df).split(',').map(Number);
  const v = verdict(r.pValue, a.alpha, 'equal mean vectors across groups', 'a group difference on the combined outcomes');
  return {
    data: {
      test: "One-way MANOVA (Wilks' lambda, Rao's F approximation)", alpha: a.alpha,
      statistic: { name: 'F', value: r.testStatistic }, wilks_lambda: r.additionalStats["Wilks' Λ"],
      df: { numerator: df1, denominator: df2 }, p_value: r.pValue, significant: v.significant,
      details: { groups: r.additionalStats.Groups, outcomes: a.outcome_columns, n: rows.length },
      interpretation: v.text + (v.significant ? ' Follow up with ANOVA on each outcome to see which differ.' : ''),
      warnings: rows.length < 10 * a.outcome_columns.length ? ['Small sample for the number of outcomes; results are unstable.'] : [],
    },
    summary: [
      `One-way MANOVA: ${a.outcome_columns.join(', ')} by ${a.group_column}`,
      `Wilks' Λ = ${fmt(r.additionalStats["Wilks' Λ"])}, F(${fmt(df1)}, ${fmt(df2)}) = ${fmt(r.testStatistic)}, ${formatPEq(r.pValue)}`,
      v.text,
    ],
  };
}

// ------------------------------------------------------------------ describe / CI / power / inspect

async function describe(a) {
  let sets;
  if (a.file) {
    if (!a.column) throw new UserError('describe from a file needs column.');
    const table = await loadTable(a.file);
    if (a.group_column) sets = [...groupValues(table, a.column, a.group_column)].map(([name, values]) => ({ name, values }));
    else sets = [{ name: a.column, values: numericColumn(table, a.column) }];
  } else sets = [{ name: a.name || 'values', values: a.values }];
  if (sets.length > 50) throw new UserError('Over 50 groups; is group_column really categorical?');
  for (const s of sets) checkSample(s.values, s.name, 1);
  const out = sets.map((s) => ({ name: s.name, ...summarize(s.values, a.confidence) }));
  return {
    data: { descriptives: out },
    summary: out.flatMap((s) => [
      `${s.name}: n = ${s.n}, mean = ${fmt(s.mean)}, SD = ${fmt(s.std_dev)}, median = ${fmt(s.median)}, IQR [${fmt(s.q1)}, ${fmt(s.q3)}], range [${fmt(s.min)}, ${fmt(s.max)}]`,
      ...(s.mean_ci ? [`  ${Math.round(a.confidence * 100)}% CI for mean [${fmt(s.mean_ci.lower)}, ${fmt(s.mean_ci.upper)}]`] : []),
      ...(s.shape ? [`  Shape: ${s.shape.label} (skewness ${fmt(s.skewness, 3)}, excess kurtosis ${fmt(s.excess_kurtosis, 3)})`] : []),
    ]),
  };
}

async function confidenceInterval(a) {
  if (a.type === 'proportion') {
    const { successes: k, n } = a;
    if (!Number.isInteger(k) || !Number.isInteger(n) || n < 1 || k < 0 || k > n) throw new UserError('Need whole numbers with 0 ≤ successes ≤ n.');
    const ci = proportionCI(k, n, a.confidence);
    return {
      data: { confidence_interval: { of: 'proportion', method: 'Wilson score', level: a.confidence, estimate: k / n, lower: ci.lower, upper: ci.upper } },
      summary: [`Proportion ${k}/${n} = ${fmt(k / n)}; ${Math.round(a.confidence * 100)}% Wilson CI [${fmt(ci.lower)}, ${fmt(ci.upper)}]`],
    };
  }
  let values = a.values;
  if (a.file) { if (!a.column) throw new UserError('column is required with file.'); values = numericColumn(await loadTable(a.file), a.column); }
  checkSample(values, 'values');
  checkVaries(values, 'values');
  const s = summarize(values, a.confidence);
  return {
    data: { confidence_interval: { of: 'mean', method: 't distribution', level: a.confidence, estimate: s.mean, lower: s.mean_ci.lower, upper: s.mean_ci.upper, n: s.n, std_error: s.std_error } },
    summary: [`Mean = ${fmt(s.mean)} (n = ${s.n}); ${Math.round(a.confidence * 100)}% CI [${fmt(s.mean_ci.lower)}, ${fmt(s.mean_ci.upper)}]`],
  };
}

async function powerAnalysis(a) {
  const two = a.alternative === 'two-sided';
  const d = a.effect_size;
  const note = 'Two-sample t-test, equal group sizes, normal approximation (typically within about 0.01 of exact power; exact sample sizes can be 1 to 2 higher per group for small n).';
  const given = ['effect_size', 'n_per_group', 'power'].filter((k) => a[k] != null);
  if (given.length !== 2) throw new UserError('Give exactly two of effect_size, n_per_group and power; the third is solved for.');
  if (a.power != null) checkLevel(a.power, 'power');
  if (d != null && !(d > 0)) throw new UserError('effect_size (Cohen\'s d) must be positive.');
  if (a.n_per_group != null && !(a.n_per_group >= 2)) throw new UserError('n_per_group must be at least 2.');
  const powerOf = (dd, n) => tTestPower(dd, n, a.alpha, two);
  let result;
  if (a.power == null) {
    result = { solved_for: 'power', power: powerOf(d, a.n_per_group), effect_size: d, n_per_group: a.n_per_group };
  } else if (a.n_per_group == null) {
    let n = 2;
    while (powerOf(d, n) < a.power && n < 1e7) n = n < 1000 ? n + 1 : Math.ceil(n * 1.01);
    if (n >= 1e7) throw new UserError('Required sample size exceeds 10 million per group.');
    result = { solved_for: 'n_per_group', n_per_group: n, total_n: 2 * n, achieved_power: powerOf(d, n), effect_size: d, power: a.power };
  } else {
    let lo = 1e-6, hi = 10;
    if (powerOf(hi, a.n_per_group) < a.power) throw new UserError('Even d = 10 does not reach that power with this n.');
    for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (powerOf(mid, a.n_per_group) < a.power) lo = mid; else hi = mid; }
    result = { solved_for: 'effect_size', effect_size: hi, magnitude: magnitude.d(hi), n_per_group: a.n_per_group, power: a.power };
  }
  const line = result.solved_for === 'power'
    ? `Power = ${fmt(result.power, 3)} to detect d = ${d} with ${a.n_per_group} per group`
    : result.solved_for === 'n_per_group'
      ? `Need ${result.n_per_group} per group (${result.total_n} total) for ${a.power} power to detect d = ${d}`
      : `Smallest detectable d = ${fmt(result.effect_size, 3)} (${result.magnitude}) with ${a.n_per_group} per group at ${a.power} power`;
  return { data: { ...result, alpha: a.alpha, alternative: a.alternative, method: note }, summary: [`Power analysis (α = ${a.alpha}, ${a.alternative})`, line, `Note: ${note}`] };
}

async function inspectFile(a) {
  const table = await loadTable(a.file);
  const columns = table.headers.map((h) => {
    const vals = table.rows.map((r) => r[h]);
    const present = vals.filter((v) => !isMissing(v));
    const nums = present.map(toNumber);
    const numeric = present.length > 0 && nums.every((v) => v !== null);
    const col = { name: h, type: numeric ? 'numeric' : 'categorical', non_missing: present.length, missing: vals.length - present.length };
    if (numeric) Object.assign(col, { min: nums.reduce((m, v) => (v < m ? v : m), Infinity), max: nums.reduce((m, v) => (v > m ? v : m), -Infinity), mean: mean(nums) });
    const counts = new Map();
    for (const v of present) { const k = categoryKey(v); counts.set(k, (counts.get(k) || 0) + 1); }
    col.distinct = counts.size;
    if (!numeric || counts.size <= 10) col.top_values = [...counts].sort((p, q) => q[1] - p[1]).slice(0, 10).map(([value, count]) => ({ value, count }));
    if (!numeric && present.some((v) => toNumber(v) !== null)) col.note = 'Mixes numbers and text; tools that need numbers will reject it.';
    return col;
  });
  return {
    data: { file: table.path, ...(table.sheetName ? { sheet: table.sheetName } : {}), rows: table.rows.length, columns, preview: table.rows.slice(0, 5), notes: table.warnings || [] },
    summary: [
      `${table.path}${table.sheetName ? ` (sheet "${table.sheetName}")` : ''}: ${table.rows.length} rows, ${columns.length} columns`,
      ...(table.warnings || []).map((w) => `  Note: ${w}`),
      ...columns.map((c) => `  ${c.name} (${c.type}${c.missing ? `, ${c.missing} missing` : ''}${c.type === 'numeric' ? `, ${fmt(c.min)} to ${fmt(c.max)}` : `, ${c.distinct} distinct: ${c.top_values.slice(0, 5).map((t) => (/[,"]/.test(t.value) ? JSON.stringify(t.value) : t.value)).join(', ')}${c.distinct > 5 ? ', …' : ''}`})`),
    ],
  };
}

async function chooseTest(a) {
  const pick = (tool, args, why, also = []) => ({ tool, suggested_arguments: args, why, assumptions: also });
  let rec;
  const g = a.goal;
  if (g === 'compare_mean_to_value') rec = a.known_population_sd
    ? pick('z_test', { type: 'mean' }, 'One numeric sample against a target value, with σ known from outside the sample.', ['Values independent', 'σ genuinely known'])
    : pick('t_test', { type: 'one_sample' }, 'One numeric sample against a target value; σ estimated from the data.', ['Values independent', 'Roughly normal, or n ≥ 30']);
  else if (g === 'compare_proportion_to_value') rec = pick('binomial_test', {}, 'A yes/no outcome against a target rate. Exact for any n (use z_test proportion only for very large n).', ['Trials independent with the same probability']);
  else if (g === 'compare_two_groups') rec = a.paired
    ? pick('t_test', { type: 'paired' }, 'Same subjects measured twice (or matched pairs).', ['Differences roughly normal, or ≥ 30 pairs'])
    : pick('t_test', { type: 'independent', equal_variances: false }, "Two separate groups; Welch's version does not assume equal variances.", ['Observations independent', 'Each group roughly normal, or n ≥ 30 each']);
  else if (g === 'compare_three_plus_groups') rec = a.multiple_outcomes
    ? pick('manova', {}, 'Several numeric outcomes compared across groups at once.', ['Multivariate normality', 'Equal covariance matrices'])
    : a.has_covariate
      ? pick('ancova', {}, 'Compare groups on one outcome while adjusting for a numeric covariate.', ['Same covariate slope in every group', 'Residuals roughly normal'])
      : pick('anova', { pairwise: true }, 'One numeric outcome across 3 or more groups.', ['Independent groups', 'Similar variances', 'Roughly normal within groups']);
  else if (g === 'relationship_two_numeric') rec = pick('correlation', { method: a.outliers_or_ranks ? 'spearman' : 'pearson' },
    a.outliers_or_ranks ? 'Monotonic relationship, robust to outliers and ranks.' : 'Linear relationship between two numeric variables.', ['Pairs independent']);
  else if (g === 'association_two_categorical') rec = pick('chi_square', { type: 'independence' }, "Whether two categorical variables are related. For a 2×2 table with small counts, use fisher_exact.", ['Expected counts ≥ 5 in most cells']);
  else if (g === 'counts_vs_expected_distribution') rec = pick('chi_square', { type: 'goodness_of_fit' }, 'Whether category counts match expected proportions.', ['Expected counts ≥ 5']);
  else if (g === 'plan_sample_size') rec = pick('power_analysis', {}, 'Choose a sample size before collecting data.', []);
  else rec = pick('describe', {}, 'Start by summarising the data.', []);
  if (a.has_covariate && g === 'compare_two_groups' && !a.paired) rec = pick('ancova', {}, 'Two groups compared on one outcome while adjusting for a numeric covariate.', ['Same covariate slope in every group']);
  return { data: rec, summary: [`Recommended: ${rec.tool} ${Object.keys(rec.suggested_arguments).length ? JSON.stringify(rec.suggested_arguments) : ''}`.trim(), rec.why, ...(rec.assumptions.length ? [`Assumptions: ${rec.assumptions.join('; ')}`] : [])] };
}

// ------------------------------------------------------------------ tool table

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: 'choose_test', title: 'Choose a statistical test',
    description: 'Recommends which test tool to run for a research question, with the assumptions to check. Call this first when unsure.',
    inputSchema: {
      goal: z.enum(['compare_mean_to_value', 'compare_proportion_to_value', 'compare_two_groups', 'compare_three_plus_groups', 'relationship_two_numeric', 'association_two_categorical', 'counts_vs_expected_distribution', 'plan_sample_size', 'describe_data']),
      paired: z.boolean().default(false).describe('Same subjects measured twice / matched pairs.'),
      has_covariate: z.boolean().default(false).describe('A numeric variable to adjust for.'),
      multiple_outcomes: z.boolean().default(false).describe('Several numeric outcomes analysed together.'),
      known_population_sd: z.boolean().default(false),
      outliers_or_ranks: z.boolean().default(false).describe('Data are ranks, ordinal, or have strong outliers.'),
    },
    run: chooseTest,
  },
  {
    name: 'inspect_data_file', title: 'Inspect a data file',
    description: 'Lists the columns of a local CSV/TSV/JSON file with their types, missing values, ranges and category values, plus a 5-row preview. Use before running tests on a file so you pass correct column and group names.',
    inputSchema: { file: z.string().describe('Path to a CSV, TSV or JSON file.') },
    run: inspectFile,
  },
  {
    name: 'describe', title: 'Descriptive statistics',
    description: 'n, mean, SD, SE, median, quartiles, range, skewness, excess kurtosis, distribution shape and a t-based CI for the mean. Inline values, or a file column optionally split by group_column.',
    inputSchema: { values: numArray.optional(), name: z.string().optional(), file, column: z.string().optional(), group_column: z.string().optional(), confidence },
    run: describe,
  },
  {
    name: 't_test', title: 't-test',
    description: 'One-sample, paired, or independent two-sample t-test (Welch by default; set equal_variances true for Student). Returns t, df, p, CI, Cohen\'s d and assumption warnings. Data inline (sample1/sample2) or from a file: one_sample uses column; paired uses column + column2; independent uses column + group_column (+ group1, group2) or column + column2.',
    inputSchema: {
      type: z.enum(['one_sample', 'paired', 'independent']),
      sample1: numArray.optional(), sample2: numArray.optional(),
      mu0: num.default(0).describe('Hypothesised mean for one_sample.'),
      equal_variances: z.boolean().default(false).describe("false (default) = Welch's t-test; true = Student's pooled t-test."),
      file, column: z.string().optional(), column2: z.string().optional(), group_column: z.string().optional(),
      group1: z.string().optional().describe('Name of the first group (label in results; or category value in group_column).'),
      group2: z.string().optional(),
      alternative, alpha, confidence,
    },
    run: tTest,
  },
  {
    name: 'z_test', title: 'z-test',
    description: 'One-proportion z-test (successes, n, p0) or one-sample mean z-test with a known population SD (values or sample_mean + n, population_sd, mu0).',
    inputSchema: {
      type: z.enum(['proportion', 'mean']),
      successes: z.number().int().optional(), n: z.number().optional(), p0: z.number().optional(),
      values: numArray.optional(), sample_mean: num.optional(), population_sd: num.optional(), mu0: num.optional(),
      alternative, alpha, confidence,
    },
    run: zTest,
  },
  {
    name: 'anova', title: 'One-way ANOVA',
    description: 'One-way ANOVA across 2+ groups with eta²/omega², group summaries and optional Bonferroni-adjusted pairwise Welch t-tests. Inline groups [{name, values}] or file + column + group_column.',
    inputSchema: {
      groups: z.array(z.object({ name: z.string().optional(), values: numArray })).optional(),
      file, column: z.string().optional(), group_column: z.string().optional(),
      groups_to_include: z.array(z.string()).optional().describe('Subset of group_column categories to compare.'),
      pairwise: z.boolean().default(false), alpha, confidence,
    },
    run: anova,
  },
  {
    name: 'chi_square', title: 'Chi-square test',
    description: 'goodness_of_fit: observed counts vs expected (proportions or counts; uniform if omitted), inline or by counting a file column. independence: contingency table inline or cross-tabulated from two categorical file columns; returns Cramér\'s V and expected counts. No continuity correction.',
    inputSchema: {
      type: z.enum(['goodness_of_fit', 'independence']),
      observed: z.array(z.number()).optional(), expected: z.array(z.number()).optional(), categories: z.array(z.string()).optional(),
      expected_by_category: z.record(z.string(), z.number()).optional().describe('For file mode: expected proportion or count per category value.'),
      table: z.array(z.array(z.number())).optional(), row_labels: z.array(z.string()).optional(), col_labels: z.array(z.string()).optional(),
      file, column: z.string().optional(), row_column: z.string().optional(), col_column: z.string().optional(),
      alpha,
    },
    run: chiSquare,
  },
  {
    name: 'fisher_exact', title: "Fisher's exact test",
    description: "Exact test of association for a 2×2 table; use instead of chi_square when expected counts are small. Inline table [[a,b],[c,d]] or two binary file columns (row_column, col_column).",
    inputSchema: {
      table: z.array(z.array(z.number().int())).optional(), row_labels: z.array(z.string()).optional(), col_labels: z.array(z.string()).optional(),
      file, row_column: z.string().optional(), col_column: z.string().optional(), alternative, alpha,
    },
    run: fisherExact,
  },
  {
    name: 'binomial_test', title: 'Exact binomial test',
    description: 'Exact test of a success count against a hypothesised probability, with a Wilson CI.',
    inputSchema: { successes: z.number().int(), trials: z.number().int(), p0: z.number().default(0.5), alternative, alpha, confidence },
    run: binomialTest,
  },
  {
    name: 'correlation', title: 'Correlation',
    description: "Pearson (linear) or Spearman (rank) correlation with p-value, Fisher CI (Pearson) and least-squares line. Inline x/y or file + x_column + y_column (rows missing either are dropped).",
    inputSchema: {
      x: numArray.optional(), y: numArray.optional(), x_name: z.string().optional(), y_name: z.string().optional(),
      file, x_column: z.string().optional(), y_column: z.string().optional(),
      method: z.enum(['pearson', 'spearman']).default('pearson'), alternative, alpha, confidence,
    },
    run: correlation,
  },
  {
    name: 'ancova', title: 'One-way ANCOVA',
    description: 'Compares group means on an outcome after adjusting for one numeric covariate. Data from file or rows (array of objects).',
    inputSchema: {
      file, rows: z.array(z.record(z.string(), z.any())).optional(),
      group_column: z.string(), outcome_column: z.string(), covariate_column: z.string(), alpha,
    },
    run: ancova,
  },
  {
    name: 'manova', title: 'One-way MANOVA',
    description: "Compares groups on 2+ numeric outcomes jointly (Wilks' lambda with Rao's F). Data from file or rows.",
    inputSchema: {
      file, rows: z.array(z.record(z.string(), z.any())).optional(),
      group_column: z.string(), outcome_columns: z.array(z.string()), alpha,
    },
    run: manova,
  },
  {
    name: 'confidence_interval', title: 'Confidence interval',
    description: 'CI for a mean (t distribution; values or file + column) or a proportion (Wilson; successes + n).',
    inputSchema: {
      type: z.enum(['mean', 'proportion']), values: numArray.optional(), file, column: z.string().optional(),
      successes: z.number().int().optional(), n: z.number().int().optional(), confidence,
    },
    run: confidenceInterval,
  },
  {
    name: 'power_analysis', title: 'Power analysis',
    description: "Two-sample t-test power. Give two of effect_size (Cohen's d), n_per_group, power; the third is solved. Normal approximation.",
    inputSchema: {
      effect_size: z.number().optional(), n_per_group: z.number().int().optional(), power: z.number().optional(),
      alpha, alternative: z.enum(['two-sided', 'one-sided']).default('two-sided'),
    },
    run: powerAnalysis,
  },
].map((t) => ({ ...t, annotations: { title: t.title, ...RO } }));

// Exposed for tests.
export const _internal = { ranks, pearson, crosstab };

/** Implementations by name, for the guided workflow. */
export const IMPL = { tTest, zTest, anova, chiSquare, fisherExact, binomialTest, correlation, ancova, manova, describe, confidenceInterval, powerAnalysis, inspectFile, chooseTest };
