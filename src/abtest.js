// A/B (and A/B/n) testing from per-variant summaries:
//   conversion metrics: { name, n, conversions }      continuous metrics: { name, n, mean, sd }
// Everything a test readout needs: sample ratio mismatch check, per-variant rates or means with
// intervals, an omnibus test for 3+ variants (with Tukey HSD for continuous metrics), each variant
// against the control (absolute and relative lift with intervals, multiple-comparison adjustment),
// Bayesian probabilities, the minimum detectable effect, and sample-size planning.
// Reference values: statsmodels (proportions_ztest, confint_proportions_2indep, multipletests,
// NormalIndPower) and SciPy (ttest_ind, chisquare, chi2_contingency, fisher_exact, beta integrals);
// see test/reference/abtest.py and test/abtest.test.mjs.
import { normalCDF, inverseNormalCDF, incompleteBeta, gammaLn, chiSquarePValue, fPValue } from './engine/statsUtils.js';
import { tPValue, zPValue, inverseTCDF, fmt, formatPEq } from './stats.js';
import { tukeyHSD, tukeyLines, glPanels } from './posthoc.js';
import { UserError } from './errors.js';

const zP = (z, alt) => zPValue(z, alt);
/** Normal quantile to full double precision: the engine's approximation plus one Halley step. */
const zq = (p) => {
  const x = inverseNormalCDF(p);
  const e = normalCDF(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
};
const pct = (x, d = 2) => (x == null || !isFinite(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const pp = (x, d = 2) => (x == null || !isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)} pp`);
const rel = (x, d = 1) => (x == null || !isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);

// ------------------------------------------------------------------ helpers

/** Holm or Bonferroni adjusted p-values (same order as given). */
export function adjustP(ps, method = 'holm') {
  const m = ps.length;
  if (method === 'none' || m <= 1) return ps.slice();
  if (method === 'bonferroni') return ps.map((p) => Math.min(1, p * m));
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(m);
  let running = 0;
  order.forEach(([p, i], r) => { running = Math.max(running, Math.min(1, (m - r) * p)); out[i] = running; });
  return out;
}

const logChoose = (n, k) => gammaLn(n + 1) - gammaLn(k + 1) - gammaLn(n - k + 1);

/** Two-sided Fisher exact p for a 2×2 table [[a, b], [c, d]] (SciPy's definition). */
export function fisherTwoSided([[a, b], [c, d]]) {
  const r1 = a + b, c1 = a + c, N = a + b + c + d;
  const lo = Math.max(0, r1 + c1 - N), hi = Math.min(r1, c1);
  const lp = (x) => logChoose(c1, x) + logChoose(N - c1, r1 - x) - logChoose(N, r1);
  const obs = lp(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) { const l = lp(x); if (l <= obs + Math.log1p(1e-7)) p += Math.exp(l); }
  return Math.min(1, p);
}

/** Wilson score interval for a proportion. */
function wilson(k, n, conf) {
  const z = zq(1 - (1 - conf) / 2), p = k / n, z2 = z * z;
  const c = (p + z2 / (2 * n)) / (1 + z2 / n);
  const h = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Sample ratio mismatch: chi-square goodness of fit of the visitor counts against the planned split. */
export function srmCheck(ns, names, expectedSplit, srmAlpha = 0.001) {
  const N = ns.reduce((s, v) => s + v, 0);
  const w = names.map((nm, i) => (expectedSplit ? Number(expectedSplit[nm] ?? expectedSplit[i]) : 1));
  if (w.some((x) => !(x > 0))) throw new UserError(`expected_split needs a positive weight for every variant (${names.join(', ')}).`);
  const W = w.reduce((s, v) => s + v, 0);
  const exp = w.map((x) => (x / W) * N);
  const chi2 = ns.reduce((s, o, i) => s + (o - exp[i]) ** 2 / exp[i], 0);
  const p = chiSquarePValue(chi2, ns.length - 1);
  return {
    expected_share: w.map((x) => x / W), observed_share: ns.map((x) => x / N), expected_n: exp,
    chi_square: chi2, df: ns.length - 1, p_value: p, threshold: srmAlpha, mismatch: p < srmAlpha,
  };
}

// ------------------------------------------------------------------ Bayesian (conversion)

const betaLogPdf = (x, a, b) => (x <= 0 || x >= 1 ? -Infinity : (a - 1) * Math.log(x) + (b - 1) * Math.log(1 - x) - (gammaLn(a) + gammaLn(b) - gammaLn(a + b)));

/**
 * Beta posteriors (uniform prior by default): probability each variant has the highest true rate,
 * probability each beats the control, and the expected loss of shipping each. Deterministic
 * quadrature (no random draws), so the same data always give the same numbers.
 */
export function bayesConversion(variants, controlIndex, prior = { alpha: 1, beta: 1 }) {
  const post = variants.map((v) => ({ a: prior.alpha + v.conversions, b: prior.beta + v.n - v.conversions }));
  const mom = post.map(({ a, b }) => ({ m: a / (a + b), sd: Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1))) }));
  const lo = Math.max(0, Math.min(...mom.map((x) => x.m - 14 * x.sd)));
  const hi = Math.min(1, Math.max(...mom.map((x) => x.m + 14 * x.sd)));
  const panels = 400;
  const cdf = (i, x) => incompleteBeta(x, post[i].a, post[i].b);
  const pdf = (i, x) => Math.exp(betaLogPdf(x, post[i].a, post[i].b));
  /** P(variant i is the best among the indices in `set`). */
  const pBest = (i, set) => glPanels((x) => { let f = pdf(i, x); for (const j of set) if (j !== i) f *= cdf(j, x); return f; }, lo, hi, panels);
  const all = variants.map((_, i) => i);
  const best = all.map((i) => pBest(i, all));
  const sBest = best.reduce((s, v) => s + v, 0);
  // E[max_j p_j] = lo + ∫_lo^hi (1 − Π F_j(x)) dx (the product is ~0 below lo).
  const eMax = lo + glPanels((x) => 1 - all.reduce((s, j) => s * cdf(j, x), 1), lo, hi, panels);
  const beatsControl = all.map((i) => (i === controlIndex ? null : pBest(i, [i, controlIndex])));
  return {
    model: `Beta-Binomial, prior Beta(${prior.alpha}, ${prior.beta})`,
    variants: variants.map((v, i) => ({
      name: v.name, posterior_mean: mom[i].m,
      credible_interval_95: [betaQuantile(0.025, post[i].a, post[i].b), betaQuantile(0.975, post[i].a, post[i].b)],
      prob_best: best[i] / sBest, prob_beats_control: beatsControl[i], expected_loss: Math.max(0, eMax - mom[i].m),
    })),
  };
}

function betaQuantile(p, a, b) {
  let lo = 0, hi = 1;
  for (let it = 0; it < 80; it++) { const mid = (lo + hi) / 2; if (incompleteBeta(mid, a, b) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// ------------------------------------------------------------------ planning

const powerZ = (ncp, alpha, twoSided) => {
  const z = zq(1 - (twoSided ? alpha / 2 : alpha));
  return twoSided ? 1 - normalCDF(z - ncp) + normalCDF(-z - ncp) : 1 - normalCDF(z - ncp);
};

/** Smallest n per variant with power ≥ target, for a standardized effect `es` per √(2/n). */
function solveN(es, alpha, power, twoSided) {
  if (!(es > 0)) throw new UserError('The effect to detect must be different from zero.');
  let lo = 2, hi = 2;
  while (powerZ(es * Math.sqrt(hi / 2), alpha, twoSided) < power) { hi *= 2; if (hi > 1e12) throw new UserError('That effect is too small to detect with any realistic sample.'); }
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (powerZ(es * Math.sqrt(mid / 2), alpha, twoSided) >= power) hi = mid; else lo = mid; }
  return hi;
}

/** Smallest standardized effect detectable with n per variant. */
function solveEs(n, alpha, power, twoSided) {
  let lo = 0, hi = 50;
  for (let it = 0; it < 100; it++) { const mid = (lo + hi) / 2; if (powerZ(mid * Math.sqrt(n / 2), alpha, twoSided) >= power) hi = mid; else lo = mid; }
  return hi;
}

const hOf = (p1, p2) => 2 * Math.asin(Math.sqrt(p2)) - 2 * Math.asin(Math.sqrt(p1));
/** Rate p2 > p1 with Cohen's h = es. */
const rateForH = (p1, es) => { const t = Math.asin(Math.sqrt(p1)) + es / 2; return t >= Math.PI / 2 ? 1 : Math.sin(t) ** 2; };

/**
 * Sample size (or detectable effect) for an A/B test. Cohen's h for conversion rates and Cohen's d for
 * continuous metrics, normal approximation (statsmodels NormalIndPower). With more than two variants the
 * α per comparison is Bonferroni-split across the comparisons with the control.
 */
export function abPlan(a) {
  const variants = a.variants ?? 2;
  if (!(variants >= 2)) throw new UserError('variants must be at least 2.');
  const comparisons = variants - 1;
  const alphaEach = a.adjust_for_variants === false ? a.alpha : a.alpha / comparisons;
  const twoSided = (a.alternative ?? 'two-sided') === 'two-sided';
  const power = a.power ?? 0.8;
  const out = { metric: a.metric, variants, alpha: a.alpha, alpha_per_comparison: alphaEach, alternative: a.alternative ?? 'two-sided', power, method: 'normal approximation (statsmodels NormalIndPower)' };
  const lines = [];
  if (a.metric === 'conversion') {
    const p1 = a.baseline_rate;
    if (!(p1 > 0 && p1 < 1)) throw new UserError('baseline_rate must be between 0 and 1 (e.g. 0.04 for 4%).');
    if (a.mde != null) {
      const p2 = a.mde_type === 'relative' ? p1 * (1 + a.mde) : p1 + a.mde;
      if (!(p2 > 0 && p2 < 1) || p2 === p1) throw new UserError('The target rate (baseline + mde) must be between 0 and 1 and differ from the baseline.');
      const h = Math.abs(hOf(p1, p2));
      const n = solveN(h, alphaEach, power, twoSided);
      Object.assign(out, { baseline_rate: p1, target_rate: p2, absolute_mde: p2 - p1, relative_mde: (p2 - p1) / p1, cohens_h: h, n_per_variant: n, total_n: n * variants });
      lines.push(`To detect ${pct(p1)} → ${pct(p2)} (${pp(p2 - p1)}, ${rel((p2 - p1) / p1)} relative) with ${Math.round(power * 100)}% power at α = ${fmt(alphaEach)}${comparisons > 1 ? ' per comparison' : ''}: ${n.toLocaleString('en-US')} visitors per variant, ${(n * variants).toLocaleString('en-US')} in total.`);
    }
    if (a.n_per_variant != null) {
      const h = solveEs(a.n_per_variant, alphaEach, power, twoSided);
      const p2 = rateForH(p1, h);
      Object.assign(out, { detectable: { n_per_variant: a.n_per_variant, cohens_h: h, target_rate: p2, absolute_mde: p2 - p1, relative_mde: (p2 - p1) / p1 } });
      lines.push(`With ${a.n_per_variant.toLocaleString('en-US')} per variant the smallest lift you can reliably detect is ${pct(p1)} → ${pct(p2)} (${pp(p2 - p1)}, ${rel((p2 - p1) / p1)} relative).`);
    }
  } else {
    const sd = a.baseline_sd;
    if (!(sd > 0)) throw new UserError('baseline_sd (the standard deviation of the metric) is needed for a continuous metric.');
    if (a.mde != null) {
      const abs = a.mde_type === 'relative' ? (a.baseline_mean ?? NaN) * a.mde : a.mde;
      if (!(Math.abs(abs) > 0)) throw new UserError('A relative mde needs baseline_mean; otherwise give mde as an absolute difference.');
      const d = Math.abs(abs) / sd;
      const n = solveN(d, alphaEach, power, twoSided);
      Object.assign(out, { baseline_sd: sd, absolute_mde: abs, cohens_d: d, n_per_variant: n, total_n: n * variants });
      lines.push(`To detect a difference of ${fmt(abs)} (Cohen's d = ${fmt(d, 3)}) with ${Math.round(power * 100)}% power at α = ${fmt(alphaEach)}: ${n.toLocaleString('en-US')} per variant, ${(n * variants).toLocaleString('en-US')} in total.`);
    }
    if (a.n_per_variant != null) {
      const d = solveEs(a.n_per_variant, alphaEach, power, twoSided);
      Object.assign(out, { detectable: { n_per_variant: a.n_per_variant, cohens_d: d, absolute_mde: d * sd, ...(a.baseline_mean ? { relative_mde: (d * sd) / a.baseline_mean } : {}) } });
      lines.push(`With ${a.n_per_variant.toLocaleString('en-US')} per variant the smallest detectable difference is ${fmt(d * sd)} (d = ${fmt(d, 3)}).`);
    }
  }
  if (out.total_n && a.daily_traffic > 0) {
    out.days_needed = Math.ceil(out.total_n / a.daily_traffic);
    lines.push(`At ${a.daily_traffic.toLocaleString('en-US')} eligible visitors a day that takes about ${out.days_needed} day(s); run whole weeks (at least ${Math.max(7, Math.ceil(out.days_needed / 7) * 7)} days) so weekday and weekend behaviour are both included.`);
  }
  if (!lines.length) throw new UserError('Give mde (the smallest lift that matters) to get a sample size, and/or n_per_variant to get the detectable lift.');
  lines.push('Fix the sample size before starting and analyse once at the end: stopping as soon as p < α ("peeking") inflates false positives.');
  return { data: out, summary: ['A/B test sample size', ...lines] };
}

