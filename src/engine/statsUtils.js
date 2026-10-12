// Synced from the Stats Explorer app (src/lib) by scripts/sync-engine.mjs. Do not edit here;
// change the app and re-run the sync so both stay identical.
// Shared statistical utility functions for all tools
const applyDemoValueLimit = (values) => values;
export const parseData = (str) => {
    if (!str) return [];
    return applyDemoValueLimit(str.split(',').map(v => parseFloat(v.trim())).filter(v => !isNaN(v)));
};

export const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

// Spread-free min/max — safe and fast for very large arrays
export const arrayMin = (arr) => arr.length ? arr.reduce((m, v) => (v < m ? v : m), Infinity) : 0;
export const arrayMax = (arr) => arr.length ? arr.reduce((m, v) => (v > m ? v : m), -Infinity) : 0;

export const variance = (arr) => {
    const m = mean(arr);
    return arr.reduce((sum, v) => sum + Math.pow(v - m, 2), 0) / (arr.length - 1);
};

export const stdDev = (arr) => Math.sqrt(variance(arr));

export const median = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

export const percentile = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

export const mode = (arr) => {
    const freq = {};
    arr.forEach(v => freq[v] = (freq[v] || 0) + 1);
    let maxFreq = 0, modes = [];
    Object.entries(freq).forEach(([v, f]) => {
        if (f > maxFreq) { maxFreq = f; modes = [parseFloat(v)]; }
        else if (f === maxFreq) { modes.push(parseFloat(v)); }
    });
    return modes;
};

export const skewness = (arr) => {
    const m = mean(arr);
    const s = stdDev(arr);
    const n = arr.length;
    return (n / ((n - 1) * (n - 2))) * arr.reduce((sum, v) => sum + Math.pow((v - m) / s, 3), 0);
};

export const kurtosis = (arr) => {
    const m = mean(arr);
    const s = stdDev(arr);
    const n = arr.length;
    return (n * (n + 1) / ((n - 1) * (n - 2) * (n - 3))) * arr.reduce((sum, v) => sum + Math.pow((v - m) / s, 4), 0) - (3 * Math.pow(n - 1, 2)) / ((n - 2) * (n - 3));
};

// Normal CDF, via the regularized incomplete gamma function (accurate to ~1e-14,
// unlike the 7-digit Abramowitz-Stegun shortcut it replaces).
export const normalCDF = (z) => {
    if (!isFinite(z)) return z > 0 ? 1 : 0;
    const q = 0.5 * gammaQ(0.5, (z * z) / 2); // = P(Z > |z|)
    return z >= 0 ? 1 - q : q;
};

// Inverse normal CDF (Beasley-Springer-Moro)
export const inverseNormalCDF = (p) => {
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const plow = 0.02425;
    const phigh = 1 - plow;
    if (p < plow) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= phigh) {
        const q = p - 0.5;
        const r = q * q;
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
};

// Inverse t CDF: solved numerically from tCDF (accurate for any df, unlike a
// series approximation, which understates critical values for small samples).
export const inverseTCDF = (p, df) => {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    if (p === 0.5) return 0;
    if (p < 0.5) return -inverseTCDF(1 - p, df);
    let lo = 0, hi = 1;
    while (tCDF(hi, df) < p && hi < 1e8) hi *= 2;
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        if (tCDF(mid, df) < p) lo = mid; else hi = mid;
        if (hi - lo < 1e-12 * Math.max(1, hi)) break;
    }
    return (lo + hi) / 2;
};

export const gammaLn = (x) => {
    const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.001208650973866179, -0.5395239384953e-5];
    let y = x;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
};

// Continued fraction for the incomplete beta function (modified Lentz method).
const betaContinuedFraction = (x, a, b) => {
    const maxIterations = 300;
    const epsilon = 3e-16;
    const tiny = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1;
    let d = 1 - qab * x / qap;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= maxIterations; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
        c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
        c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < epsilon) break;
    }
    return h;
};

