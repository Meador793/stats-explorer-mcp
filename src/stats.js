// Helpers built on the engine: one-sided tails, effect-size labels, formatting.
import {
  incompleteBeta, gammaQ, tPValueTwoSided, normalPValueTwoSided, inverseTCDF, inverseNormalCDF,
  mean, variance, stdDev, median, percentile, skewness, kurtosis, identifyDistribution, meanCI, formatPEq,
} from './engine/statsUtils.js';
import { UserError } from './data.js';

export { mean, variance, stdDev, median, percentile, skewness, kurtosis, identifyDistribution, meanCI, formatPEq, inverseTCDF, inverseNormalCDF };

export const ALTERNATIVES = ['two-sided', 'greater', 'less'];

/** P(T > t) for Student's t, computed directly from the upper tail (no 1 − CDF for t ≥ 0). */
export function tUpper(t, df) {
  if (t === Infinity) return 0;
  if (t === -Infinity) return 1;
  const half = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? half : 1 - half;
}
/** P(Z > z) for the standard normal. */
export function zUpper(z) {
  const half = 0.5 * gammaQ(0.5, (z * z) / 2);
  return z >= 0 ? half : 1 - half;
}
export function tPValue(t, df, alternative = 'two-sided') {
  if (alternative === 'greater') return tUpper(t, df);
  if (alternative === 'less') return tUpper(-t, df);
  return Math.min(1, tPValueTwoSided(t, df));
}
export function zPValue(z, alternative = 'two-sided') {
  if (alternative === 'greater') return zUpper(z);
  if (alternative === 'less') return zUpper(-z);
  return Math.min(1, normalPValueTwoSided(z));
}

// ------------------------------------------------------------------ validation

export function checkSample(values, label, min = 2) {
  if (!Array.isArray(values) || values.length < min) {
    throw new UserError(`${label} needs at least ${min} values (got ${Array.isArray(values) ? values.length : 0}).`);
  }
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new UserError(`${label} must contain only finite numbers.`);
  return values;
}
export function checkVaries(values, label) {
  if (variance(values) === 0) throw new UserError(`${label} has no variation (every value is ${values[0]}), so the test is undefined.`);
}
export function checkLevel(x, name) {
  if (!(x > 0 && x < 1)) throw new UserError(`${name} must be between 0 and 1 (got ${x}).`);
  return x;
}

// ------------------------------------------------------------------ effect sizes

const bands = (v, cuts, labels) => {
  const a = Math.abs(v);
  for (let i = cuts.length - 1; i >= 0; i--) if (a >= cuts[i]) return labels[i + 1];
  return labels[0];
};
const SIZE = ['negligible', 'small', 'medium', 'large'];
/** Cohen's (1988) conventional labels. They are rules of thumb, not substantive judgements. */
export const magnitude = {
  d: (v) => bands(v, [0.2, 0.5, 0.8], SIZE),
  r: (v) => bands(v, [0.1, 0.3, 0.5], SIZE),
  eta2: (v) => bands(v, [0.01, 0.06, 0.14], SIZE),
  h: (v) => bands(v, [0.2, 0.5, 0.8], SIZE),
  // Cramér's V thresholds shrink with min(rows, cols) − 1 (Cohen 1988, w / sqrt(df*)).
  cramersV: (v, dfStar) => bands(v * Math.sqrt(Math.max(1, dfStar)), [0.1, 0.3, 0.5], SIZE),
};

// ------------------------------------------------------------------ text

export function fmt(x, digits = 4) {
  if (x === null || x === undefined) return 'N/A';
  if (typeof x !== 'number') return String(x);
  if (!Number.isFinite(x)) return x > 0 ? '∞' : x < 0 ? '−∞' : 'N/A';
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e6 || a < 1e-4) return x.toExponential(digits - 1);
  return Number(x.toPrecision(digits)).toString();
}

export function verdict(p, alpha, nullText, altText) {
  const reject = p < alpha;
  return {
    significant: reject,
    text: reject
      ? `${formatPEq(p)} is below α = ${alpha}, so reject H₀. The data are inconsistent with ${nullText}; this supports ${altText}.`
      : `${formatPEq(p)} is not below α = ${alpha}, so do not reject H₀. The data are consistent with ${nullText} (this is not proof that it is true).`,
  };
}

export function altPhrase(alternative, two, greater, less) {
  return alternative === 'greater' ? greater : alternative === 'less' ? less : two;
}

/** Descriptive summary of one sample. */
export function summarize(values, confidence = 0.95) {
  const n = values.length;
  const s = n > 1 ? stdDev(values) : NaN;
  const out = {
    n,
    mean: mean(values),
    std_dev: s,
    std_error: s / Math.sqrt(n),
    median: median(values),
    q1: percentile(values, 0.25),
    q3: percentile(values, 0.75),
    min: values.reduce((m, v) => (v < m ? v : m), Infinity),
    max: values.reduce((m, v) => (v > m ? v : m), -Infinity),
  };
  if (n >= 3 && s > 0) out.skewness = skewness(values);
  if (n >= 4 && s > 0) out.excess_kurtosis = kurtosis(values);
  if (n >= 2 && s > 0) {
    const ci = meanCI(values, confidence);
    out.mean_ci = { level: confidence, lower: ci.lower, upper: ci.upper };
  }
  if (n >= 5 && s > 0) {
    const d = identifyDistribution(values);
    out.shape = { label: d.name, description: d.description };
  }
  return out;
}

/** Plain warnings about normality-based tests on small or skewed samples. */
export function normalityWarnings(values, label) {
  const w = [];
  const n = values.length;
  if (n < 30 && n >= 3 && stdDev(values) > 0) {
    const sk = skewness(values);
    if (Math.abs(sk) > 1) w.push(`${label} is small (n = ${n}) and skewed (skewness ${fmt(sk, 3)}); t-based results may be unreliable. Consider a larger sample or a non-parametric test.`);
  }
  if (n < 5) w.push(`${label} has only ${n} values; the test has very little power.`);
  return w;
}
