// Mergeable accumulators for one pass over a large file. Each worker fills its own from its part of
// the file; the parts are merged in file order, so results do not depend on how the file was split.
//
// Exactness:
//   • counts, sums, means, variances, skewness, kurtosis, covariances and the sums of squares and
//     cross-products behind ANOVA / ANCOVA / MANOVA are exact (numerically stable one-pass formulas,
//     merged with Chan's and Pébay's pairwise rules);
//   • every numeric sample also keeps its actual values while it has at most EXACT_CAP of them, in
//     file order, so smaller samples give results identical to the in-memory path;
//   • beyond that, medians, quartiles and histograms come from a KLL sketch (about 0.1% rank error)
//     and rank-based statistics (Spearman) from a uniform random sample of RES_SIZE pairs.
// All state is plain objects / arrays / Maps, so it crosses worker_threads unchanged.

import { kllCreate, kllAdd, kllMerge } from './kll.js';
import { isMissingValue } from '../engine/dataImport.js';

export const EXACT_CAP = Number(process.env.STATS_EXPLORER_EXACT_CAP) > 0 ? Number(process.env.STATS_EXPLORER_EXACT_CAP) : 100_000;
export const RES_SIZE = 100_000;
export const CAT_CAP = 10_000; // distinct values tracked per column before counts stop being exact

const isMissing = isMissingValue;
const PLAIN = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '' || !PLAIN.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export const categoryKey = (v) => (typeof v === 'string' ? v.trim() : String(v));

// ------------------------------------------------------------------ random sampling