// Regularized incomplete beta function I_x(a, b).
export const incompleteBeta = (x, a, b) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lnFront = gammaLn(a + b) - gammaLn(a) - gammaLn(b) + a * Math.log(x) + b * Math.log(1 - x);
    // Use the symmetry I_x(a,b) = 1 - I_(1-x)(b,a) where the fraction converges fastest.
    if (x < (a + 1) / (a + b + 2)) {
        return Math.exp(lnFront) * betaContinuedFraction(x, a, b) / a;
    }
    return 1 - Math.exp(lnFront) * betaContinuedFraction(1 - x, b, a) / b;
};

export const tCDF = (t, df) => {
    const x = df / (df + t * t);
    const a = df / 2;
    const b = 0.5;
    return t > 0 ? 1 - 0.5 * incompleteBeta(x, a, b) : 0.5 * incompleteBeta(x, a, b);
};

// Regularized lower (P) and upper (Q) incomplete gamma functions.
const gammaSeries = (x, a) => {
    let sum = 1 / a, term = 1 / a;
    for (let n = 1; n <= 500; n++) {
        term *= x / (a + n);
        sum += term;
        if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gammaLn(a));
};
const gammaContinuedFraction = (x, a) => {
    const tiny = 1e-300;
    let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
    for (let i = 1; i <= 500; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
        c = b + an / c; if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < 1e-16) break;
    }
    return Math.exp(-x + a * Math.log(x) - gammaLn(a)) * h;
};
export const gammaCDF = (x, a) => {
    if (x <= 0) return 0;
    if (a <= 0) return 1;
    return x < a + 1 ? gammaSeries(x, a) : 1 - gammaContinuedFraction(x, a);
};
export const gammaQ = (a, x) => {
    if (x <= 0) return 1;
    return x < a + 1 ? 1 - gammaSeries(x, a) : gammaContinuedFraction(x, a);
};

export const chiSquareCDF = (x, df) => {
    if (x <= 0) return 0;
    return gammaCDF(x / 2, df / 2);
};

// Upper-tail p-values computed directly (no 1 - CDF), so tiny p-values stay accurate.
export const tPValueTwoSided = (t, df) => incompleteBeta(df / (df + t * t), df / 2, 0.5);
export const normalPValueTwoSided = (z) => gammaQ(0.5, (z * z) / 2);
export const chiSquarePValue = (x, df) => (x <= 0 ? 1 : gammaQ(df / 2, x / 2));
export const fPValue = (f, df1, df2) => (f <= 0 ? 1 : incompleteBeta(df2 / (df2 + df1 * f), df2 / 2, df1 / 2));

export const fCDF = (f, df1, df2) => {
    if (f <= 0) return 0;
    const x = df1 * f / (df1 * f + df2);
    return incompleteBeta(x, df1 / 2, df2 / 2);
};

export const factorial = (n) => {
    if (n <= 1) return 1;
    let result = 1;
    for (let i = 2; i <= n; i++) result *= i;
    return result;
};

export const binomialPMF = (n, k, p) => {
    if (k > n || k < 0) return 0;
    const logCoeff = gammaLn(n + 1) - gammaLn(k + 1) - gammaLn(n - k + 1);
    return Math.exp(logCoeff + k * Math.log(p) + (n - k) * Math.log(1 - p));
};

// Confidence interval for mean
export const meanCI = (data, confidence = 0.95) => {
    const n = data.length;
    const m = mean(data);
    const s = stdDev(data);
    const alpha = 1 - confidence;
    // Population SD unknown, so the t distribution is correct at every sample size.
    const tCrit = inverseTCDF(1 - alpha / 2, n - 1);
    const margin = tCrit * (s / Math.sqrt(n));
    return { lower: m - margin, upper: m + margin, margin, criticalValue: tCrit, method: 't', point: m };
};

export const proportionCI = (successes, n, confidence = 0.95) => {
    const pHat = successes / n;
    const alpha = 1 - confidence;
    const z = inverseNormalCDF(1 - alpha / 2);
    const denominator = 1 + z * z / n;
    const center = (pHat + z * z / (2 * n)) / denominator;
    const margin = (z * Math.sqrt(pHat * (1 - pHat) / n + z * z / (4 * n * n))) / denominator;
    return { lower: center - margin, upper: center + margin, margin, point: pHat, method: 'Wilson' };
};

