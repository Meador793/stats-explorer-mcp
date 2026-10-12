"""Builds test/reference/cases.json and test/fixtures/*.csv from SciPy and statsmodels.

Run:  python3 test/reference/generate.py     (needs numpy, scipy, statsmodels, pandas)
The JSON is committed, so `npm test` does not need Python.
"""
import json, os
import numpy as np
import pandas as pd
from scipy import stats
from scipy.stats import contingency
import statsmodels.api as sm
from statsmodels.formula.api import ols
from statsmodels.multivariate.manova import MANOVA
from statsmodels.stats.proportion import proportion_confint, proportions_ztest
from statsmodels.stats.power import NormalIndPower

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, '..', 'fixtures')
os.makedirs(FIX, exist_ok=True)
rng = np.random.default_rng(20261011)
cases = []

def r(a, d=4):
    return [round(float(v), d) for v in a]

def case(name, tool, args, expect):
    cases.append({'name': name, 'tool': tool, 'args': args,
                  'expect': {k: (None if v is None else float(v)) for k, v in expect.items()}})

def cohen_d(x, y):
    nx, ny = len(x), len(y)
    sp = np.sqrt(((nx - 1) * np.var(x, ddof=1) + (ny - 1) * np.var(y, ddof=1)) / (nx + ny - 2))
    return (np.mean(x) - np.mean(y)) / sp

# ---------------------------------------------------------------- t-tests
a = r(rng.normal(52, 8, 18)); b = r(rng.normal(47, 12, 25))
for alt, salt in [('two-sided', 'two-sided'), ('greater', 'greater'), ('less', 'less')]:
    res = stats.ttest_1samp(a, 50, alternative=salt)
    exp = {'statistic.value': res.statistic, 'p_value': res.pvalue, 'df': res.df,
           'effect_size.value': (np.mean(a) - 50) / np.std(a, ddof=1)}
    if alt == 'two-sided':
        ci = res.confidence_interval(0.95); exp |= {'confidence_interval.lower': ci.low, 'confidence_interval.upper': ci.high}
    case(f't one-sample {alt}', 't_test', {'type': 'one_sample', 'sample1': a, 'mu0': 50, 'alternative': alt}, exp)

before = r(rng.normal(100, 15, 20)); after = r(np.array(before) + rng.normal(3, 6, 20))
for alt in ['two-sided', 'less']:
    res = stats.ttest_rel(before, after, alternative=alt)
    d = np.array(before) - np.array(after)
    exp = {'statistic.value': res.statistic, 'p_value': res.pvalue, 'df': res.df, 'effect_size.value': d.mean() / d.std(ddof=1)}
    if alt == 'two-sided':
        ci = res.confidence_interval(0.95); exp |= {'confidence_interval.lower': ci.low, 'confidence_interval.upper': ci.high}
    case(f't paired {alt}', 't_test', {'type': 'paired', 'sample1': before, 'sample2': after, 'alternative': alt}, exp)

for eq in [True, False]:
    for alt in ['two-sided', 'greater']:
        res = stats.ttest_ind(a, b, equal_var=eq, alternative=alt)
        exp = {'statistic.value': res.statistic, 'p_value': res.pvalue, 'df': res.df, 'effect_size.value': cohen_d(a, b)}
        if alt == 'two-sided':
            ci = res.confidence_interval(0.90); exp |= {'confidence_interval.lower': ci.low, 'confidence_interval.upper': ci.high}
        case(f't independent equal_var={eq} {alt}', 't_test',
             {'type': 'independent', 'sample1': a, 'sample2': b, 'equal_variances': eq, 'alternative': alt, 'confidence': 0.90}, exp)

# very small p-value stays accurate
big1 = r(rng.normal(10, 1, 60)); big2 = r(rng.normal(13, 1, 60))
res = stats.ttest_ind(big1, big2)
case('t tiny p-value', 't_test', {'type': 'independent', 'sample1': big1, 'sample2': big2, 'equal_variances': True},
     {'statistic.value': res.statistic, 'p_value': res.pvalue})