// ------------------------------------------------------------------ the readout

/**
 * spec: { metric: 'conversion'|'continuous', variants: [...], control?: name, alternative, alpha, confidence,
 *         correction: 'holm'|'bonferroni'|'none', expected_split?, srm_alpha?, bayesian?, prior?, mde? }
 */
export function abReadout(spec) {
  const { metric, alpha, confidence } = spec;
  const alternative = spec.alternative ?? 'two-sided';
  const variants = spec.variants;
  if (!variants || variants.length < 2) throw new UserError('An A/B test needs at least two variants.');
  if (variants.length > 26) throw new UserError('Too many variants (over 26). Is the variant column really the experiment arm?');
  const names = variants.map((v) => String(v.name));
  if (new Set(names).size !== names.length) throw new UserError('Variant names must be different.');
  const ci = spec.control != null ? names.indexOf(String(spec.control)) : 0;
  if (ci < 0) throw new UserError(`Control "${spec.control}" not found. Variants: ${names.join(', ')}`);
  for (const v of variants) {
    if (!(v.n > 0)) throw new UserError(`Variant "${v.name}" has no visitors / observations.`);
    if (metric === 'conversion' && !(Number.isInteger(v.conversions) && v.conversions >= 0 && v.conversions <= v.n)) throw new UserError(`Variant "${v.name}": conversions must be a whole number between 0 and n (${v.n}).`);
    if (metric === 'continuous' && (!(v.n >= 2) || !isFinite(v.mean) || !(v.sd >= 0))) throw new UserError(`Variant "${v.name}" needs n ≥ 2, a mean and a standard deviation.`);
  }
  const zc = zq(1 - (1 - confidence) / 2);
  const C = variants[ci];
  const warnings = [];
  const notes = [];

  // 1. Sample ratio mismatch.
  const srm = srmCheck(variants.map((v) => v.n), names, spec.expected_split, spec.srm_alpha ?? 0.001);
  if (srm.mismatch) warnings.push(`Sample ratio mismatch: the traffic split (${srm.observed_share.map((s, i) => `${names[i]} ${pct(s, 1)}`).join(', ')}) is far from the planned ${srm.expected_share.map((s) => pct(s, 0)).join(' / ')} (χ² p = ${fmt(srm.p_value)}). Assignment or tracking is likely broken; do not trust the results until the cause is found.`);

  // 2. Per-variant estimates.
  const per = variants.map((v) => {
    if (metric === 'conversion') {
      const [lo, hi] = wilson(v.conversions, v.n, confidence);
      return { name: v.name, n: v.n, conversions: v.conversions, rate: v.conversions / v.n, ci_lower: lo, ci_upper: hi, ci_method: 'Wilson' };
    }
    const se = v.sd / Math.sqrt(v.n), t = inverseTCDF(1 - (1 - confidence) / 2, v.n - 1);
    return { name: v.name, n: v.n, mean: v.mean, sd: v.sd, ci_lower: v.mean - t * se, ci_upper: v.mean + t * se, ci_method: 't' };
  });

  // 3. Omnibus test across all variants (3+).
  let omnibus = null, postHoc = null;
  if (variants.length > 2) {
    if (metric === 'conversion') {
      const N = variants.reduce((s, v) => s + v.n, 0), X = variants.reduce((s, v) => s + v.conversions, 0);
      let chi2 = 0;
      for (const v of variants) {
        const e1 = (v.n * X) / N, e0 = v.n - e1;
        chi2 += (v.conversions - e1) ** 2 / e1 + (v.n - v.conversions - e0) ** 2 / e0;
      }
      const df = variants.length - 1;
      omnibus = { test: 'Chi-square test of independence (variant × converted)', statistic: chi2, df, p_value: chiSquarePValue(chi2, df) };
    } else {
      const N = variants.reduce((s, v) => s + v.n, 0), k = variants.length;
      const grand = variants.reduce((s, v) => s + v.n * v.mean, 0) / N;
      const SSB = variants.reduce((s, v) => s + v.n * (v.mean - grand) ** 2, 0);
      const SSW = variants.reduce((s, v) => s + (v.n - 1) * v.sd ** 2, 0);
      const dfB = k - 1, dfW = N - k, F = (SSB / dfB) / (SSW / dfW);
      omnibus = { test: 'One-way ANOVA', statistic: F, df: { between: dfB, within: dfW }, p_value: fPValue(F, dfB, dfW) };
      if (spec.post_hoc !== 'none') postHoc = tukeyHSD(variants.map((v) => ({ name: v.name, n: v.n, mean: v.mean })), SSW / dfW, dfW, alpha);
    }
    omnibus.significant = omnibus.p_value < alpha;
  }

  // 4. Each variant against the control.
  const raw = [];
  for (let i = 0; i < variants.length; i++) {
    if (i === ci) continue;
    const V = variants[i];
    let row;
    if (metric === 'conversion') {
      const pc = C.conversions / C.n, pv = V.conversions / V.n, diff = pv - pc;
      const pool = (C.conversions + V.conversions) / (C.n + V.n);
      const se0 = Math.sqrt(pool * (1 - pool) * (1 / C.n + 1 / V.n));
      const z = se0 > 0 ? diff / se0 : 0;
      const p = se0 > 0 ? zP(z, alternative) : 1;
      const se1 = Math.sqrt((pc * (1 - pc)) / C.n + (pv * (1 - pv)) / V.n);
      const canRatio = C.conversions > 0 && V.conversions > 0;
      const seLog = canRatio ? Math.sqrt(1 / V.conversions - 1 / V.n + 1 / C.conversions - 1 / C.n) : NaN;
      const ratio = pc > 0 ? pv / pc : NaN;
      const table = [[V.conversions, V.n - V.conversions], [C.conversions, C.n - C.conversions]];
      const minExp = Math.min(...[[V.n, 0], [V.n, 1], [C.n, 0], [C.n, 1]].map(([n, col]) => (n * (col === 0 ? C.conversions + V.conversions : C.n + V.n - C.conversions - V.conversions)) / (C.n + V.n)));
      row = {
        variant: V.name, control: C.name, rate_variant: pv, rate_control: pc,
        absolute_lift: diff, absolute_lift_ci: [diff - zc * se1, diff + zc * se1],
        relative_lift: pc > 0 ? ratio - 1 : null,
        relative_lift_ci: canRatio ? [Math.exp(Math.log(ratio) - zc * seLog) - 1, Math.exp(Math.log(ratio) + zc * seLog) - 1] : null,
        test: 'Two-proportion z-test (pooled)', statistic: { name: 'z', value: z }, p_value: p,
        effect_size: { name: "Cohen's h", value: hOf(pc, pv) },
        ...(minExp < 5 && C.n + V.n <= 1e6 ? { fisher_exact_p: fisherTwoSided(table) } : {}),
      };
      if (minExp < 5) warnings.push(`${V.name} vs ${C.name}: some expected counts are below 5, so the z-test is rough; use Fisher's exact p (${fmt(row.fisher_exact_p)}).`);
    } else {
      const diff = V.mean - C.mean;
      const a1 = C.sd ** 2 / C.n, a2 = V.sd ** 2 / V.n, se = Math.sqrt(a1 + a2);
      const df = (a1 + a2) ** 2 / (a1 ** 2 / (C.n - 1) + a2 ** 2 / (V.n - 1));
      const t = se > 0 ? diff / se : 0;
      const tc = inverseTCDF(1 - (1 - confidence) / 2, df);
      const canRatio = C.mean > 0 && V.mean > 0;
      const seLog = canRatio ? Math.sqrt(a2 / V.mean ** 2 + a1 / C.mean ** 2) : NaN;
      const sp = Math.sqrt(((C.n - 1) * C.sd ** 2 + (V.n - 1) * V.sd ** 2) / (C.n + V.n - 2));
      row = {
        variant: V.name, control: C.name, mean_variant: V.mean, mean_control: C.mean,
        absolute_lift: diff, absolute_lift_ci: [diff - tc * se, diff + tc * se],
        relative_lift: C.mean !== 0 ? diff / C.mean : null,
        relative_lift_ci: canRatio ? [Math.exp(Math.log(V.mean / C.mean) - zc * seLog) - 1, Math.exp(Math.log(V.mean / C.mean) + zc * seLog) - 1] : null,
        test: "Welch's t-test", statistic: { name: 't', value: t }, df, p_value: se > 0 ? tPValue(t, df, alternative) : 1,
        effect_size: { name: "Cohen's d", value: sp > 0 ? diff / sp : 0 },
      };
    }
    raw.push(row);
  }
  const method = raw.length > 1 ? (spec.correction ?? 'holm') : 'none';
  const adj = adjustP(raw.map((r) => r.p_value), method);
  raw.forEach((r, i) => {
    r.p_adjusted = adj[i];
    r.significant = adj[i] < alpha;
    r.direction = r.absolute_lift > 0 ? 'better' : r.absolute_lift < 0 ? 'worse' : 'same';
    if (spec.mde != null) {
      const [lo, hi] = r.absolute_lift_ci;
      r.practical = lo >= spec.mde ? 'lift is at least the minimum that matters' : hi < spec.mde ? 'lift is below the minimum that matters' : 'unclear whether the lift reaches the minimum that matters';
    }
  });

  // 5. Bayesian view.
  let bayes = null;
  if (spec.bayesian !== false) {
    if (metric === 'conversion') bayes = bayesConversion(variants, ci, spec.prior ?? { alpha: 1, beta: 1 });
    else {
      bayes = {
        model: 'Normal approximation with a flat prior',
        variants: variants.map((v, i) => {
          if (i === ci) return { name: v.name, prob_beats_control: null };
          const r = raw.find((x) => x.variant === v.name);
          const se = Math.sqrt(C.sd ** 2 / C.n + v.sd ** 2 / v.n);
          return { name: v.name, prob_beats_control: se > 0 ? normalCDF(r.absolute_lift / se) : 0.5 };
        }),
      };
    }
  }

  // 6. What the test could detect (80% power, its own α).
  const nC = C.n, nMin = Math.min(...variants.map((v) => v.n));
  const nH = (2 * nC * nMin) / (nC + nMin);
  const es = solveEs(nH, raw.length > 1 ? alpha / raw.length : alpha, 0.8, alternative === 'two-sided');
  const mde = metric === 'conversion'
    ? (() => { const p1 = C.conversions / C.n; if (!(p1 > 0 && p1 < 1)) return null; const p2 = rateForH(p1, es); return { absolute: p2 - p1, relative: (p2 - p1) / p1, cohens_h: es }; })()
    : { absolute: es * Math.sqrt(variants.reduce((s, v) => s + (v.n - 1) * v.sd ** 2, 0) / variants.reduce((s, v) => s + v.n - 1, 0)), cohens_d: es };
  const mdeInfo = mde && { ...mde, power: 0.8, basis: `harmonic mean of the control and the smallest variant (${Math.round(nH)} per variant)` };

  // Verdict.
  const winners = raw.filter((r) => r.significant && (alternative === 'less' ? r.direction === 'worse' : r.direction === 'better'));
  const losers = raw.filter((r) => r.significant && r.direction === 'worse' && alternative !== 'less');
  let decision;
  if (srm.mismatch) decision = 'Do not decide yet: fix the sample ratio mismatch first.';
  else if (winners.length) {
    const best = [...winners].sort((x, y) => (alternative === 'less' ? x.absolute_lift - y.absolute_lift : y.absolute_lift - x.absolute_lift))[0];
    decision = `${best.variant} beats ${C.name}${winners.length > 1 ? ` (${winners.length} variants beat the control; ${best.variant} has the largest lift)` : ''}.`;
  } else if (losers.length) decision = `No variant beats ${C.name}; ${losers.map((r) => r.variant).join(', ')} ${losers.length > 1 ? 'are' : 'is'} significantly worse.`;
  else decision = `No significant difference from ${C.name}.${mdeInfo ? ` The test could reliably detect lifts of about ${metric === 'conversion' ? `${pp(mdeInfo.absolute)} (${rel(mdeInfo.relative)})` : fmt(mdeInfo.absolute)} or more; smaller real effects may have been missed.` : ''}`;

  notes.push('Analyse once, at the planned sample size: checking repeatedly and stopping when p < α inflates false positives.');
  notes.push('A lift measured in the first days can fade (novelty effect); run whole weeks and watch the trend.');
  if (raw.length > 1) notes.push(`${raw.length} comparisons with the control: p-values are ${method === 'none' ? 'NOT adjusted (more chances of a false winner)' : `${method === 'holm' ? 'Holm' : 'Bonferroni'}-adjusted`}.`);
  if (metric === 'continuous') notes.push('Revenue-type metrics are often skewed by a few big values; with large samples the t-test is still reliable, but check outliers before trusting a lift.');

  const unit = metric === 'conversion';
  const summary = [
    `A/B test (${unit ? 'conversion rate' : 'mean'}), control = ${C.name}${alternative !== 'two-sided' ? `, one-sided (${alternative})` : ''}`,
    `Traffic: ${per.map((v) => `${v.name} ${v.n.toLocaleString('en-US')}`).join(', ')}; SRM check ${srm.mismatch ? `FAILED (p = ${fmt(srm.p_value)})` : `ok (p = ${fmt(srm.p_value)})`}`,
    ...per.map((v) => unit
      ? `  ${v.name}: ${v.conversions.toLocaleString('en-US')}/${v.n.toLocaleString('en-US')} = ${pct(v.rate)} [${pct(v.ci_lower)}, ${pct(v.ci_upper)}]`
      : `  ${v.name}: mean ${fmt(v.mean)} (SD ${fmt(v.sd)}) [${fmt(v.ci_lower)}, ${fmt(v.ci_upper)}]`),
    ...(omnibus ? [`Overall: ${omnibus.test}, ${formatPEq(omnibus.p_value)}${omnibus.significant ? ' (variants differ)' : ''}`] : []),
    ...raw.map((r) => `  ${r.significant ? '★ ' : ''}${r.variant} vs ${r.control}: ${unit ? `${pp(r.absolute_lift)} [${pp(r.absolute_lift_ci[0])}, ${pp(r.absolute_lift_ci[1])}]` : `${fmt(r.absolute_lift)} [${fmt(r.absolute_lift_ci[0])}, ${fmt(r.absolute_lift_ci[1])}]`}, relative ${rel(r.relative_lift)}${r.relative_lift_ci ? ` [${rel(r.relative_lift_ci[0])}, ${rel(r.relative_lift_ci[1])}]` : ''}, ${formatPEq(r.p_value)}${raw.length > 1 ? ` (adjusted ${fmt(r.p_adjusted)})` : ''}${r.practical ? `; ${r.practical}` : ''}`),
    ...(postHoc ? tukeyLines(postHoc, omnibus.significant) : []),
    ...(bayes ? [`Bayesian (${bayes.model}): ${bayes.variants.filter((v) => v.prob_beats_control != null).map((v) => `P(${v.name} > ${C.name}) = ${pct(v.prob_beats_control, 1)}`).join(', ')}${bayes.variants[0].prob_best != null ? `; P(best): ${bayes.variants.map((v) => `${v.name} ${pct(v.prob_best, 1)}`).join(', ')}` : ''}`] : []),
    `Decision: ${decision}`,
  ];
  return {
    data: {
      test: variants.length > 2 ? 'A/B/n test' : 'A/B test', metric, control: C.name, alternative, alpha, confidence,
      variants: per, sample_ratio_check: srm, ...(omnibus && { omnibus }), comparisons: raw,
      correction: method, ...(postHoc && { post_hoc: postHoc }), ...(bayes && { bayesian: bayes }),
      ...(mdeInfo && { minimum_detectable_effect: mdeInfo }),
      // The p-value behind the decision: the comparison's own, or the smallest adjusted one.
      p_value: raw.length === 1 ? raw[0].p_value : Math.min(...raw.map((r) => r.p_adjusted)),
      significant: raw.some((r) => r.significant),
      ...(raw.length === 1 && { statistic: raw[0].statistic, effect_size: raw[0].effect_size, confidence_interval: { level: confidence, of: unit ? 'difference in conversion rate (variant − control)' : 'difference in means (variant − control)', lower: raw[0].absolute_lift_ci[0], upper: raw[0].absolute_lift_ci[1] } }),
      decision, interpretation: decision, notes, warnings,
    },
    summary,
  };
}

