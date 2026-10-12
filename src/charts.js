// Static SVG charts for reports: histogram, box plot, scatter, bar, line, pie (the app's chart types,
// plus the box plot from its Data Visualization tab). Colours are CSS variables with light-mode
// fallbacks, so the HTML report can switch them for dark mode and a standalone .svg still renders.
// Mark specs follow the dataviz reference: bars ≤ 24px with a 4px rounded data end, 2px lines,
// ≥ 8px markers with a surface ring, recessive grid, text in text colours, a <title> tooltip per mark.
import { mean, median, percentile, fmt } from './stats.js';

export const CATEGORICAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const CATEGORICAL_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const W = 720, H = 420, M = { l: 72, r: 28, t: 56, b: 72 };
const PW = W - M.l - M.r, PH = H - M.t - M.b;
const C = {
  surface: 'var(--surface-1, #fcfcfb)', text: 'var(--text-primary, #0b0b0b)', muted: 'var(--text-secondary, #52514e)',
  grid: 'var(--grid, #e6e5e1)', axis: 'var(--axis, #b9b8b2)', s1: 'var(--series-1, #2a78d6)', ref: 'var(--text-secondary, #52514e)',
};
const series = (i) => `var(--series-${i + 1}, ${CATEGORICAL[i]})`;

const minOf = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = (x) => Math.round(x * 100) / 100;

function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
  const step0 = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { ticks, lo: start, hi: end };
}