# ---------------------------------------------------------------- file fixture (long format, quotes, missing)
groups = {'Control': rng.normal(20, 4, 30), 'Drug A': rng.normal(23, 4, 28), 'Drug B': rng.normal(22, 6, 26)}
rows = []
for g, vals in groups.items():
    for v in vals:
        age = rng.integers(20, 70)
        rows.append({'patient': f'P{len(rows)+1:03d}', 'group': g, 'score': round(float(v), 3), 'age': int(age),
                     'bp': round(float(120 + 0.4 * age + rng.normal(0, 8) + (4 if g == 'Drug A' else 0)), 2),
                     'chol': round(float(190 + 0.6 * age + rng.normal(0, 15) + (-8 if g == 'Drug B' else 0)), 2),
                     'improved': 'yes' if v > 21 else 'no', 'site': ['North, Clinic', 'South'][len(rows) % 2]})
df = pd.DataFrame(rows)
df_csv = df.copy().astype(object)
df_csv.loc[3, 'score'] = 'NA'; df_csv.loc[40, 'score'] = ''  # missing cells are skipped
df_csv.to_csv(os.path.join(FIX, 'trial.csv'), index=False)
dfc = df.drop(index=[3, 40])

x = dfc[dfc.group == 'Control'].score.values; y = dfc[dfc.group == 'Drug A'].score.values
res = stats.ttest_ind(x, y, equal_var=False)
case('t welch from file', 't_test', {'type': 'independent', 'file': 'trial.csv', 'column': 'score', 'group_column': 'group', 'group1': 'Control', 'group2': 'Drug A'},
     {'statistic.value': res.statistic, 'p_value': res.pvalue, 'df': res.df})

# ---------------------------------------------------------------- ANOVA
gs = [dfc[dfc.group == g].score.values for g in ['Control', 'Drug A', 'Drug B']]
res = stats.f_oneway(*gs)
allv = np.concatenate(gs); ssb = sum(len(g) * (g.mean() - allv.mean()) ** 2 for g in gs); ssw = sum(((g - g.mean()) ** 2).sum() for g in gs)
pw = stats.ttest_ind(gs[0], gs[2], equal_var=False).pvalue
case('anova from file', 'anova', {'file': 'trial.csv', 'column': 'score', 'group_column': 'group', 'pairwise': True},
     {'statistic.value': res.statistic, 'p_value': res.pvalue, 'effect_size.value': ssb / (ssb + ssw),
      'pairwise_comparisons.comparisons.1.p_bonferroni': min(1, pw * 3)})
inline = [r(rng.normal(m, 3, n)) for m, n in [(10, 8), (12, 11), (11, 9), (15, 7)]]
res = stats.f_oneway(*inline)
case('anova inline 4 groups', 'anova', {'groups': [{'name': f'G{i}', 'values': v} for i, v in enumerate(inline)]},
     {'statistic.value': res.statistic, 'p_value': res.pvalue})

# ---------------------------------------------------------------- chi-square
obs = [48, 35, 15, 2 + 0]; obs = [48, 35, 17]
fexp = np.array([0.5, 0.3, 0.2]) * sum(obs)
res = stats.chisquare(obs, fexp)
case('chi2 gof proportions', 'chi_square', {'type': 'goodness_of_fit', 'observed': obs, 'expected': [0.5, 0.3, 0.2]},
     {'statistic.value': res.statistic, 'p_value': res.pvalue})
res = stats.chisquare([22, 30, 18, 30])
case('chi2 gof uniform', 'chi_square', {'type': 'goodness_of_fit', 'observed': [22, 30, 18, 30]},
     {'statistic.value': res.statistic, 'p_value': res.pvalue})
tab = [[30, 14, 6], [12, 25, 13]]
res = stats.chi2_contingency(tab, correction=False)
case('chi2 independence inline', 'chi_square', {'type': 'independence', 'table': tab},
     {'statistic.value': res.statistic, 'p_value': res.pvalue, 'df': res.dof,
      'effect_size.value': contingency.association(np.array(tab), method='cramer', correction=False)})
ct = pd.crosstab(df.group, df.improved).values
res = stats.chi2_contingency(ct, correction=False)
case('chi2 independence from file', 'chi_square', {'type': 'independence', 'file': 'trial.csv', 'row_column': 'group', 'col_column': 'improved'},
     {'statistic.value': res.statistic, 'p_value': res.pvalue,
      'effect_size.value': contingency.association(ct, method='cramer', correction=False)})

