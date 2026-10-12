// Synced from the Stats Explorer app (src/lib) by scripts/sync-engine.mjs. Do not edit here;
// change the app and re-run the sync so both stay identical.
// Least-squares regression helpers for scatter plots.

// Linear least squares: y = intercept + slope * x
export function linearRegression(points) {
    const n = points.length;
    if (n < 2) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of points) {
        sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y;
    }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    const r2 = computeR2(points, (x) => intercept + slope * x, sy / n);
    const sign = slope >= 0 ? '+' : '−';
    return {
        type: 'linear',
        slope,
        intercept,
        r2,
        predict: (x) => intercept + slope * x,
        formula: `y = ${intercept.toFixed(4)} ${sign} ${Math.abs(slope).toFixed(4)}·x`,
    };
}

// Polynomial least squares of given degree (default 2): y = c0 + c1·x + ... + cd·x^d
export function polynomialRegression(points, degree = 2) {
    const n = points.length;
    if (n < degree + 1) return null;
    const m = degree + 1;
    const A = Array.from({ length: m }, () => new Array(m).fill(0));
    const b = new Array(m).fill(0);
    for (const p of points) {
        const powers = [];
        for (let i = 0; i < 2 * degree + 1; i++) powers.push(Math.pow(p.x, i));
        for (let i = 0; i < m; i++) {
            b[i] += p.y * Math.pow(p.x, i);
            for (let j = 0; j < m; j++) A[i][j] += powers[i + j];
        }
    }
    const coeffs = gaussianSolve(A, b);
    if (!coeffs) return null;
    const r2 = computeR2(points, (x) => coeffs.reduce((s, c, i) => s + c * Math.pow(x, i), 0), points.reduce((s, p) => s + p.y, 0) / n);
    const sup = (d) => ({ 2: '²', 3: '³', 4: '⁴', 5: '⁵' }[d] || `^${d}`);
    const terms = coeffs.map((c, i) => {
        if (i === 0) return c.toFixed(4);
        const op = c >= 0 ? '+' : '−';
        const val = Math.abs(c).toFixed(4);
        const xPart = i === 1 ? '·x' : `·x${sup(i)}`;
        return `${op} ${val}${xPart}`;
    });
    return {
        type: 'polynomial',
        degree,
        coeffs,
        r2,
        predict: (x) => coeffs.reduce((s, c, i) => s + c * Math.pow(x, i), 0),
        formula: `y = ${terms.join(' ')}`,
    };
}

function computeR2(points, predict, meanY) {
    let ssTot = 0, ssRes = 0;
    for (const p of points) {
        ssTot += Math.pow(p.y - meanY, 2);
        ssRes += Math.pow(p.y - predict(p.x), 2);
    }
    return ssTot === 0 ? 1 : 1 - ssRes / ssTot;
}

function gaussianSolve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
        }
        if (Math.abs(M[piv][col]) < 1e-12) return null;
        [M[col], M[piv]] = [M[piv], M[col]];
        const pv = M[col][col];
        for (let j = col; j <= n; j++) M[col][j] /= pv;
        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const f = M[r][col];
            for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
        }
    }
    return M.map((row) => row[n]);
}