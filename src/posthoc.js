// Tukey HSD post-hoc comparisons for a one-way ANOVA, from group means, sizes and the ANOVA's
// within-group mean square. Works the same for in-memory data and one-pass summaries of large files.
// The studentized range distribution is the app's (src/lib/statsUtils.js, checked against SciPy);
// it lives here rather than in src/engine so the synced engine files stay identical to the app's.
import { normalCDF, tCDF, gammaLn } from './engine/statsUtils.js';
import { fmt } from './stats.js';

// ------------------------------------------------------------------ studentized range

const gaussLegendre = (n) => {
  const x = new Array(n), w = new Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos(Math.PI * (i + 0.75) / (n + 0.5)), pp = 0;
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = z;
      for (let k = 2; k <= n; k++) { const p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k; p0 = p1; p1 = p2; }
      pp = n * (z * p1 - p0) / (z * z - 1);
      const dz = p1 / pp;
      z -= dz;
      if (Math.abs(dz) < 1e-15) break;
    }
    x[i] = z;
    w[i] = 2 / ((1 - z * z) * pp * pp);
  }
  return { x, w };
};
const GL48 = gaussLegendre(48);
const GL16 = gaussLegendre(16);

/** Fixed 16-point Gauss-Legendre on each of `panels` equal pieces of [a, b]. */
export function glPanels(f, a, b, panels) {
  const h = (b - a) / panels;
  let s = 0;
  for (let p = 0; p < panels; p++) {
    const c = a + (p + 0.5) * h;
    for (let i = 0; i < 16; i++) s += GL16.w[i] * f(c + (h / 2) * GL16.x[i]);
  }
  return (s * h) / 2;
}

/** P(range of k independent standard normals <= r): the df = infinity case. */
function normalRangeCDF(r, k) {
  let s = 0;
  for (let i = 0; i < GL48.x.length; i++) {
    const z = 8 * GL48.x[i];
    const phi = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
    const t = Math.max(normalCDF(z) - normalCDF(z - r), 0);
    s += GL48.w[i] * phi * Math.pow(t, k - 1);
  }
  return k * 8 * s;
}

/** P(Q <= q) for the studentized range with k groups and df degrees of freedom. */
export function studentizedRangeCDF(q, k, df) {
  if (!(q > 0) || k < 2) return 0;
  if (k === 2) return Math.max(0, Math.min(1, 2 * tCDF(q / Math.SQRT2, df) - 1)); // Q = sqrt(2)|t|
  if (!isFinite(df) || df > 4000) return normalRangeCDF(q, k);
  // E[G(q*S)] with S = sqrt(chi-square_df / df), as an integral over u ~ Gamma(df/2, 1).
  const a = df / 2;
  const mode = Math.max(a - 1, 0.135);
  const base = (a - 1) * Math.log(mode) - mode - gammaLn(a);
  const f = (u) => {
    if (u <= 0) return 0;
    const logK = (a - 1) * Math.log(u) - u - gammaLn(a);
    return Math.exp(logK - base) * normalRangeCDF(q * Math.sqrt((2 * u) / df), k);
  };
  const sd = Math.sqrt(a);
  const lo = Math.max(0, mode - 10 * sd - 2);
  const hi = mode + 12 * sd + 20;
  // t = sqrt(u) smooths the square-root edge at u = 0 (matters for very small df).
  const integral = glPanels((t) => 2 * t * f(t * t), Math.sqrt(lo), Math.sqrt(hi), 12);
  return Math.max(0, Math.min(1, Math.exp(base) * integral));
}

/** Upper-tail p-value P(Q >= q). */
export const studentizedRangePValue = (q, k, df) => (!(q > 0) || k < 2 ? 1 : Math.max(0, Math.min(1, 1 - studentizedRangeCDF(q, k, df))));