const linear = (d0, d1, r0, r1) => (v) => (d1 === d0 ? (r0 + r1) / 2 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

function frame(title, subtitle, body, { xLabel, yLabel } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">
<title>${esc(title)}</title>
<rect width="${W}" height="${H}" fill="${C.surface}"/>
<text x="${M.l}" y="26" font-size="16" font-weight="600" fill="${C.text}">${esc(title)}</text>
${subtitle ? `<text x="${M.l}" y="45" font-size="12" fill="${C.muted}">${esc(subtitle)}</text>` : ''}
${body}
${xLabel ? `<text x="${M.l + PW / 2}" y="${H - 18}" font-size="12" text-anchor="middle" fill="${C.muted}">${esc(xLabel)}</text>` : ''}
${yLabel ? `<text transform="translate(18 ${M.t + PH / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${C.muted}">${esc(yLabel)}</text>` : ''}
</svg>`;
}

function yAxis(ticks, y) {
  return ticks.map((t) => `<line x1="${M.l}" x2="${M.l + PW}" y1="${n2(y(t))}" y2="${n2(y(t))}" stroke="${C.grid}" stroke-width="1"/><text x="${M.l - 8}" y="${n2(y(t)) + 4}" font-size="11" text-anchor="end" fill="${C.muted}">${esc(fmt(t, 4))}</text>`).join('');
}
function xAxisNumeric(ticks, x) {
  return `<line x1="${M.l}" x2="${M.l + PW}" y1="${M.t + PH}" y2="${M.t + PH}" stroke="${C.axis}"/>` +
    ticks.map((t) => `<text x="${n2(x(t))}" y="${M.t + PH + 18}" font-size="11" text-anchor="middle" fill="${C.muted}">${esc(fmt(t, 4))}</text>`).join('');
}
function xAxisBands(labels, cx) {
  const longest = Math.max(...labels.map((l) => Math.min(18, String(l).length)));
  const rotate = longest * 6.4 > (PW / labels.length) * 0.9;
  return `<line x1="${M.l}" x2="${M.l + PW}" y1="${M.t + PH}" y2="${M.t + PH}" stroke="${C.axis}"/>` +
    labels.map((l, i) => {
      const t = String(l).length > 18 ? `${String(l).slice(0, 17)}…` : String(l);
      return rotate
        ? `<text transform="translate(${n2(cx(i))} ${M.t + PH + 12}) rotate(-35)" font-size="11" text-anchor="end" fill="${C.muted}">${esc(t)}</text>`
        : `<text x="${n2(cx(i))}" y="${M.t + PH + 18}" font-size="11" text-anchor="middle" fill="${C.muted}">${esc(t)}</text>`;
    }).join('');
}

/** Vertical bar from the baseline with a 4px rounded data end (square at the baseline). */
function barPath(x, w, yBase, yVal) {
  const h = Math.abs(yBase - yVal), r = Math.min(4, h, w / 2), up = yVal < yBase;
  if (h === 0) return '';
  if (up) return `M${n2(x)},${n2(yBase)} V${n2(yVal + r)} Q${n2(x)},${n2(yVal)} ${n2(x + r)},${n2(yVal)} H${n2(x + w - r)} Q${n2(x + w)},${n2(yVal)} ${n2(x + w)},${n2(yVal + r)} V${n2(yBase)} Z`;
  return `M${n2(x)},${n2(yBase)} V${n2(yVal - r)} Q${n2(x)},${n2(yVal)} ${n2(x + r)},${n2(yVal)} H${n2(x + w - r)} Q${n2(x + w)},${n2(yVal)} ${n2(x + w)},${n2(yVal - r)} V${n2(yBase)} Z`;
}

// Reference line through the plot; its label goes in a key above the plot so it never sits on a bar.
const refLine = (x, dash) => `<line x1="${n2(x)}" x2="${n2(x)}" y1="${M.t}" y2="${M.t + PH}" stroke="${C.ref}" stroke-width="1.5" stroke-dasharray="${dash}"/>`;
const refKey = (items) => {
  let x = M.l + PW;
  return items.slice().reverse().map(([label, dash]) => {
    const w = label.length * 6.4 + 30; x -= w;
    return `<line x1="${n2(x)}" x2="${n2(x + 20)}" y1="${M.t - 10}" y2="${M.t - 10}" stroke="${C.ref}" stroke-width="1.5" stroke-dasharray="${dash}"/><text x="${n2(x + 25)}" y="${M.t - 6}" font-size="11" fill="${C.muted}">${esc(label)}</text>`;
  }).join('');
};

// ------------------------------------------------------------------ charts

export function histogram(values, { title, column, bins }) {
  const lo = minOf(values), hi = maxOf(values);
  const k = bins || Math.max(5, Math.min(30, Math.ceil(Math.log2(values.length) + 1)));
  const w = (hi - lo) / k || 1;
  const counts = new Array(k).fill(0);
  for (const v of values) counts[Math.min(k - 1, Math.floor((v - lo) / w))]++;
  return histogramFromBins({ lo, w, counts, mean: mean(values), median: median(values), n: values.length }, { title, column });
}

/** Draws a histogram from bin counts (bins of width w starting at lo). */
export function histogramFromBins({ lo, w, counts, mean: m, median: md, n, note }, { title, column }) {
  const k = counts.length, hi = lo + k * w;
  const edges = counts.map((_, i) => [lo + i * w, lo + (i + 1) * w]);
  const xs = niceTicks(lo, hi, 6), ys = niceTicks(0, maxOf(counts), 5);
  const x = linear(xs.lo, xs.hi, M.l, M.l + PW), y = linear(0, ys.hi, M.t + PH, M.t);
  const bw = Math.max(1, x(lo + w) - x(lo) - 2);
  const bars = counts.map((c, i) => `<path d="${barPath(x(edges[i][0]) + 1, bw, y(0), y(c))}" fill="${C.s1}"><title>${esc(`${fmt(edges[i][0], 4)} to ${fmt(edges[i][1], 4)}: ${c}`)}</title></path>`).join('');
  const body = yAxis(ys.ticks, y) + xAxisNumeric(xs.ticks, x) + bars + refLine(x(m), '6 4') + refLine(x(md), '2 3') + refKey([[`mean ${fmt(m, 4)}`, '6 4'], [`median ${fmt(md, 4)}`, '2 3']]);
  return {
    svg: frame(title || `Distribution of ${column}`, `n = ${n}, ${k} bins${note ? `; ${note}` : ''}`, body, { xLabel: column, yLabel: 'Count' }),
    data: { bins: counts.map((c, i) => ({ from: edges[i][0], to: edges[i][1], count: c })), mean: m, median: md, n },
  };
}

function fiveNum(v) {
  const q1 = percentile(v, 0.25), q3 = percentile(v, 0.75), iqr = q3 - q1;
  const inside = v.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
  return {
    n: v.length, min: minOf(inside), q1, median: median(v), q3, max: maxOf(inside), mean: mean(v),
    outliers: v.filter((x) => x < q1 - 1.5 * iqr || x > q3 + 1.5 * iqr),
  };
}

export function boxPlot(groups, opts) {
  const stats = groups.map((g) => ({ name: g.name, ...fiveNum(g.values) }));
  const all = groups.flatMap((g) => g.values);
  return boxPlotFromStats(stats, minOf(all), maxOf(all), opts);
}

/**
 * Draws box plots from five-number summaries: { name, n, min, q1, median, q3, max, mean, outliers }
 * (min/max = whisker ends; outliers = values to draw; outlierCount if more exist than are drawn).
 */
export function boxPlotFromStats(stats, lo, hi, { title, column, groupColumn, note }) {
  const ys = niceTicks(lo, hi, 5);
  const y = linear(ys.lo, ys.hi, M.t + PH, M.t);
  const band = PW / stats.length, bw = Math.min(56, band * 0.5);
  const cx = (i) => M.l + band * (i + 0.5);
  const boxes = stats.map((s, i) => {
    const c = cx(i);
    const tip = esc(`${s.name}: median ${fmt(s.median, 4)}, Q1 ${fmt(s.q1, 4)}, Q3 ${fmt(s.q3, 4)}, mean ${fmt(s.mean, 4)}, n = ${s.n}`);
    return `<g><title>${tip}</title>
<line x1="${n2(c)}" x2="${n2(c)}" y1="${n2(y(s.max))}" y2="${n2(y(s.q3))}" stroke="${C.muted}" stroke-width="1.5"/><line x1="${n2(c)}" x2="${n2(c)}" y1="${n2(y(s.q1))}" y2="${n2(y(s.min))}" stroke="${C.muted}" stroke-width="1.5"/>
<line x1="${n2(c - bw / 4)}" x2="${n2(c + bw / 4)}" y1="${n2(y(s.max))}" y2="${n2(y(s.max))}" stroke="${C.muted}" stroke-width="1.5"/><line x1="${n2(c - bw / 4)}" x2="${n2(c + bw / 4)}" y1="${n2(y(s.min))}" y2="${n2(y(s.min))}" stroke="${C.muted}" stroke-width="1.5"/>
<rect x="${n2(c - bw / 2)}" y="${n2(y(s.q3))}" width="${n2(bw)}" height="${n2(Math.max(1, y(s.q1) - y(s.q3)))}" rx="4" fill="${C.s1}" fill-opacity="0.18" stroke="${C.s1}" stroke-width="2"/>
<line x1="${n2(c - bw / 2)}" x2="${n2(c + bw / 2)}" y1="${n2(y(s.median))}" y2="${n2(y(s.median))}" stroke="${C.s1}" stroke-width="3"/>
<path d="M${n2(c)},${n2(y(s.mean) - 5)} l5,5 l-5,5 l-5,-5 Z" fill="${C.surface}" stroke="${C.text}" stroke-width="1.5"/>
${s.outliers.map((o) => `<circle cx="${n2(c)}" cy="${n2(y(o))}" r="4" fill="${C.s1}" stroke="${C.surface}" stroke-width="2"><title>${esc(`${s.name} outlier: ${fmt(o, 4)}`)}</title></circle>`).join('')}</g>`;
  }).join('');
  const legend = `<path d="M${M.l + PW - 120},${M.t - 14} l5,5 l-5,5 l-5,-5 Z" fill="${C.surface}" stroke="${C.text}" stroke-width="1.5"/><text x="${M.l + PW - 110}" y="${M.t - 5}" font-size="11" fill="${C.muted}">mean; bar = median</text>`;
  const body = yAxis(ys.ticks, y) + xAxisBands(stats.map((s) => `${s.name} (n=${s.n})`), cx) + boxes + legend;
  return {
    svg: frame(title || (groupColumn ? `${column} by ${groupColumn}` : `Spread of ${column}`), `Box = middle 50% (Q1 to Q3); whiskers to 1.5×IQR; dots = outliers${note ? `; ${note}` : ''}`, body, { xLabel: groupColumn || '', yLabel: column }),
    data: { groups: stats.map(({ outliers, outlierCount, ...s }) => ({ ...s, outliers: outlierCount ?? outliers.length })) },
  };
}

export function scatter(xv, yv, { title, xName, yName, fit, n: nTotal, sampleNote }) {
  const xs = niceTicks(minOf(xv), maxOf(xv), 6), ys = niceTicks(minOf(yv), maxOf(yv), 5);
  const x = linear(xs.lo, xs.hi, M.l, M.l + PW), y = linear(ys.lo, ys.hi, M.t + PH, M.t);
  const stride = Math.ceil(xv.length / 2000);
  const pts = xv.map((xi, i) => [xi, yv[i]]).filter((_, i) => i % stride === 0)
    .map(([a, b]) => `<circle cx="${n2(x(a))}" cy="${n2(y(b))}" r="4" fill="${C.s1}" fill-opacity="0.75" stroke="${C.surface}" stroke-width="2"><title>${esc(`${xName} ${fmt(a, 4)}, ${yName} ${fmt(b, 4)}`)}</title></circle>`).join('');
  const line = fit ? `<line x1="${n2(x(xs.lo))}" y1="${n2(y(fit.intercept + fit.slope * xs.lo))}" x2="${n2(x(xs.hi))}" y2="${n2(y(fit.intercept + fit.slope * xs.hi))}" stroke="${C.text}" stroke-width="2" stroke-linecap="round"/>` : '';
  const clip = `<clipPath id="plot"><rect x="${M.l}" y="${M.t}" width="${PW}" height="${PH}"/></clipPath>`;
  const body = clip + yAxis(ys.ticks, y) + xAxisNumeric(xs.ticks, x) + `<g clip-path="url(#plot)">${pts}${line}</g>`;
  const sub = `n = ${nTotal ?? xv.length}${sampleNote ? `, ${sampleNote}` : stride > 1 ? `, showing every ${stride}th point` : ''}${fit ? `; line: ${fit.formula}, R² = ${fmt(fit.r2, 3)}` : ''}`;
  return { svg: frame(title || `${yName} vs ${xName}`, sub, body, { xLabel: xName, yLabel: yName }), data: { n: nTotal ?? xv.length, fit: fit && { slope: fit.slope, intercept: fit.intercept, r_squared: fit.r2 } } };
}

export function bar(labels, values, { title, xName, yLabel, note, counts }) {
  const lo = Math.min(0, minOf(values)), hi = Math.max(0, maxOf(values));
  const ys = niceTicks(lo, hi, 5);
  const y = linear(ys.lo, ys.hi, M.t + PH, M.t);
  const band = PW / labels.length, bw = Math.min(24, band * 0.6);
  const cx = (i) => M.l + band * (i + 0.5);
  const showLabels = labels.length <= 12;
  const bars = values.map((v, i) => `<path d="${barPath(cx(i) - bw / 2, bw, y(0), y(v))}" fill="${C.s1}"><title>${esc(`${labels[i]}: ${fmt(v, 4)}${counts ? ` (n = ${counts[i]})` : ''}`)}</title></path>${showLabels ? `<text x="${n2(cx(i))}" y="${n2(v >= 0 ? y(v) - 6 : y(v) + 14)}" font-size="11" text-anchor="middle" fill="${C.text}">${esc(fmt(v, 3))}</text>` : ''}`).join('');
  const body = yAxis(ys.ticks, y) + xAxisBands(labels, cx) + bars + `<line x1="${M.l}" x2="${M.l + PW}" y1="${n2(y(0))}" y2="${n2(y(0))}" stroke="${C.axis}"/>`;
  return { svg: frame(title, note, body, { xLabel: xName, yLabel }), data: { bars: labels.map((l, i) => ({ category: l, value: values[i], ...(counts ? { n: counts[i] } : {}) })) } };
}

export function line(xv, yv, { title, xName, yName, categorical, note }) {
  const ys = niceTicks(minOf(yv), maxOf(yv), 5);
  const y = linear(ys.lo, ys.hi, M.t + PH, M.t);
  let x, axis;
  if (categorical) {
    const band = PW / xv.length; x = (i) => M.l + band * (i + 0.5);
    axis = xAxisBands(xv.length > 24 ? xv.map((l, i) => (i % Math.ceil(xv.length / 24) === 0 ? l : '')) : xv, x);
  } else {
    const xs = niceTicks(minOf(xv), maxOf(xv), 6); const sx = linear(xs.lo, xs.hi, M.l, M.l + PW);
    x = (i) => sx(xv[i]); axis = xAxisNumeric(xs.ticks, sx);
  }
  const d = yv.map((v, i) => `${i ? 'L' : 'M'}${n2(x(i))},${n2(y(v))}`).join(' ');
  const pts = yv.length <= 60 ? yv.map((v, i) => `<circle cx="${n2(x(i))}" cy="${n2(y(v))}" r="4" fill="${C.s1}" stroke="${C.surface}" stroke-width="2"><title>${esc(`${xv[i]}: ${fmt(v, 4)}`)}</title></circle>`).join('') : '';
  const body = yAxis(ys.ticks, y) + axis + `<path d="${d}" fill="none" stroke="${C.s1}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` + pts;
  return { svg: frame(title, note, body, { xLabel: xName, yLabel: yName }), data: { points: xv.map((xx, i) => ({ x: xx, y: yv[i] })).slice(0, 500) } };
}

export function pie(labels, values, { title, note }) {
  // At most 8 slices (the categorical palette); the rest fold into "Other".
  let L = labels, V = values;
  const order = V.map((v, i) => i).sort((a, b) => V[b] - V[a]);
  if (L.length > 8) {
    const keep = order.slice(0, 7);
    const rest = order.slice(7).reduce((s, i) => s + V[i], 0);
    L = [...keep.map((i) => L[i]), 'Other']; V = [...keep.map((i) => V[i]), rest];
  } else { L = order.map((i) => L[i]); V = order.map((i) => V[i]); }
  const total = V.reduce((s, v) => s + v, 0);
  const cx = M.l + 170, cy = M.t + PH / 2 + 4, r = 140;
  let a0 = -Math.PI / 2;
  const slices = V.map((v, i) => {
    const a1 = a0 + (v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = V.length === 1
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${series(i)}"/>`
      : `<path d="M${cx},${cy} L${n2(cx + r * Math.cos(a0))},${n2(cy + r * Math.sin(a0))} A${r},${r} 0 ${large} 1 ${n2(cx + r * Math.cos(a1))},${n2(cy + r * Math.sin(a1))} Z" fill="${series(i)}" stroke="${C.surface}" stroke-width="2"><title>${esc(`${L[i]}: ${fmt(v, 4)} (${fmt((v / total) * 100, 3)}%)`)}</title></path>`;
    a0 = a1;
    return p;
  }).join('');
  const legend = L.map((l, i) => `<rect x="${cx + r + 60}" y="${M.t + 20 + i * 26}" width="12" height="12" rx="3" fill="${series(i)}"/><text x="${cx + r + 80}" y="${M.t + 30 + i * 26}" font-size="12" fill="${C.text}">${esc(String(l).slice(0, 28))}</text><text x="${M.l + PW}" y="${M.t + 30 + i * 26}" font-size="12" text-anchor="end" fill="${C.muted}">${esc(`${fmt((V[i] / total) * 100, 3)}%`)}</text>`).join('');
  return { svg: frame(title, note, slices + legend), data: { slices: L.map((l, i) => ({ category: l, value: V[i], share: V[i] / total })) } };
}

/** CSS variables for the HTML report: light values, and dark values for dark mode. */
export const CHART_CSS = `
:root { --surface-1:#fcfcfb; --text-primary:#0b0b0b; --text-secondary:#52514e; --grid:#e6e5e1; --axis:#b9b8b2;
${CATEGORICAL.map((c, i) => `  --series-${i + 1}:${c};`).join('\n')} }
@media (prefers-color-scheme: dark) { :root { --surface-1:#1a1a19; --text-primary:#f0efec; --text-secondary:#c3c2b7; --grid:#33322f; --axis:#5c5b56;
${CATEGORICAL_DARK.map((c, i) => `  --series-${i + 1}:${c};`).join('\n')} } }`;