for tab2, alt in [([[8, 2], [1, 5]], 'two-sided'), ([[8, 2], [1, 5]], 'greater'), ([[3, 9], [7, 4]], 'less'), ([[12, 30], [25, 18]], 'two-sided')]:
    res = stats.fisher_exact(tab2, alternative=alt)
    case(f'fisher {tab2} {alt}', 'fisher_exact', {'table': tab2, 'alternative': alt}, {'p_value': res.pvalue, 'effect_size.value': res.statistic})
ct2 = pd.crosstab(df.site, df.improved).values
res = stats.fisher_exact(ct2)
case('fisher from file', 'fisher_exact', {'file': 'trial.csv', 'row_column': 'site', 'col_column': 'improved'}, {'p_value': res.pvalue})

# ---------------------------------------------------------------- binomial and proportions
for alt in ['two-sided', 'greater', 'less']:
    res = stats.binomtest(37, 60, 0.5, alternative=alt)
    lo, hi = proportion_confint(37, 60, alpha=0.05, method='wilson')
    case(f'binomial {alt}', 'binomial_test', {'successes': 37, 'trials': 60, 'p0': 0.5, 'alternative': alt},
         {'p_value': res.pvalue, 'confidence_interval.lower': lo, 'confidence_interval.upper': hi})
res = stats.binomtest(3, 40, 0.2)
case('binomial skewed p0', 'binomial_test', {'successes': 3, 'trials': 40, 'p0': 0.2}, {'p_value': res.pvalue})
for alt, salt in [('two-sided', 'two-sided'), ('greater', 'larger')]:
    zst, pv = proportions_ztest(130, 220, value=0.5, alternative=salt, prop_var=0.5)
    case(f'z proportion {alt}', 'z_test', {'type': 'proportion', 'successes': 130, 'n': 220, 'p0': 0.5, 'alternative': alt},
         {'statistic.value': zst, 'p_value': pv})
zv = (103.2 - 100) / (15 / np.sqrt(64))
case('z mean less', 'z_test', {'type': 'mean', 'sample_mean': 103.2, 'n': 64, 'population_sd': 15, 'mu0': 100, 'alternative': 'less'},
     {'statistic.value': zv, 'p_value': stats.norm.cdf(zv),
      'confidence_interval.lower': 103.2 - stats.norm.ppf(0.975) * 15 / 8})

# ---------------------------------------------------------------- correlation
xs = r(rng.normal(0, 1, 35)); ys = r(0.5 * np.array(xs) + rng.normal(0, 1, 35))
res = stats.pearsonr(xs, ys); ci = res.confidence_interval(0.95); lr = stats.linregress(xs, ys)
case('pearson inline', 'correlation', {'x': xs, 'y': ys},
     {'statistic.value': res.statistic, 'p_value': res.pvalue, 'confidence_interval.lower': ci.low, 'confidence_interval.upper': ci.high,
      'linear_fit.slope': lr.slope, 'linear_fit.intercept': lr.intercept})
res = stats.pearsonr(xs, ys, alternative='greater')
case('pearson greater', 'correlation', {'x': xs, 'y': ys, 'alternative': 'greater'}, {'p_value': res.pvalue})
ties_x = [1, 2, 2, 3, 4, 4, 4, 5, 6, 7, 8, 8, 9, 10, 11, 12, 12, 13, 14, 15, 16, 17]
ties_y = [2, 1, 4, 3, 6, 5, 5, 8, 7, 9, 12, 10, 11, 14, 13, 13, 16, 15, 18, 17, 20, 19]
res = stats.spearmanr(ties_x, ties_y)
case('spearman with ties', 'correlation', {'x': ties_x, 'y': ties_y, 'method': 'spearman'},
     {'statistic.value': res.statistic, 'p_value': res.pvalue})
res = stats.pearsonr(df.age, df.bp)
case('pearson from file', 'correlation', {'file': 'trial.csv', 'x_column': 'age', 'y_column': 'bp'},
     {'statistic.value': res.statistic, 'p_value': res.pvalue})

