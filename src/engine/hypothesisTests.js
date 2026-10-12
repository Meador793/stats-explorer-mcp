// Synced from the Stats Explorer app (src/lib) by scripts/sync-engine.mjs. Do not edit here;
// change the app and re-run the sync so both stay identical.
// Pure hypothesis-test calculations (no React), so they can be tested directly.
import { parseData, mean, variance, stdDev, binomialPMF, tPValueTwoSided, normalPValueTwoSided, chiSquarePValue, fPValue } from './statsUtils.js';
import { getAnovaGroupLabels } from './hypothesisUtils.js';

export function matrixDet(m) {
    const n = m.length;
    if (n === 1) return m[0][0];
    if (n === 2) return m[0][0] * m[1][1] - m[0][1] * m[1][0];
    let det = 0;
    for (let j = 0; j < n; j++) {
        const minor = m.slice(1).map(row => row.filter((_, c) => c !== j));
        det += ((j % 2 === 0) ? 1 : -1) * m[0][j] * matrixDet(minor);
    }
    return det;
}

/** Runs the selected test. Throws an Error with a user-facing message on bad input. */
export function computeTest(selectedTest, variables, dataset) {
    let result = null;
    switch (selectedTest) {
        case 'ttest': {
            const group1 = parseData(variables.group1);
            if (group1.length === 0) throw new Error('Please enter data for Group 1');
            const testType = variables.testType || 'one-sample';
            if (testType === 'one-sample') {
                const mu0 = parseFloat(variables.populationMean) || 0;
                const xbar = mean(group1);
                const s = stdDev(group1);
                const n = group1.length;
                const t = (xbar - mu0) / (s / Math.sqrt(n));
                const df = n - 1;
                const pValue = tPValueTwoSided(t, df);
                const g1Name = (variables.group1Name || '').trim() || 'Sample';
                result = {
                    testStatistic: t, statisticName: 't', pValue, df, dfLabel: 'Degrees of Freedom',
                    additionalStats: { [`Mean (${g1Name})`]: xbar, [`Std Dev (${g1Name})`]: s, 'Sample Size': n, 'Hypothesized μ₀': mu0 },
                    interpretation: `The mean of ${g1Name} (${xbar.toFixed(2)}) ${xbar > mu0 ? 'exceeds' : 'is below'} the hypothesized mean (${mu0}).`
                };
            } else {
                const group2 = parseData(variables.group2);
                if (group2.length === 0) throw new Error('Please enter data for Group 2');
                const g1Name = (variables.group1Name || '').trim() || 'Group 1';
                const g2Name = (variables.group2Name || '').trim() || 'Group 2';
                const n1 = group1.length, n2 = group2.length;
                const mean1 = mean(group1), mean2 = mean(group2);
                const var1 = variance(group1), var2 = variance(group2);
                let t, df;
                if (testType === 'paired') {
                    if (n1 !== n2) throw new Error('Paired t-test requires equal sample sizes');
                    const diffs = group1.map((v, i) => v - group2[i]);
                    const dMean = mean(diffs);
                    const dStd = stdDev(diffs);
                    t = dMean / (dStd / Math.sqrt(n1));
                    df = n1 - 1;
                } else {
                    const pooledVar = ((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2);
                    t = (mean1 - mean2) / Math.sqrt(pooledVar * (1 / n1 + 1 / n2));
                    df = n1 + n2 - 2;
                }
                const pValue = tPValueTwoSided(t, df);
                result = {
                    testStatistic: t, statisticName: 't', pValue, df, dfLabel: 'Degrees of Freedom',
                    additionalStats: { [`Mean (${g1Name})`]: mean1, [`Mean (${g2Name})`]: mean2, 'Difference': mean1 - mean2, 'n₁': n1, 'n₂': n2 },
                    interpretation: `The mean difference between ${g1Name} and ${g2Name} is ${(mean1 - mean2).toFixed(2)} (${mean1 >= mean2 ? g1Name : g2Name} has the higher mean).`
                };
            }
            break;
        }
        case 'ztest': {
            if (variables.zTestType === 'proportion') {
                const x = parseFloat(variables.successes);
                const n = parseFloat(variables.sampleSize);
                const p0 = parseFloat(variables.hypothesizedProportion);
                if (isNaN(x) || isNaN(n) || isNaN(p0)) throw new Error('Please enter all required values');
                const pHat = x / n;
                const z = (pHat - p0) / Math.sqrt(p0 * (1 - p0) / n);
                const pValue = normalPValueTwoSided(z);
                result = {
                    testStatistic: z, statisticName: 'z', pValue, df: 'N/A (Normal)', dfLabel: 'Distribution',
                    additionalStats: { 'Sample Proportion': pHat, 'Hypothesized p₀': p0, 'Sample Size': n, 'Successes': x },
                    interpretation: `The observed proportion (${(pHat * 100).toFixed(1)}%) ${pHat > p0 ? 'exceeds' : 'is below'} the hypothesized proportion (${(p0 * 100).toFixed(1)}%).`
                };
            } else {
                const xbar = parseFloat(variables.sampleMean);
                const n = parseFloat(variables.sampleSize);
                const sigma = parseFloat(variables.populationStdDev);
                const mu0 = parseFloat(variables.populationMean);
                if (isNaN(xbar) || isNaN(n) || isNaN(sigma) || isNaN(mu0)) throw new Error('Please enter all required values including population standard deviation (σ)');
                const z = (xbar - mu0) / (sigma / Math.sqrt(n));
                const pValue = normalPValueTwoSided(z);
                result = {
                    testStatistic: z, statisticName: 'z', pValue, df: 'N/A (Normal)', dfLabel: 'Distribution',
                    additionalStats: { 'Sample Mean': xbar, 'Population σ': sigma, 'Sample Size': n, 'Hypothesized μ₀': mu0 },
                    interpretation: `The sample mean (${xbar.toFixed(2)}) ${xbar > mu0 ? 'exceeds' : 'is below'} the hypothesized mean (${mu0}).`
                };
            }
            break;
        }
        case 'anova': {
            const lines = (variables.groupsData || '').split('\n').filter(l => l.trim());
            if (lines.length < 2) throw new Error('Please enter at least 2 groups');
            const labels = getAnovaGroupLabels(variables);
            const groups = lines.map(line => parseData(line.replace(/^[^:]*:/, '')));
            const k = groups.length;
            const N = groups.reduce((sum, g) => sum + g.length, 0);
            const grandMean = groups.flat().reduce((a, b) => a + b, 0) / N;
            const SSB = groups.reduce((sum, g) => sum + g.length * Math.pow(mean(g) - grandMean, 2), 0);
            const SSW = groups.reduce((sum, g) => { const gMean = mean(g); return sum + g.reduce((s, v) => s + Math.pow(v - gMean, 2), 0); }, 0);
            const dfB = k - 1, dfW = N - k;
            const MSB = SSB / dfB, MSW = SSW / dfW;
            const F = MSB / MSW;
            const pValue = fPValue(F, dfB, dfW);
            const groupMeanStats = {};
            groups.forEach((g, i) => { groupMeanStats[`Mean (${labels[i]})`] = mean(g); });
            const meansSummary = groups.map((g, i) => `${labels[i]} = ${mean(g).toFixed(2)}`).join(' · ');
            result = {
                testStatistic: F, statisticName: 'F', pValue, df: `${dfB}, ${dfW}`, dfLabel: 'df (between, within)',
                additionalStats: { ...groupMeanStats, 'SS Between': SSB, 'SS Within': SSW, 'MS Between': MSB, 'MS Within': MSW, 'Groups': k, 'Total N': N },
                interpretation: `Group means: ${meansSummary}. Comparing ${k} groups with ${N} total observations. ${pValue < (parseFloat(variables.alpha) || 0.05) ? 'At least one group mean differs significantly.' : 'No significant difference between group means.'}`
            };
            break;
        }
        case 'ancova': {
            const g = variables.groupCol, yCol = variables.outcomeCol, xCol = variables.covariateCol;
            if (!dataset || !g || !yCol || !xCol) throw new Error('Select a group, outcome, and covariate column');
            const complete = dataset.rows.filter(r => r[g] != null && r[g] !== '' && typeof r[yCol] === 'number' && !isNaN(r[yCol]) && typeof r[xCol] === 'number' && !isNaN(r[xCol]));
            if (complete.length < 4) throw new Error('Not enough complete cases for ANCOVA');
            const groupVals = [...new Set(complete.map(r => r[g]))];
            const k = groupVals.length;
            if (k < 2) throw new Error('Group column must have at least 2 groups');
            const N = complete.length;
            const meanY = mean(complete.map(r => r[yCol]));
            const meanX = mean(complete.map(r => r[xCol]));
            let SStotY = 0, SSwinY = 0, SStotX = 0, SSwinX = 0, SPtot = 0, SPwin = 0;
            for (const r of complete) { SStotY += Math.pow(r[yCol] - meanY, 2); SStotX += Math.pow(r[xCol] - meanX, 2); SPtot += (r[yCol] - meanY) * (r[xCol] - meanX); }
            for (const gv of groupVals) {
                const grp = complete.filter(r => r[g] === gv);
                const gmY = mean(grp.map(r => r[yCol]));
                const gmX = mean(grp.map(r => r[xCol]));
                for (const r of grp) { SSwinY += Math.pow(r[yCol] - gmY, 2); SSwinX += Math.pow(r[xCol] - gmX, 2); SPwin += (r[yCol] - gmY) * (r[xCol] - gmX); }
            }
            if (SSwinX <= 0 || SStotX <= 0) throw new Error('Covariate has no variation');
            const SSEadj = SSwinY - (SPwin * SPwin) / SSwinX;
            const SStotAdj = SStotY - (SPtot * SPtot) / SStotX;
            const SSbetAdj = SStotAdj - SSEadj;
            const dfB = k - 1, dfE = N - k - 1;
            if (dfE <= 0) throw new Error('Not enough degrees of freedom (need more observations)');
            const F = (SSbetAdj / dfB) / (SSEadj / dfE);
            const pValue = fPValue(F, dfB, dfE);
            const slope = SPwin / SSwinX;
            result = {
                testStatistic: F, statisticName: 'F', pValue, df: `${dfB}, ${dfE}`, dfLabel: 'df (group, error)',
                additionalStats: { 'Groups': k, 'Total N': N, 'Covariate slope': slope, 'Adj. SS group': SSbetAdj, 'Adj. SS error': SSEadj, 'Outcome': yCol, 'Covariate': xCol },
                interpretation: `Comparing ${k} groups on ${yCol} adjusted for covariate ${xCol}. ${pValue < (parseFloat(variables.alpha) || 0.05) ? 'Group means differ significantly after adjusting for the covariate.' : 'No significant group difference after adjustment.'}`
            };
            break;
        }
        case 'manova': {
            const g = variables.groupCol;
            const outs = variables.outcomeCols || [];
            if (!dataset || !g) throw new Error('Select a group column');
            if (outs.length < 2) throw new Error('Select at least 2 outcome columns');
            const complete = dataset.rows.filter(r => r[g] != null && r[g] !== '' && outs.every(o => typeof r[o] === 'number' && !isNaN(r[o])));
            const groupVals = [...new Set(complete.map(r => r[g]))];
            const k = groupVals.length;
            const N = complete.length;
            if (k < 2) throw new Error('Group column must have at least 2 groups');
            if (N - k < 2) throw new Error('Not enough complete cases for MANOVA');
            const p = outs.length;
            const grandMeans = outs.map(o => mean(complete.map(r => r[o])));
            const H = Array.from({ length: p }, () => Array(p).fill(0));
            const E = Array.from({ length: p }, () => Array(p).fill(0));
            for (const gv of groupVals) {
                const grp = complete.filter(r => r[g] === gv);
                const ng = grp.length;
                const gm = outs.map(o => mean(grp.map(r => r[o])));
                for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) H[i][j] += ng * (gm[i] - grandMeans[i]) * (gm[j] - grandMeans[j]);
                for (const r of grp) for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) E[i][j] += (r[outs[i]] - gm[i]) * (r[outs[j]] - gm[j]);
            }
            const EH = H.map((row, i) => row.map((v, j) => v + E[i][j]));
            const detE = matrixDet(E), detEH = matrixDet(EH);
            if (detE <= 0 || detEH <= 0) throw new Error('Outcomes are collinear — choose less correlated outcomes');
            const Lambda = detE / detEH;
            const q = k - 1, ve = N - k;
            const cDenom = p * p + q * q - 5;
            const c = cDenom > 0 ? Math.sqrt((p * p * q * q - 4) / cDenom) : 1;
            const a = ve + q - (p + q + 1) / 2;
            const df1 = p * q;
            const df2 = a * c - p * q / 2 + 1;
            // Rao's F approximation: ((1 - Λ^(1/c)) / Λ^(1/c)) × (df2 / df1)
            const F = ((1 - Math.pow(Lambda, 1 / c)) / Math.pow(Lambda, 1 / c)) * (df2 / df1);
            const pValue = fPValue(F, df1, df2);
            result = {
                testStatistic: F, statisticName: "F (Wilks' Λ approx)", pValue, df: `${df1}, ${df2}`, dfLabel: 'df (num, den)',
                additionalStats: { "Wilks' Λ": Lambda, 'Groups': k, 'Outcomes': p, 'Total N': N },
                interpretation: `Comparing ${k} groups across ${p} outcomes jointly (Wilks' Λ = ${Lambda.toFixed(4)}). ${pValue < (parseFloat(variables.alpha) || 0.05) ? 'Group means differ significantly on the combined outcomes.' : 'No significant multivariate group difference.'}`
            };
            break;
        }
        case 'chisquare': {
            if (variables.chiTestType === 'goodness') {
                const observed = parseData(variables.observed);
                if (observed.length === 0) throw new Error('Please enter observed frequencies');
                const total = observed.reduce((a, b) => a + b, 0);
                let expected = parseData(variables.expected);
                if (expected.length === 0) expected = observed.map(() => total / observed.length);
                else if (expected.every(v => v <= 1)) expected = expected.map(v => v * total);
                const chiSq = observed.reduce((sum, o, i) => { const e = expected[i] || total / observed.length; return sum + Math.pow(o - e, 2) / e; }, 0);
                const df = observed.length - 1;
                const pValue = chiSquarePValue(chiSq, df);
                result = {
                    testStatistic: chiSq, statisticName: 'χ²', pValue, df, dfLabel: 'Degrees of Freedom',
                    additionalStats: { 'Categories': observed.length, 'Total Count': total },
                    interpretation: 'Testing whether observed frequencies match expected distribution.'
                };
            } else {
                const rows = (variables.contingencyTable || '').split('\n').filter(l => l.trim());
                if (rows.length < 2) throw new Error('Please enter at least 2 rows');
                const table = rows.map(row => parseData(row.replace(/^[^:]*:/, '')));
                const numRows = table.length, numCols = table[0]?.length || 0;
                const rowTotals = table.map(row => row.reduce((a, b) => a + b, 0));
                const colTotals = table[0].map((_, j) => table.reduce((sum, row) => sum + (row[j] || 0), 0));
                const grandTotal = rowTotals.reduce((a, b) => a + b, 0);
                let chiSq = 0;
                for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) {
                    const observed = table[i][j] || 0;
                    const expected = (rowTotals[i] * colTotals[j]) / grandTotal;
                    if (expected > 0) chiSq += Math.pow(observed - expected, 2) / expected;
                }
                const df = (numRows - 1) * (numCols - 1);
                const pValue = chiSquarePValue(chiSq, df);
                result = {
                    testStatistic: chiSq, statisticName: 'χ²', pValue, df, dfLabel: 'Degrees of Freedom',
                    additionalStats: { 'Rows': numRows, 'Columns': numCols, 'Total Count': grandTotal },
                    interpretation: `Testing independence between ${numRows} row categories and ${numCols} column categories.`
                };
            }
            break;
        }
        case 'binomial': {
            const n = parseInt(variables.trials);
            const k = parseInt(variables.successes);
            const p0 = parseFloat(variables.hypothesizedProb);
            const alternative = variables.alternative || 'two-sided';
            if (isNaN(n) || isNaN(k) || isNaN(p0)) throw new Error('Please enter all required values');
            if (k > n || k < 0) throw new Error('Successes must be between 0 and n');
            let pValue = 0;
            const observedP = k / n;
            if (alternative === 'two-sided') {
                const probK = binomialPMF(n, k, p0);
                for (let i = 0; i <= n; i++) { const prob = binomialPMF(n, i, p0); if (prob <= probK + 1e-10) pValue += prob; }
            } else if (alternative === 'greater') {
                for (let i = k; i <= n; i++) pValue += binomialPMF(n, i, p0);
            } else {
                for (let i = 0; i <= k; i++) pValue += binomialPMF(n, i, p0);
            }
            const z = (observedP - p0) / Math.sqrt(p0 * (1 - p0) / n);
            result = {
                testStatistic: z, statisticName: 'z (approx)', pValue: Math.min(pValue, 1), df: n, dfLabel: 'Number of Trials',
                additionalStats: { 'Observed Proportion': observedP, 'Hypothesized p₀': p0, 'Successes (k)': k, 'Trials (n)': n, 'Alternative': alternative },
                interpretation: `Observed ${k} successes in ${n} trials (${(observedP * 100).toFixed(1)}%) compared to expected ${(p0 * 100).toFixed(1)}%.`
            };
            break;
        }
        default:
            throw new Error('Please select a statistical test');
    }
    return result;
}
