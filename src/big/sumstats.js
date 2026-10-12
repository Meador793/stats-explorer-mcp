// Statistics of a numeric sample from its one-pass summary (src/big/acc.js `num`).
// When the summary still holds the actual values (at most EXACT_CAP of them), every function calls
// the engine's own array function, so results are identical to the in-memory path. Otherwise:
// moments are exact; quantiles, outlier counts and the bimodality check use the KLL sketch.
import {
  mean, variance, stdDev, median, percentile, skewness, kurtosis, identifyDistribution, meanCI, inverseTCDF,
} from '../engine/statsUtils.js';
import { summarize, normalityWarnings } from '../stats.js';
import { kllQuantile, kllCdf, kllHistogram } from './kll.js';

export const isExact = (S) => !!S.exact;
export const sN = (S) => S.n;
export const sMean = (S) => (S.exact ? mean(S.exact) : S.mean);
export const sVar = (S) => (S.exact ? variance(S.exact) : S.m2 / (S.n - 1));
export const sSd = (S) => (S.exact ? stdDev(S.exact) : Math.sqrt(S.m2 / (S.n - 1)));
export const sMin = (S) => S.min;
export const sMax = (S) => S.max;

export function sSkew(S) {
  if (S.exact) return skewness(S.exact);
  const n = S.n, s = sSd(S);
  return (n / ((n - 1) * (n - 2))) * (S.m3 / s ** 3);
}
export function sKurt(S) {
  if (S.exact) return kurtosis(S.exact);
  const n = S.n, s = sSd(S);
  return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * (S.m4 / s ** 4) - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}
export const sQuantile = (S, p) => (S.exact ? percentile(S.exact, p) : kllQuantile(S.kll, p));
export const sMedian = (S) => (S.exact ? median(S.exact) : kllQuantile(S.kll, 0.5));

export function sMeanCI(S, confidence = 0.95) {
  if (S.exact) return meanCI(S.exact, confidence);
  const n = S.n, m = S.mean, s = sSd(S);
  const tCrit = inverseTCDF(1 - (1 - confidence) / 2, n - 1);
  const margin = tCrit * (s / Math.sqrt(n));
  return { lower: m - margin, upper: m + margin, margin, criticalValue: tCrit, method: 't', point: m };
}

/** The engine's identifyDistribution() rules, with the bimodality histogram taken from the sketch. */
export function sIdentify(S) {
  if (S.exact) return identifyDistribution(S.exact);
  const n = S.n;
  const sk = sSkew(S), exKurt = sKurt(S);
  const min = S.min, max = S.max;
  let bimodal = false;
  if (n >= 20 && max > min) {
    const k = Math.max(8, Math.min(20, Math.round(Math.sqrt(n))));
    const w = (max - min) / k;
    const bins = kllHistogram(S.kll, Array.from({ length: k + 1 }, (_, i) => min + i * w));
    const sm = bins.map((_, i) => ((bins[i - 1] ?? bins[i]) + 2 * bins[i] + (bins[i + 1] ?? bins[i])) / 4);
    const top = Math.max(...sm);
    const peaks = [];
    for (let i = 0; i < k; i++) {
      const left = i === 0 ? -Infinity : sm[i - 1];
      const right = i === k - 1 ? -Infinity : sm[i + 1];
      if (sm[i] > left && sm[i] >= right && sm[i] >= 0.4 * top) peaks.push(i);
    }
    if (peaks.length >= 2) {
      const [a, b] = [...peaks].sort((x, y) => sm[y] - sm[x]).slice(0, 2).sort((x, y) => x - y);
      const valley = Math.min(...sm.slice(a, b + 1));
      const bc = (sk * sk + 1) / (exKurt + (3 * (n - 1) ** 2) / ((n - 2) * (n - 3)));
      bimodal = valley <= 0.45 * Math.min(sm[a], sm[b]) && bc > 5 / 9;
    }
  }
  // Same labels and descriptions as the engine: classify a tiny stand-in with these moments.
  const label = bimodal ? 'Bimodal' : sk > 0.5 ? 'Right-Skewed' : sk < -0.5 ? 'Left-Skewed' : Math.abs(exKurt) < 1 ? 'Approximately Normal' : exKurt <= -1 ? 'Uniform' : 'Approximately Symmetric (Non-normal)';
  return { name: label, description: DESCRIPTIONS[label], skewness: sk, kurtosis: exKurt, mean: S.mean, median: sMedian(S), stdDev: sSd(S), min, max };
}

