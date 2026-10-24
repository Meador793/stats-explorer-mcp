"""Reference values for Tukey HSD and the A/B tools, from SciPy and statsmodels.

    python3 test/reference/abtest.py   ->  test/fixtures/abtest-ref.json
"""
import json, math, os
import numpy as np
from scipy import stats, integrate
from statsmodels.stats.proportion import proportions_ztest, confint_proportions_2indep, proportion_confint, proportion_effectsize
from statsmodels.stats.multitest import multipletests
from statsmodels.stats.power import NormalIndPower
from statsmodels.stats.multicomp import pairwise_tukeyhsd

rng = np.random.default_rng(20261020)
out = {}

# Studentized range upper-tail p-values.
out["sr"] = [[q, k, df, float(stats.studentized_range.sf(q, k, df))]
             for q, k, df in [(3.5, 3, 10), (2.1, 4, 30), (4.8, 5, 12), (3.0, 3, 200), (5.5, 8, 40), (1.2, 6, 5), (3.7, 10, 1000), (2.9, 2, 7)]]

# Tukey HSD on raw data: equal and unequal group sizes.
out["tukey"] = []
for sizes, means, sds in [([12, 12, 12, 12], [10, 12, 15, 10.5], [3, 3, 3, 3]), ([8, 15, 11], [50, 58, 51], [6, 9, 7]), ([30, 25, 40, 22, 35], [1.0, 1.4, 1.1, 2.0, 1.05], [0.5, 0.6, 0.5, 0.7, 0.4])]:
    groups = [list(np.round(rng.normal(m, s, n), 3)) for n, m, s in zip(sizes, means, sds)]
    res = stats.tukey_hsd(*groups)
    ci = res.confidence_interval(0.95)
    names = [f"G{i+1}" for i in range(len(groups))]
    pairs = []
    for i in range(len(groups)):
        for j in range(i + 1, len(groups)):
            pairs.append([i, j, float(res.statistic[i, j]), float(res.pvalue[i, j]), float(ci.low[i, j]), float(ci.high[i, j])])
    labels = sum([[nm] * len(g) for nm, g in zip(names, groups)], [])
    sm = pairwise_tukeyhsd(np.concatenate(groups), labels, alpha=0.05)
    reject = {f"{a}|{b}": bool(r) for a, b, r in zip(sm.groupsunique[sm._multicomp.pairindices[0]], sm.groupsunique[sm._multicomp.pairindices[1]], sm.reject)}
    out["tukey"].append({"groups": groups, "names": names, "pairs": pairs, "reject": reject})

# A/B conversion: z-test, intervals, Fisher, chi-square, Holm, SRM, Wilson.
ab = []
for arms in [[(5000, 220), (5000, 268)], [(12000, 480), (11900, 545), (12100, 470)], [(60, 3), (58, 9)], [(100000, 3100), (99000, 3290), (101000, 3150), (100500, 3005)]]:
    rec = {"arms": arms, "comparisons": [], "wilson": []}
    n0, x0 = arms[0]
    for n, x in arms:
        lo, hi = proportion_confint(x, n, alpha=0.05, method="wilson")
        rec["wilson"].append([lo, hi])
    ps = []
    for n, x in arms[1:]:
        z, p = proportions_ztest([x, x0], [n, n0])
        _, pg = proportions_ztest([x, x0], [n, n0], alternative="larger")
        dlo, dhi = confint_proportions_2indep(x, n, x0, n0, method="wald", compare="diff", alpha=0.05)
        rlo, rhi = confint_proportions_2indep(x, n, x0, n0, method="log", compare="ratio", alpha=0.05)
        fp = float(stats.fisher_exact([[x, n - x], [x0, n0 - x0]])[1])
        rec["comparisons"].append({"z": float(z), "p": float(p), "p_greater": float(pg), "diff_ci": [float(dlo), float(dhi)], "rel_ci": [float(rlo) - 1, float(rhi) - 1], "fisher_p": fp})
        ps.append(float(p))
    rec["holm"] = list(map(float, multipletests(ps, method="holm")[1]))
    rec["bonferroni"] = list(map(float, multipletests(ps, method="bonferroni")[1]))
    table = [[x, n - x] for n, x in arms]
    if len(arms) > 2:
        chi2, pchi, dof, _ = stats.chi2_contingency(table, correction=False)
        rec["omnibus"] = [float(chi2), float(pchi)]
    ns = [n for n, _ in arms]
    rec["srm"] = list(map(float, stats.chisquare(ns)))
    ab.append(rec)