function rnd(o) {
  let t = (o.rs = (o.rs + 0x6d2b79f5) >>> 0);
  let r = Math.imul(t ^ (t >>> 15), t | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
}

/** Uniform random sample of fixed size (reservoir sampling), mergeable. */
export function resCreate(size, seed) { return { size, seen: 0, items: [], rs: seed >>> 0 }; }
export function resAdd(r, item) {
  r.seen++;
  if (r.items.length < r.size) r.items.push(item);
  else { const j = Math.floor(rnd(r) * r.seen); if (j < r.size) r.items[j] = item; }
}
export function resMerge(a, b) {
  if (!b || b.seen === 0) return a;
  if (a.seen === 0) { a.seen = b.seen; a.items = b.items.slice(); return a; }
  const total = a.seen + b.seen;
  if (a.items.length + b.items.length <= a.size) { a.items = a.items.concat(b.items); a.seen = total; return a; }
  // Take items from each side in proportion to the number of values it stands for.
  const fromA = Math.min(a.items.length, Math.max(0, Math.round((a.size * a.seen) / total)));
  const pick = (arr, k) => { const c = arr.slice(); for (let i = 0; i < k; i++) { const j = i + Math.floor(rnd(a) * (c.length - i)); [c[i], c[j]] = [c[j], c[i]]; } return c.slice(0, k); };
  a.items = pick(a.items, fromA).concat(pick(b.items, Math.min(b.items.length, a.size - fromA)));
  a.seen = total;
  return a;
}

// ------------------------------------------------------------------ distinct counts (HyperLogLog)

const HLL_P = 14, HLL_M = 1 << HLL_P; // 16,384 registers: about 0.8% standard error

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
export function hllAdd(reg, key) {
  const h = hash32(key);
  const idx = h >>> (32 - HLL_P);
  const rank = Math.min(32 - HLL_P + 1, Math.clz32((h << HLL_P) | (1 << (HLL_P - 1))) + 1);
  if (rank > reg[idx]) reg[idx] = rank;
}
export function hllMerge(a, b) { for (let i = 0; i < HLL_M; i++) if (b[i] > a[i]) a[i] = b[i]; return a; }
export function hllEstimate(reg) {
  let sum = 0, zeros = 0;
  for (let i = 0; i < HLL_M; i++) { sum += 2 ** -reg[i]; if (reg[i] === 0) zeros++; }
  const E = (0.7213 / (1 + 1.079 / HLL_M)) * HLL_M * HLL_M / sum;
  if (E <= 2.5 * HLL_M && zeros) return HLL_M * Math.log(HLL_M / zeros);
  const two32 = 2 ** 32;
  return E > two32 / 30 ? -two32 * Math.log(1 - E / two32) : E;
}

// ------------------------------------------------------------------ numeric sample

let seedCounter = 1;
const nextSeed = () => (seedCounter = (seedCounter * 1664525 + 1013904223) >>> 0);
export function reseed(chunkIndex) { seedCounter = (chunkIndex * 2654435761 + 12345) >>> 0; }

export function numCreate() {
  return { t: 'num', n: 0, mean: 0, m2: 0, m3: 0, m4: 0, min: Infinity, max: -Infinity, exact: [], kll: kllCreate(undefined, nextSeed()), res: resCreate(10_000, nextSeed()) };
}

/** Adds one numeric value (already checked to be a finite number). */
export function numAdd(s, x) {
  const n1 = s.n;
  const n = ++s.n;
  const delta = x - s.mean, dn = delta / n, dn2 = dn * dn, t1 = delta * dn * n1;
  s.mean += dn;
  s.m4 += t1 * dn2 * (n * n - 3 * n + 3) + 6 * dn2 * s.m2 - 4 * dn * s.m3;
  s.m3 += t1 * dn * (n - 2) - 3 * dn * s.m2;
  s.m2 += t1;
  if (x < s.min) s.min = x;
  if (x > s.max) s.max = x;
  if (s.exact) { if (s.exact.length < EXACT_CAP) s.exact.push(x); else s.exact = null; }
  kllAdd(s.kll, x);
  resAdd(s.res, x);
}

/** Pébay's pairwise update of the first four central moments. b is merged into a. */
export function numMerge(a, b) {
  if (!b || b.n === 0) return a;
  if (a.n === 0) {
    Object.assign(a, { n: b.n, mean: b.mean, m2: b.m2, m3: b.m3, m4: b.m4, min: b.min, max: b.max, exact: b.exact ? b.exact.slice() : null });
    a.kll = kllMerge(a.kll, b.kll);
    a.res = resMerge(a.res, b.res);
    return a;
  }
  const na = a.n, nb = b.n, n = na + nb;
  const d = b.mean - a.mean, d2 = d * d, d3 = d2 * d, d4 = d2 * d2;
  const m2 = a.m2 + b.m2 + d2 * na * nb / n;
  const m3 = a.m3 + b.m3 + d3 * na * nb * (na - nb) / (n * n) + 3 * d * (na * b.m2 - nb * a.m2) / n;
  const m4 = a.m4 + b.m4 + d4 * na * nb * (na * na - na * nb + nb * nb) / (n * n * n)
    + 6 * d2 * (na * na * b.m2 + nb * nb * a.m2) / (n * n) + 4 * d * (na * b.m3 - nb * a.m3) / n;
  a.mean = a.mean + d * nb / n;
  a.m2 = m2; a.m3 = m3; a.m4 = m4; a.n = n;
  if (b.min < a.min) a.min = b.min;
  if (b.max > a.max) a.max = b.max;
  if (a.exact && b.exact && a.exact.length + b.exact.length <= EXACT_CAP) { for (const v of b.exact) a.exact.push(v); } else a.exact = null;
  a.kll = kllMerge(a.kll, b.kll);
  a.res = resMerge(a.res, b.res);
  return a;
}

// ------------------------------------------------------------------ accumulator specs
//
// A spec lists what to compute; `cols` are the column names it reads. Every accumulator follows the
// same missing / non-numeric rules as the in-memory tools.

/** Value checks shared with the in-memory path: null = missing (skip), NaN = non-numeric (error). */
function numericOf(v) {
  if (v === null || v === undefined || isMissing(v)) return null;
  const n = toNumber(v);
  return n === null ? NaN : n;
}
function noteBad(st, col, v) { st.bad = (st.bad || 0) + 1; if (st.firstBad === undefined) { st.firstBad = v; st.badCol = col; } }

export const ACC = {
  // one numeric column
  num: {
    cols: (a) => [a.col],
    create: () => ({ s: numCreate() }),
    add(st, [v], a) { const x = numericOf(v); if (x === null) return; if (x !== x) { noteBad(st, a.col, v); return; } numAdd(st.s, x); },
    merge(a, b) { numMerge(a.s, b.s); mergeBad(a, b); return a; },
  },
  // a numeric column by the categories of another (groupValues)
  grouped: {
    cols: (a) => [a.col, a.by],
    create: () => ({ groups: new Map(), overflow: false }),
    add(st, [v, g], a) {
      if (g === null || g === undefined || isMissing(g)) return;
      const x = numericOf(v); if (x === null) return; if (x !== x) { noteBad(st, a.col, v); return; }
      const key = categoryKey(g);
      let s = st.groups.get(key);
      if (!s) { if (st.groups.size >= 1000) { st.overflow = true; return; } st.groups.set(key, (s = numCreate())); }
      numAdd(s, x);
    },
    merge(a, b) { for (const [k, s] of b.groups) { const t = a.groups.get(k); if (t) numMerge(t, s); else a.groups.set(k, s); } a.overflow ||= b.overflow; mergeBad(a, b); return a; },
  },
  // two numeric columns on the rows where both are present (pairedColumns)
  pair: {
    cols: (a) => [a.x, a.y],
    create: () => ({ x: numCreate(), y: numCreate(), d: numCreate(), n: 0, mx: 0, my: 0, cxy: 0, res: resCreate(RES_SIZE, nextSeed()) }),
    add(st, [vx, vy], a) {
      if (vx === null || vx === undefined || isMissing(vx) || vy === null || vy === undefined || isMissing(vy)) return;
      const x = toNumber(vx), y = toNumber(vy);
      if (x === null) { noteBad(st, a.x, vx); return; }
      if (y === null) { noteBad(st, a.y, vy); return; }
      numAdd(st.x, x); numAdd(st.y, y); numAdd(st.d, x - y);
      const n = ++st.n, dx = x - st.mx;
      st.mx += dx / n; st.my += (y - st.my) / n; st.cxy += dx * (y - st.my);
      resAdd(st.res, [x, y]);
    },
    merge(a, b) {
      if (b.n) {
        const n = a.n + b.n, dx = b.mx - a.mx, dy = b.my - a.my;
        a.cxy += b.cxy + dx * dy * a.n * b.n / n;
        a.mx += dx * b.n / n; a.my += dy * b.n / n; a.n = n;
      }
      numMerge(a.x, b.x); numMerge(a.y, b.y); numMerge(a.d, b.d); resMerge(a.res, b.res); mergeBad(a, b);
      return a;
    },
  },
  // category counts (goodness of fit, categories)
  counts: {
    cols: (a) => [a.col],
    create: () => ({ counts: new Map(), n: 0, overflow: false }),
    add(st, [v]) {
      if (v === null || v === undefined || isMissing(v)) return;
      const k = categoryKey(v);
      const c = st.counts.get(k);
      if (c !== undefined) st.counts.set(k, c + 1);
      else if (st.counts.size < CAT_CAP) st.counts.set(k, 1);
      else st.overflow = true;
      st.n++;
    },
    merge(a, b) { for (const [k, c] of b.counts) { const t = a.counts.get(k); if (t !== undefined) a.counts.set(k, t + c); else if (a.counts.size < CAT_CAP) a.counts.set(k, c); else a.overflow = true; } a.n += b.n; a.overflow ||= b.overflow; return a; },
  },
  // contingency table (crosstab)
  crosstab: {
    cols: (a) => [a.row, a.col],
    create: () => ({ pairs: new Map(), overflow: false }),
    add(st, [r, c]) {
      if (r === null || r === undefined || isMissing(r) || c === null || c === undefined || isMissing(c)) return;
      const rk = categoryKey(r), ck = categoryKey(c);
      let row = st.pairs.get(rk);
      if (!row) { if (st.pairs.size > 1000) { st.overflow = true; return; } st.pairs.set(rk, (row = new Map())); }
      if (!row.has(ck) && row.size > 1000) { st.overflow = true; return; }
      row.set(ck, (row.get(ck) || 0) + 1);
    },
    merge(a, b) { for (const [rk, row] of b.pairs) { let t = a.pairs.get(rk); if (!t) a.pairs.set(rk, (t = new Map())); for (const [ck, c] of row) t.set(ck, (t.get(ck) || 0) + c); } a.overflow ||= b.overflow; return a; },
  },
  // ANCOVA / MANOVA (rowsFor): group + numeric columns, complete rows only
  groupedMulti: {
    cols: (a) => [a.by, ...a.nums],
    create: (a) => ({ groups: new Map(), rows: [], n: 0, p: a.nums.length }),
    add(st, vals, a) {
      const g = vals[0];
      if (g === null || g === undefined || isMissing(g)) return;
      const xs = new Array(a.nums.length);
      for (let i = 0; i < a.nums.length; i++) { const v = vals[i + 1]; if (v === null || v === undefined || isMissing(v)) return; xs[i] = v; }
      for (let i = 0; i < xs.length; i++) { const n = toNumber(xs[i]); if (n === null) { noteBad(st, a.nums[i], xs[i]); return; } xs[i] = n; }
      const key = categoryKey(g);
      let G = st.groups.get(key);
      if (!G) { if (st.groups.size >= 1000) { st.overflow = true; return; } st.groups.set(key, (G = { n: 0, mean: new Array(xs.length).fill(0), C: Array.from({ length: xs.length }, () => new Array(xs.length).fill(0)), each: xs.map(() => numCreate()) })); }
      // multivariate Welford: mean vector and sums of squares and cross-products
      const n = ++G.n, d = xs.map((x, i) => x - G.mean[i]);
      for (let i = 0; i < xs.length; i++) G.mean[i] += d[i] / n;
      for (let i = 0; i < xs.length; i++) for (let j = 0; j < xs.length; j++) G.C[i][j] += d[i] * (xs[j] - G.mean[j]);
      xs.forEach((x, i) => numAdd(G.each[i], x));
      st.n++;
      if (st.rows) { if (st.rows.length < EXACT_CAP) st.rows.push([key, ...xs]); else st.rows = null; }
    },
    merge(a, b) {
      for (const [k, H] of b.groups) {
        const G = a.groups.get(k);
        if (!G) { a.groups.set(k, H); continue; }
        const n = G.n + H.n, d = H.mean.map((m, i) => m - G.mean[i]);
        for (let i = 0; i < d.length; i++) for (let j = 0; j < d.length; j++) G.C[i][j] += H.C[i][j] + d[i] * d[j] * G.n * H.n / n;
        G.mean = G.mean.map((m, i) => m + d[i] * H.n / n);
        G.n = n;
        G.each.forEach((s, i) => numMerge(s, H.each[i]));
      }
      a.n += b.n;
      if (a.rows && b.rows && a.rows.length + b.rows.length <= EXACT_CAP) { for (const r of b.rows) a.rows.push(r); } else a.rows = null;
      a.overflow ||= b.overflow;
      mergeBad(a, b);
      return a;
    },
  },
  // missing cells per column, out of the non-blank rows
  missing: {
    cols: (a) => a.cols,
    create: (a) => ({ miss: a.cols.map(() => 0), rows: 0 }),
    add(st, vals) { st.rows++; for (let i = 0; i < vals.length; i++) if (vals[i] === null || vals[i] === undefined) st.miss[i]++; },
    merge(a, b) { a.rows += b.rows; b.miss.forEach((m, i) => { a.miss[i] += m; }); return a; },
  },
  // 2×2 counts of two 0/1 columns (base-rate check)
  baseRate: {
    cols: (a) => [a.cond, a.test],
    create: () => ({ c: [0, 0, 0, 0] }),
    add(st, [c, t]) { if ((c === 0 || c === 1) && (t === 0 || t === 1)) st.c[c * 2 + t]++; },
    merge(a, b) { b.c.forEach((v, i) => { a.c[i] += v; }); return a; },
  },
  // per-column profile (inspect_data_file)
  profile: {
    cols: (a) => a.cols,
    create: (a) => ({ rows: 0, preview: [], cols: a.cols.map(() => ({ nonMissing: 0, allNumeric: true, anyNumber: false, s: numCreate(), counts: new Map(), overflow: false, hll: new Uint8Array(HLL_M) })) }),
    add(st, vals) {
      st.rows++;
      if (st.preview.length < 5) st.preview.push(vals.slice());
      for (let i = 0; i < vals.length; i++) {
        const v = vals[i];
        if (v === null || v === undefined || isMissing(v)) continue;
        const c = st.cols[i];
        c.nonMissing++;
        const x = toNumber(v);
        if (x === null) c.allNumeric = false; else { c.anyNumber = true; numAdd(c.s, x); }
        const k = categoryKey(v);
        hllAdd(c.hll, k);
        const cnt = c.counts.get(k);
        if (cnt !== undefined) c.counts.set(k, cnt + 1);
        else if (c.counts.size < CAT_CAP) c.counts.set(k, 1);
        else c.overflow = true;
      }
    },
    merge(a, b) {
      a.rows += b.rows;
      for (const r of b.preview) if (a.preview.length < 5) a.preview.push(r);
      a.cols.forEach((c, i) => {
        const d = b.cols[i];
        c.nonMissing += d.nonMissing; c.allNumeric &&= d.allNumeric; c.anyNumber ||= d.anyNumber;
        numMerge(c.s, d.s);
        for (const [k, n] of d.counts) { const t = c.counts.get(k); if (t !== undefined) c.counts.set(k, t + n); else if (c.counts.size < CAT_CAP) c.counts.set(k, n); else c.overflow = true; }
        c.overflow ||= d.overflow;
        hllMerge(c.hll, d.hll);
      });
      return a;
    },
  },
};

function mergeBad(a, b) {
  if (b.bad) { a.bad = (a.bad || 0) + b.bad; if (a.firstBad === undefined) { a.firstBad = b.firstBad; a.badCol = b.badCol; } }
}

/** Columns read by a list of accumulator specs, and each spec's positions within them. */
export function planColumns(specs) {
  const cols = [];
  const pos = specs.map((sp) => ACC[sp.type].cols(sp).map((c) => { let i = cols.indexOf(c); if (i < 0) { i = cols.length; cols.push(c); } return i; }));
  return { cols, pos };
}

export function createAll(specs) { return specs.map((sp) => ACC[sp.type].create(sp)); }
export function mergeAll(specs, a, b) { return specs.map((sp, i) => ACC[sp.type].merge(a[i], b[i], sp)); }

/** Feeds one row (values of the planned columns) to every accumulator. */
export function makeFeeder(specs, pos, states) {
  const fns = specs.map((sp, i) => {
    const p = pos[i], add = ACC[sp.type].add, st = states[i];
    if (p.length === 1) { const k = p[0]; const buf = [null]; return (row) => { buf[0] = row[k]; add(st, buf, sp); }; }
    const buf = new Array(p.length);
    return (row) => { for (let j = 0; j < p.length; j++) buf[j] = row[p[j]]; add(st, buf, sp); };
  });
  return (row) => { for (const f of fns) f(row); };
}