/** The q with P(Q >= q) = alpha (bisection). */
export function studentizedRangeQuantile(alpha, k, df) {
  let lo = 0, hi = 40;
  for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (studentizedRangePValue(mid, k, df) > alpha) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// ------------------------------------------------------------------ compact letter display

/**
 * Letters per group: groups that share a letter are not significantly different (insert-and-absorb,
 * Piepho 2004). Letters are assigned from the highest mean down, so "a" marks the top group(s).
 */
export function compactLetters(groups, differentPairs) {
  const names = groups.map((g) => g.name);
  let cols = [new Set(names)];
  for (const [x, y] of differentPairs) {
    const next = [];
    for (const c of cols) {
      if (c.has(x) && c.has(y)) {
        const c1 = new Set(c); c1.delete(x);
        const c2 = new Set(c); c2.delete(y);
        next.push(c1, c2);
      } else next.push(c);
    }
    // Absorb: drop empty columns and columns contained in another one.
    cols = next.filter((c, i) => c.size && !next.some((d, j) => j !== i && d.size >= c.size && [...c].every((v) => d.has(v)) && (d.size > c.size || j < i)));
  }
  const byMean = [...groups].sort((p, q) => q.mean - p.mean).map((g) => g.name);
  cols.sort((c1, c2) => Math.min(...[...c1].map((n) => byMean.indexOf(n))) - Math.min(...[...c2].map((n) => byMean.indexOf(n))));
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const letter = (i) => (i < 26 ? alphabet[i] : alphabet[Math.floor(i / 26) - 1] + alphabet[i % 26]);
  const out = Object.fromEntries(names.map((n) => [n, '']));
  cols.forEach((c, i) => { for (const n of c) out[n] += letter(i); });
  return out;
}

// ------------------------------------------------------------------ Tukey HSD

/**
 * groups: [{ name, n, mean }]; msWithin and dfWithin from the ANOVA.
 * Differences are first − second, as in scipy.stats.tukey_hsd (mean_i − mean_j).
 */
export function tukeyHSD(groups, msWithin, dfWithin, alpha = 0.05) {
  const k = groups.length;
  if (k < 2 || !(msWithin > 0) || !(dfWithin > 0)) return null;
  const qCrit = studentizedRangeQuantile(alpha, k, dfWithin);
  const comparisons = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
    const A = groups[i], B = groups[j];
    const diff = A.mean - B.mean;
    const se = Math.sqrt((msWithin / 2) * (1 / A.n + 1 / B.n)); // Tukey–Kramer for unequal sizes
    const q = Math.abs(diff) / (se || 1e-300);
    const p = studentizedRangePValue(q, k, dfWithin);
    comparisons.push({
      groups: [A.name, B.name], mean_difference: diff, q, p_adjusted: p, significant: p < alpha,
      ci_lower: diff - qCrit * se, ci_upper: diff + qCrit * se,
      higher: diff > 0 ? A.name : diff < 0 ? B.name : null,
    });
  }
  const sig = comparisons.filter((c) => c.significant);
  const letters = compactLetters(groups, sig.map((c) => c.groups));
  const sorted = [...groups].sort((x, y) => y.mean - x.mean);
  const beats = (g) => sig.filter((c) => c.higher === g).map((c) => (c.groups[0] === g ? c.groups[1] : c.groups[0]));
  const top = sorted[0], bottom = sorted[sorted.length - 1];
  const topBeats = beats(top.name);
  return {
    method: `Tukey HSD${new Set(groups.map((g) => g.n)).size > 1 ? ' (Tukey–Kramer, unequal group sizes)' : ''}`,
    alpha, family_confidence: 1 - alpha, q_critical: qCrit, df_within: dfWithin,
    comparisons,
    significant_pairs: sig.map((c) => ({ higher: c.higher, lower: c.groups[0] === c.higher ? c.groups[1] : c.groups[0], mean_difference: Math.abs(c.mean_difference), p_adjusted: c.p_adjusted })),
    groups_that_differ: [...new Set(sig.flatMap((c) => c.groups))],
    letters,
    highlight: {
      highest: { group: top.name, mean: top.mean, significantly_above: topBeats, above_all_others: topBeats.length === k - 1 },
      lowest: { group: bottom.name, mean: bottom.mean, significantly_below: sig.filter((c) => c.higher && c.higher !== bottom.name && c.groups.includes(bottom.name)).map((c) => c.higher) },
    },
  };
}

/** Plain-language lines that highlight the significant groups. */
export function tukeyLines(t, omnibusSignificant) {
  if (!t) return [];
  const lines = [`Tukey HSD post-hoc (family-wise α = ${t.alpha}):`];
  if (!t.significant_pairs.length) {
    lines.push('  No pair of groups differs significantly after adjusting for multiple comparisons.');
    if (omnibusSignificant) lines.push('  The ANOVA is significant but no single pair is: the difference is spread over several groups, or the test is borderline.');
    return lines;
  }
  for (const s of t.significant_pairs) lines.push(`  ★ ${s.higher} > ${s.lower}: difference ${fmt(s.mean_difference)}, adjusted p = ${fmt(s.p_adjusted)}`);
  const h = t.highlight.highest;
  lines.push(h.above_all_others
    ? `  Best: ${h.group} (mean ${fmt(h.mean)}) is significantly higher than every other group.`
    : `  Highest mean: ${h.group} (${fmt(h.mean)})${h.significantly_above.length ? `, significantly above ${h.significantly_above.join(', ')}` : ', but not significantly above the others'}.`);
  lines.push(`  Groups sharing a letter do not differ: ${Object.entries(t.letters).map(([g, l]) => `${g} ${l}`).join(', ')}`);
  if (!omnibusSignificant) lines.push('  Note: the overall ANOVA was not significant; treat these pairwise findings with caution.');
  return lines;
}