const DESCRIPTIONS = {
  Bimodal: 'The data shows two distinct peaks, suggesting two underlying groups or populations are mixed together.',
  'Right-Skewed': 'The data has a long tail to the right. Most values cluster at the lower end with a few high values. Common for income, reaction times, and count data.',
  'Left-Skewed': 'The data has a long tail to the left. Most values are high with a few low values. Common for scores with a ceiling effect.',
  'Approximately Normal': 'The data is roughly bell-shaped and symmetric (skewness near 0, excess kurtosis near 0), consistent with a normal distribution.',
  Uniform: 'The data is spread fairly evenly across its range with no clear peak (flat, light tails), like a uniform distribution.',
  'Approximately Symmetric (Non-normal)': 'The data is roughly symmetric but has heavier tails than a normal curve, so extreme values are more common than a bell curve predicts.',
};

/** stats.js summarize() from a summary. Approximate fields are listed in `approximate`. */
export function sSummarize(S, confidence = 0.95) {
  if (S.exact) return summarize(S.exact, confidence);
  const n = S.n;
  const s = n > 1 ? sSd(S) : NaN;
  const out = {
    n, mean: S.mean, std_dev: s, std_error: s / Math.sqrt(n),
    median: sMedian(S), q1: sQuantile(S, 0.25), q3: sQuantile(S, 0.75), min: S.min, max: S.max,
  };
  if (n >= 3 && s > 0) out.skewness = sSkew(S);
  if (n >= 4 && s > 0) out.excess_kurtosis = sKurt(S);
  if (n >= 2 && s > 0) { const ci = sMeanCI(S, confidence); out.mean_ci = { level: confidence, lower: ci.lower, upper: ci.upper }; }
  if (n >= 5 && s > 0) { const d = sIdentify(S); out.shape = { label: d.name, description: d.description }; }
  out.approximate = ['median', 'q1', 'q3', 'shape'];
  return out;
}

export function sNormalityWarnings(S, label) {
  if (S.exact) return normalityWarnings(S.exact, label);
  const w = [];
  const n = S.n;
  if (n < 30 && n >= 3 && sSd(S) > 0) {
    const sk = sSkew(S);
    if (Math.abs(sk) > 1) w.push(`${label} is small (n = ${n}) and skewed (skewness ${Number(sk.toPrecision(3))}); t-based results may be unreliable. Consider a larger sample or a non-parametric test.`);
  }
  if (n < 5) w.push(`${label} has only ${n} values; the test has very little power.`);
  return w;
}

export function sCohensD(A, B) {
  const m1 = sMean(A), m2 = sMean(B), s1 = sSd(A), s2 = sSd(B), n1 = A.n, n2 = B.n;
  return (m1 - m2) / Math.sqrt(((n1 - 1) * s1 * s1 + (n2 - 1) * s2 * s2) / (n1 + n2 - 2));
}

/** Values beyond 3 SD of the mean (exact, or estimated from the sketch). */
export function sOutliersZ(S) {
  if (S.exact) { const m = mean(S.exact), s = stdDev(S.exact); return s > 0 ? S.exact.filter((x) => Math.abs(x - m) > 3 * s).length : 0; }
  const s = sSd(S);
  if (!(s > 0)) return 0;
  const lo = S.mean - 3 * s, hi = S.mean + 3 * s;
  return Math.round(S.n * (below(S, lo) + 1 - kllCdf(S.kll, hi)));
}
/** Values beyond 1.5 × IQR from the quartiles (exact, or estimated from the sketch). */
export function sOutliersIQR(S) {
  const q1 = sQuantile(S, 0.25), q3 = sQuantile(S, 0.75), k = 1.5 * (q3 - q1);
  if (S.exact) return S.exact.filter((x) => x < q1 - k || x > q3 + k).length;
  return Math.round(S.n * (below(S, q1 - k) + 1 - kllCdf(S.kll, q3 + k)));
}
// Share of values strictly below x.
function below(S, x) {
  let c = 0;
  S.kll.levels.forEach((l, h) => { const w = 2 ** h; for (const v of l) if (v < x) c += w; });
  return c / S.n;
}
