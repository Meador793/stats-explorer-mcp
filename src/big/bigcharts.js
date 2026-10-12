// Charts for large (streamed) files. When the values fit (acc.js EXACT_CAP) the normal chart code
// draws them, identically; otherwise histogram bars and box-plot quartiles come from the KLL sketch
// and a scatter plot shows a random sample of points with the exact least-squares line.
import { accumulate } from './service.js';
import { UserError } from '../errors.js';
import { histogram, histogramFromBins, boxPlot, boxPlotFromStats, scatter, bar, line, pie } from '../charts.js';
import { linearRegression } from '../engine/regression.js';
import { mean } from '../engine/statsUtils.js';
import { isNumericColumn } from '../data.js';
import { isExact, sMedian, sQuantile, sOutliersIQR, sMean } from './sumstats.js';
import { kllHistogram, kllInside, kllTail } from './kll.js';
import { checkBad, fitFromPair } from './bigtools.js';

const toUser = (e) => (e instanceof UserError ? e : new UserError(e?.message || String(e)));
async function acc(path, specs) { try { return await accumulate(path, specs); } catch (e) { throw toUser(e); } }

function meta(out, m, approximate) {
  out.data = { ...out.data, large_file: { rows_read: m.rows, from_cache: !!m.fromCache, ...(m.sampled ? { sampled_fraction: m.sampled.fraction } : {}), ...(approximate ? { approximate } : {}) } };
  return out;
}

function boxStats(name, S) {
  const q1 = sQuantile(S, 0.25), q3 = sQuantile(S, 0.75), iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
  let [wMin, wMax] = kllInside(S.kll, lo, hi);
  if (S.min >= lo) wMin = S.min;
  if (S.max <= hi) wMax = S.max;
  return { name, n: S.n, min: wMin, q1, median: sMedian(S), q3, max: wMax, mean: sMean(S), outliers: kllTail(S.kll, lo, hi, 60), outlierCount: sOutliersIQR(S) };
}