out["ab_conversion"] = ab

# SRM with a planned uneven split.
out["srm_uneven"] = list(map(float, stats.chisquare([9100, 1000], f_exp=[0.9 * 10100, 0.1 * 10100])))

# Bayesian: P(best), P(beats control), expected loss with Beta(1, 1) priors, by numerical integration.
def bayes(arms):
    post = [(1 + x, 1 + n - x) for n, x in arms]
    lo = min(stats.beta.ppf(1e-12, a, b) for a, b in post); hi = max(stats.beta.isf(1e-12, a, b) for a, b in post)
    best = []
    for i, (a, b) in enumerate(post):
        f = lambda t, i=i: stats.beta.pdf(t, *post[i]) * np.prod([stats.beta.cdf(t, *post[j]) for j in range(len(post)) if j != i])
        best.append(integrate.quad(f, lo, hi, limit=500, epsabs=1e-13, points=[a / (a + b) for a, b in post])[0])
    beats = []
    for i in range(1, len(post)):
        f = lambda t, i=i: stats.beta.pdf(t, *post[i]) * stats.beta.cdf(t, *post[0])
        beats.append(integrate.quad(f, lo, hi, limit=500, epsabs=1e-13, points=[a / (a + b) for a, b in post])[0])
    emax = lo + integrate.quad(lambda t: 1 - np.prod([stats.beta.cdf(t, a, b) for a, b in post]), lo, hi, limit=500, epsabs=1e-14, points=[a / (a + b) for a, b in post])[0]
    loss = [emax - a / (a + b) for a, b in post]
    return {"best": best, "beats": beats, "loss": loss}
out["bayes"] = [{"arms": arms, **bayes(arms)} for arms in [[(5000, 220), (5000, 268)], [(12000, 480), (11900, 545), (12100, 470)], [(60, 3), (58, 9)]]]

# Continuous metric: Welch t-test and its interval; one-way ANOVA.
cont = []
for spec in [[(400, 52.1, 20), (410, 55.9, 22)], [(30, 10, 4), (28, 12.5, 6), (33, 9.8, 3.5)]]:
    groups = [rng.normal(m, s, n).round(3) for n, m, s in spec]
    rec = {"groups": [list(map(float, g)) for g in groups], "welch": []}
    for g in groups[1:]:
        r = stats.ttest_ind(g, groups[0], equal_var=False)
        ci = r.confidence_interval(0.95)
        rg = stats.ttest_ind(g, groups[0], equal_var=False, alternative="greater")
        rec["welch"].append({"t": float(r.statistic), "p": float(r.pvalue), "df": float(r.df), "ci": [float(ci.low), float(ci.high)], "p_greater": float(rg.pvalue)})
    if len(groups) > 2:
        F, p = stats.f_oneway(*groups)
        rec["anova"] = [float(F), float(p)]
        res = stats.tukey_hsd(*groups)
        rec["tukey_p"] = [[float(res.pvalue[i, j]) for j in range(len(groups))] for i in range(len(groups))]
    cont.append(rec)
out["ab_continuous"] = cont