/**
 * Power of the planned A/B comparison (guided step 4): the control against the smallest variant, for the
 * smallest absolute lift that matters. α is Bonferroni-split over the comparisons with the control.
 */
export function abPower({ metric, variants, controlIndex = 0, effect, alpha, alternative = 'two-sided', power = 0.8 }) {
  const C = variants[controlIndex];
  const others = variants.filter((_, i) => i !== controlIndex);
  const comparisons = Math.max(1, others.length);
  const alphaEach = alpha / comparisons;
  const twoSided = alternative === 'two-sided';
  const nMin = Math.min(...others.map((v) => v.n));
  const nH = (2 * C.n * nMin) / (C.n + nMin);
  let es, unit, baseline;
  if (metric === 'conversion') {
    baseline = C.conversions / C.n;
    if (!(baseline > 0 && baseline < 1)) throw new UserError('The control conversion rate is 0% or 100%, so power cannot be computed.');
    const p2 = baseline + effect;
    if (!(p2 > 0 && p2 < 1)) throw new UserError('baseline + smallest_effect must be a rate between 0 and 1.');
    es = Math.abs(hOf(baseline, p2));
    unit = 'absolute lift in conversion rate';
  } else {
    const sp = Math.sqrt(variants.reduce((s, v) => s + (v.n - 1) * v.sd ** 2, 0) / variants.reduce((s, v) => s + v.n - 1, 0));
    es = Math.abs(effect) / sp;
    unit = 'absolute difference in the mean';
  }
  if (!(es > 0)) throw new UserError('smallest_effect must be different from zero.');
  const achieved = powerZ(es * Math.sqrt(nH / 2), alphaEach, twoSided);
  const needed = solveN(es, alphaEach, power, twoSided);
  return { power: achieved, needed, n: Math.round(nH), unit, alpha_per_comparison: alphaEach, standardized: es, baseline };
}
