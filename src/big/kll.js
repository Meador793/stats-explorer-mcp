// KLL quantile sketch (Karnin, Lang & Liberty 2016): medians, quartiles and the distribution of any
// number of values in a few tens of kilobytes, with a small rank error (about 0.1% of n with k = 2000).
// Plain-object state so it can be sent between worker threads; merging two sketches is exact in n
// and keeps the same error guarantee. A seeded generator keeps results reproducible.

export const DEFAULT_K = 2000;

function rng(state) {
  // mulberry32: returns [random in [0, 1), next state]
  let t = (state + 0x6d2b79f5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), t | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, t];
}

export function kllCreate(k = DEFAULT_K, seed = 1) {
  const s = { k, n: 0, levels: [[]], seed: seed >>> 0, size: 0, max: 0 };
  s.max = maxSize(s);
  return s;
}

const capacity = (k, h, H) => Math.max(2, Math.ceil(k * Math.pow(2 / 3, H - 1 - h)));

function size(s) { let t = 0; for (const l of s.levels) t += l.length; return t; }
function maxSize(s) { let t = 0; const H = s.levels.length; for (let h = 0; h < H; h++) t += capacity(s.k, h, H); return t; }

function compress(s) {
  s.size = size(s);
  s.max = maxSize(s);
  while (s.size >= s.max) {
    const H = s.levels.length;
    let h = 0;
    while (h < H && s.levels[h].length < capacity(s.k, h, H)) h++;
    if (h === H) h = 0;
    if (h + 1 === s.levels.length) s.levels.push([]);
    const lvl = s.levels[h].sort((a, b) => a - b);
    const keep = lvl.length % 2 === 1 ? [lvl.pop()] : [];
    let r;
    [r, s.seed] = rng(s.seed);
    const off = r < 0.5 ? 0 : 1;
    const up = s.levels[h + 1];
    for (let i = off; i < lvl.length; i += 2) up.push(lvl[i]);
    s.levels[h] = keep;
    s.size = size(s);
    s.max = maxSize(s);
  }
}

export function kllAdd(s, v) {
  s.levels[0].push(v);
  s.n++;
  if (++s.size >= s.max) compress(s);
}

export function kllAddMany(s, values) {
  for (const v of values) kllAdd(s, v);
}

/** Merges b into a (a is modified and returned). */
export function kllMerge(a, b) {
  if (!b || b.n === 0) return a;
  while (a.levels.length < b.levels.length) a.levels.push([]);
  for (let h = 0; h < b.levels.length; h++) for (const v of b.levels[h]) a.levels[h].push(v);
  a.n += b.n;
  a.seed = (a.seed ^ Math.imul(b.seed, 2654435761)) >>> 0;
  compress(a);
  return a;
}

/** Sorted [value, weight] pairs. */
function weighted(s) {
  const items = [];
  s.levels.forEach((l, h) => { const w = 2 ** h; for (const v of l) items.push([v, w]); });
  items.sort((p, q) => p[0] - q[0]);
  return items;
}

/**
 * Quantile with the same convention as the app's percentile(): position (n − 1)·p between sorted
 * values, interpolated linearly. Each retained item stands for `weight` consecutive sorted values.
 */
export function kllQuantile(s, p) {
  if (s.n === 0) return NaN;
  const items = weighted(s);
  const target = (s.n - 1) * p; // 0-based position
  const valueAt = (pos) => {
    // the value occupying 0-based sorted position `pos`
    let c = 0;
    for (const [v, w] of items) { if (pos < c + w) return v; c += w; }
    return items[items.length - 1][0];
  };
  const lo = Math.floor(target), hi = Math.ceil(target);
  const vlo = valueAt(lo), vhi = valueAt(hi);
  return vlo + (vhi - vlo) * (target - lo);
}

/** Fraction of values ≤ x. */
export function kllCdf(s, x) {
  if (s.n === 0) return NaN;
  let c = 0;
  s.levels.forEach((l, h) => { const w = 2 ** h; for (const v of l) if (v <= x) c += w; });
  return c / s.n;
}

/** Approximate counts in the bins [edges[i], edges[i+1]) (last bin closed), scaled to n. */
export function kllHistogram(s, edges) {
  const items = weighted(s);
  const k = edges.length - 1;
  const counts = new Array(k).fill(0);
  const lo = edges[0], w = (edges[k] - lo) / k;
  for (const [v, wt] of items) {
    const i = w > 0 ? Math.min(k - 1, Math.max(0, Math.floor((v - lo) / w))) : 0;
    counts[i] += wt;
  }
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return counts.map((c) => (c / total) * s.n);
}

/** Retained values above x or below y (for drawing a few outliers), at most `max`. */
export function kllTail(s, below, above, max = 60) {
  const out = [];
  for (const l of s.levels) for (const v of l) if (v < below || v > above) out.push(v);
  out.sort((a, b) => a - b);
  if (out.length <= max) return out;
  const step = out.length / max;
  return Array.from({ length: max }, (_, i) => out[Math.floor(i * step)]);
}

/** Retained values (for whisker ends): largest ≤ hi and smallest ≥ lo. */
export function kllInside(s, lo, hi) {
  let mn = Infinity, mx = -Infinity;
  for (const l of s.levels) for (const v of l) if (v >= lo && v <= hi) { if (v < mn) mn = v; if (v > mx) mx = v; }
  return [mn, mx];
}