# ---------------------------------------------------------------- ANCOVA / MANOVA
m = ols('bp ~ C(group) + age', data=df).fit(); t2 = sm.stats.anova_lm(m, typ=2)
case('ancova from file', 'ancova', {'file': 'trial.csv', 'group_column': 'group', 'outcome_column': 'bp', 'covariate_column': 'age'},
     {'statistic.value': t2.loc['C(group)', 'F'], 'p_value': t2.loc['C(group)', 'PR(>F)'],
      'effect_size.value': t2.loc['C(group)', 'sum_sq'] / (t2.loc['C(group)', 'sum_sq'] + t2.loc['Residual', 'sum_sq'])})
mv = MANOVA.from_formula('bp + chol ~ group', data=df).mv_test().results['group']['stat']
case('manova from file', 'manova', {'file': 'trial.csv', 'group_column': 'group', 'outcome_columns': ['bp', 'chol']},
     {'wilks_lambda': mv.loc["Wilks' lambda", 'Value'], 'statistic.value': mv.loc["Wilks' lambda", 'F Value'],
      'p_value': mv.loc["Wilks' lambda", 'Pr > F']})
mv3 = MANOVA.from_formula('bp + chol + score ~ group', data=dfc).mv_test().results['group']['stat']
case('manova 3 outcomes', 'manova', {'file': 'trial.csv', 'group_column': 'group', 'outcome_columns': ['bp', 'chol', 'score']},
     {'wilks_lambda': mv3.loc["Wilks' lambda", 'Value'], 'statistic.value': mv3.loc["Wilks' lambda", 'F Value'],
      'p_value': mv3.loc["Wilks' lambda", 'Pr > F']})

# ---------------------------------------------------------------- describe / CI / power
sk = r(rng.gamma(2, 3, 40))
ci = stats.t.interval(0.99, len(sk) - 1, loc=np.mean(sk), scale=stats.sem(sk))
case('describe inline', 'describe', {'values': sk, 'confidence': 0.99},
     {'descriptives.0.mean': np.mean(sk), 'descriptives.0.std_dev': np.std(sk, ddof=1), 'descriptives.0.median': np.median(sk),
      'descriptives.0.q1': np.percentile(sk, 25), 'descriptives.0.q3': np.percentile(sk, 75),
      'descriptives.0.skewness': stats.skew(sk, bias=False), 'descriptives.0.excess_kurtosis': stats.kurtosis(sk, bias=False),
      'descriptives.0.mean_ci.lower': ci[0], 'descriptives.0.mean_ci.upper': ci[1]})
ctl = dfc[dfc.group == 'Control'].score
case('describe grouped from file', 'describe', {'file': 'trial.csv', 'column': 'score', 'group_column': 'group'},
     {'descriptives.0.n': len(ctl), 'descriptives.0.mean': ctl.mean(), 'descriptives.0.std_dev': ctl.std(ddof=1)})
lo, hi = proportion_confint(18, 50, alpha=0.10, method='wilson')
case('ci proportion wilson', 'confidence_interval', {'type': 'proportion', 'successes': 18, 'n': 50, 'confidence': 0.90},
     {'confidence_interval.lower': lo, 'confidence_interval.upper': hi})
ci = stats.t.interval(0.95, len(a) - 1, loc=np.mean(a), scale=stats.sem(a))
case('ci mean', 'confidence_interval', {'type': 'mean', 'values': a}, {'confidence_interval.lower': ci[0], 'confidence_interval.upper': ci[1]})
npw = NormalIndPower()
case('power solve power', 'power_analysis', {'effect_size': 0.5, 'n_per_group': 64},
     {'power': npw.power(0.5, 64, 0.05, ratio=1, alternative='two-sided')})
need = int(np.ceil(npw.solve_power(0.4, power=0.8, alpha=0.05, ratio=1, alternative='two-sided')))
case('power solve n', 'power_analysis', {'effect_size': 0.4, 'power': 0.8}, {'n_per_group': need})
case('power solve d', 'power_analysis', {'n_per_group': 50, 'power': 0.9},
     {'effect_size': npw.solve_power(None, nobs1=50, power=0.9, alpha=0.05, ratio=1, alternative='two-sided')})

with open(os.path.join(HERE, 'cases.json'), 'w') as f:
    json.dump({'generated_with': {'scipy': __import__('scipy').__version__, 'statsmodels': sm.__version__, 'numpy': np.__version__},
               'cases': cases}, f, indent=1)
print(f'wrote {len(cases)} cases')