export async function bigChart(chart, v, table, a, t) {
  const path = table.path;
  if (chart === 'histogram') {
    const { states: [st], meta: m } = await acc(path, [{ type: 'num', col: v.column }]);
    checkBad(st);
    const S = st.s;
    if (S.n === 0) throw new UserError(`${v.column} has no numeric values.`);
    if (isExact(S)) return meta(histogram(S.exact, { title: t, column: v.column, bins: a.bins }), m);
    const k = a.bins || Math.max(5, Math.min(30, Math.ceil(Math.log2(S.n) + 1)));
    const w = (S.max - S.min) / k || 1;
    const counts = kllHistogram(S.kll, Array.from({ length: k + 1 }, (_, i) => S.min + i * w)).map(Math.round);
    return meta(histogramFromBins({ lo: S.min, w, counts, mean: S.mean, median: sMedian(S), n: S.n, note: 'bar heights estimated from a quantile sketch' }, { title: t, column: v.column }), m, ['bar heights', 'median']);
  }
  if (chart === 'box_plot') {
    const r = v.group_column
      ? await acc(path, [{ type: 'grouped', col: v.column, by: v.group_column }])
      : await acc(path, [{ type: 'num', col: v.column }]);
    checkBad(r.states[0]);
    const groups = v.group_column ? [...r.states[0].groups].map(([name, S]) => ({ name, S })) : [{ name: v.column, S: r.states[0].s }];
    if (groups.length > 20) throw new UserError(`${v.group_column} has ${groups.length} groups; a box plot is readable up to about 20.`);
    if (groups.every((g) => isExact(g.S))) return meta(boxPlot(groups.map((g) => ({ name: g.name, values: g.S.exact })), { title: t, column: v.column, groupColumn: v.group_column }), r.meta);
    const stats = groups.map((g) => boxStats(g.name, g.S));
    const lo = Math.min(...groups.map((g) => g.S.min)), hi = Math.max(...groups.map((g) => g.S.max));
    return meta(boxPlotFromStats(stats, lo, hi, { title: t, column: v.column, groupColumn: v.group_column, note: 'quartiles estimated; some outliers shown' }), r.meta, ['quartiles', 'whisker ends', 'outlier counts']);
  }
  if (chart === 'scatter') {
    const { states: [st], meta: m } = await acc(path, [{ type: 'pair', x: v.x_column, y: v.y_column }]);
    checkBad(st);
    if (st.n < 2) throw new UserError('Need at least 2 rows with both values.');
    if (isExact(st.x) && isExact(st.y)) {
      const x = st.x.exact, y = st.y.exact;
      return meta(scatter(x, y, { title: t, xName: v.x_column, yName: v.y_column, fit: linearRegression(x.map((xi, i) => ({ x: xi, y: y[i] }))) }), m);
    }
    const pts = st.res.items.slice(0, 2000);
    return meta(scatter(pts.map((p) => p[0]), pts.map((p) => p[1]), { title: t, xName: v.x_column, yName: v.y_column, fit: fitFromPair(st), n: st.n, sampleNote: `showing a random sample of ${pts.length} points` }), m);
  }
  // bar, line, pie
  const xNum = isNumericColumn(table, v.x_column);
  if (v.y_column && !isNumericColumn(table, v.y_column)) throw new UserError(`${v.y_column} is not numeric.`);
  let keys, vals, counts, m;
  if (v.y_column) {
    const r = await acc(path, [{ type: 'grouped', col: v.y_column, by: v.x_column }]);
    checkBad(r.states[0]); m = r.meta;
    const g = r.states[0].groups;
    const entries = [...g].map(([k, S]) => [chart === 'line' && xNum ? Number(k) : k, S]);
    if (chart === 'line') entries.sort((p, q) => (xNum ? p[0] - q[0] : 0));
    keys = entries.map((e) => e[0]);
    vals = entries.map(([, S]) => (chart === 'pie' ? (isExact(S) ? S.exact.reduce((s, x) => s + x, 0) : S.mean * S.n) : (isExact(S) ? mean(S.exact) : S.mean)));
    counts = entries.map(([, S]) => S.n);
  } else {
    const r = await acc(path, [{ type: 'counts', col: v.x_column }]);
    m = r.meta;
    const entries = [...r.states[0].counts].map(([k, c]) => [chart === 'line' && xNum ? Number(k) : k, c]);
    if (chart === 'line') entries.sort((p, q) => (xNum ? p[0] - q[0] : 0));
    keys = entries.map((e) => e[0]); vals = entries.map((e) => e[1]); counts = vals.slice();
  }
  if (chart !== 'line' && keys.length > 40) throw new UserError(`${v.x_column} has ${keys.length} categories; pick a column with fewer (bar/pie charts stay readable up to about 40 / 8).`);
  let out;
  if (chart === 'bar') out = bar(keys, vals, { title: t || (v.y_column ? `Mean ${v.y_column} by ${v.x_column}` : `Count by ${v.x_column}`), xName: v.x_column, yLabel: v.y_column ? `Mean ${v.y_column}` : 'Count', counts, note: v.y_column ? 'Bar height = mean of each category' : 'Number of rows per category' });
  else if (chart === 'pie') {
    if (vals.some((x) => x < 0)) throw new UserError('A pie chart needs non-negative values.');
    out = pie(keys, vals, { title: t || (v.y_column ? `Share of ${v.y_column} by ${v.x_column}` : `Rows by ${v.x_column}`), note: v.y_column ? `Slice = sum of ${v.y_column}` : 'Slice = number of rows' });
  } else out = line(keys, vals, { title: t || `${v.y_column} by ${v.x_column}`, xName: v.x_column, yName: v.y_column, categorical: !xNum, note: counts.some((n) => n > 1) ? 'Mean of y at each x' : '' });
  return meta(out, m);
}