# Planning: NormalIndPower with Cohen's h / d.
pw = NormalIndPower()
plans = []
for p1, p2, alpha, power, alt in [(0.04, 0.044, 0.05, 0.8, "two-sided"), (0.10, 0.12, 0.05, 0.9, "two-sided"), (0.30, 0.33, 0.025, 0.8, "larger"), (0.02, 0.025, 0.05 / 3, 0.8, "two-sided")]:
    h = abs(proportion_effectsize(p2, p1))
    n = pw.solve_power(effect_size=h, alpha=alpha, power=power, ratio=1, alternative=alt)
    plans.append({"p1": p1, "p2": p2, "alpha": alpha, "power": power, "alternative": alt, "h": h, "n": math.ceil(n)})
out["plan_conversion"] = plans
mdes = []
for n, alpha, power in [(20000, 0.05, 0.8), (1500, 0.05, 0.9)]:
    # Solved exactly (statsmodels' own solver stops at about 1e-5 relative accuracy here).
    from scipy import optimize
    c = stats.norm.isf(alpha / 2)
    f = lambda h: stats.norm.sf(c - h * math.sqrt(n / 2)) + stats.norm.cdf(-c - h * math.sqrt(n / 2)) - power
    mdes.append({"n": n, "alpha": alpha, "power": power, "h": optimize.brentq(f, 1e-6, 2, xtol=1e-15), "h_statsmodels": pw.solve_power(nobs1=n, alpha=alpha, power=power, ratio=1)})
out["plan_mde"] = mdes
out["plan_continuous"] = [{"d": d, "alpha": a, "power": p, "n": math.ceil(pw.solve_power(effect_size=d, alpha=a, power=p, ratio=1))} for d, a, p in [(0.2, 0.05, 0.8), (0.1, 0.01, 0.9)]]

path = os.path.join(os.path.dirname(__file__), "..", "fixtures", "abtest-ref.json")
with open(path, "w") as f:
    json.dump(out, f)
print("wrote", os.path.normpath(path))

# A small experiment file (also used by the MCP-level tests), with its reference results.
n_rows = 3000
variant = rng.choice(["A", "B", "C"], size=n_rows, p=[0.34, 0.33, 0.33])
device = rng.choice(["mobile", "desktop"], size=n_rows, p=[0.6, 0.4])
base = {"A": 0.08, "B": 0.105, "C": 0.085}
conv = np.array([rng.random() < base[v] * (0.8 if d == "mobile" else 1.3) for v, d in zip(variant, device)])
revenue = np.where(conv, rng.gamma(2.0, {"A": 30, "B": 32, "C": 29}["A"], n_rows), 0.0).round(2)
revenue = np.array([r * {"A": 1.0, "B": 1.05, "C": 0.97}[v] for r, v in zip(revenue, variant)]).round(2)
csv_path = os.path.join(os.path.dirname(__file__), "..", "fixtures", "experiment.csv")
with open(csv_path, "w") as f:
    f.write("visitor_id,variant,device,converted,revenue\n")
    for i, (v, d, c, r) in enumerate(zip(variant, device, conv, revenue)):
        f.write(f"{i+1},{v},{d},{'yes' if c else 'no'},{r}\n")
file_ref = {"counts": {}, "z": {}, "welch": {}}
for v in ["A", "B", "C"]:
    m = variant == v
    file_ref["counts"][v] = [int(m.sum()), int(conv[m].sum())]
for v in ["B", "C"]:
    z, p = proportions_ztest([conv[variant == v].sum(), conv[variant == "A"].sum()], [(variant == v).sum(), (variant == "A").sum()])
    file_ref["z"][v] = [float(z), float(p)]
    r = stats.ttest_ind(revenue[variant == v], revenue[variant == "A"], equal_var=False)
    file_ref["welch"][v] = [float(r.statistic), float(r.pvalue)]
tk = stats.tukey_hsd(*[revenue[variant == v] for v in ["A", "B", "C"]])
file_ref["tukey_revenue_p"] = [[float(tk.pvalue[i, j]) for j in range(3)] for i in range(3)]
out["experiment_file"] = file_ref
with open(path, "w") as f:
    json.dump(out, f)
print("wrote", os.path.normpath(csv_path))