// Cohen's d
export const cohensD = (group1, group2) => {
    const m1 = mean(group1), m2 = mean(group2);
    const s1 = stdDev(group1), s2 = stdDev(group2);
    const n1 = group1.length, n2 = group2.length;
    const pooledSD = Math.sqrt(((n1 - 1) * s1 * s1 + (n2 - 1) * s2 * s2) / (n1 + n2 - 2));
    return (m1 - m2) / pooledSD;
};

// Statistical power for two-sample t-test (normal approximation)
export const tTestPower = (effectSize, nPerGroup, alpha = 0.05, twoSided = true) => {
    const zAlpha = twoSided ? inverseNormalCDF(1 - alpha / 2) : inverseNormalCDF(1 - alpha);
    const noncentrality = effectSize * Math.sqrt(nPerGroup / 2);
    const power = twoSided
        ? 1 - normalCDF(zAlpha - noncentrality) + normalCDF(-zAlpha - noncentrality)
        : 1 - normalCDF(zAlpha - noncentrality);
    return Math.max(0, Math.min(1, power));
};

// Identify distribution type
export const identifyDistribution = (data) => {
    if (data.length < 5) return { name: 'Insufficient data', description: 'Need at least 5 data points to analyze distribution.' };
    const n = data.length;
    const m = mean(data);
    const med = median(data);
    const s = stdDev(data);
    const sk = skewness(data);
    const exKurt = n > 3 ? kurtosis(data) : 0; // excess kurtosis: 0 for a normal distribution
    const min = arrayMin(data), max = arrayMax(data);

    // Bimodality: a smoothed histogram must show two substantial peaks with a clear dip
    // between them, AND Sarle's bimodality coefficient must exceed the uniform benchmark (5/9).
    let bimodal = false;
    if (n >= 20 && max > min) {
        const k = Math.max(8, Math.min(20, Math.round(Math.sqrt(n))));
        const w = (max - min) / k;
        const bins = new Array(k).fill(0);
        for (const v of data) bins[Math.min(k - 1, Math.floor((v - min) / w))]++;
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

    let distribution, description;
    if (bimodal) {
        distribution = 'Bimodal';
        description = 'The data shows two distinct peaks, suggesting two underlying groups or populations are mixed together.';
    } else if (sk > 0.5) {
        distribution = 'Right-Skewed';
        description = 'The data has a long tail to the right. Most values cluster at the lower end with a few high values. Common for income, reaction times, and count data.';
    } else if (sk < -0.5) {
        distribution = 'Left-Skewed';
        description = 'The data has a long tail to the left. Most values are high with a few low values. Common for scores with a ceiling effect.';
    } else if (Math.abs(exKurt) < 1) {
        distribution = 'Approximately Normal';
        description = 'The data is roughly bell-shaped and symmetric (skewness near 0, excess kurtosis near 0), consistent with a normal distribution.';
    } else if (exKurt <= -1) {
        distribution = 'Uniform';
        description = 'The data is spread fairly evenly across its range with no clear peak (flat, light tails), like a uniform distribution.';
    } else {
        distribution = 'Approximately Symmetric (Non-normal)';
        description = 'The data is roughly symmetric but has heavier tails than a normal curve, so extreme values are more common than a bell curve predicts.';
    }
    return { name: distribution, description, skewness: sk, kurtosis: exKurt, mean: m, median: med, stdDev: s, min, max };
};
// The histogram bin (labelled by its start value) that contains `value`.
// Compares numerically: the last bin whose start is <= value.
export const binForValue = (bins, value) => {
    if (!bins || !bins.length || value == null || isNaN(value)) return undefined;
    let match = bins[0];
    for (const b of bins) { if (parseFloat(b.range) <= value) match = b; }
    return match?.range;
};

// P-value display: very small p-values are reported as "< 0.0001", never "0.0000".
export const formatP = (p) => (p == null || isNaN(p) ? 'N/A' : p < 0.0001 ? '< 0.0001' : p.toFixed(4));
// "p = 0.0123" or "p < 0.0001", for sentences.
export const formatPEq = (p) => (p == null || isNaN(p) ? 'p = N/A' : p < 0.0001 ? 'p < 0.0001' : `p = ${p.toFixed(4)}`);
