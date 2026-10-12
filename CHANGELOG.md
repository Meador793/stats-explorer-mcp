# Changelog

## 1.2.0

- **Large files, efficiently.** CSV and TSV files are now streamed in 1 MB chunks into compact column storage (numbers packed 8 bytes each; repeated text stored once and referenced by a 4-byte code). A 190 MB, 1,000,000-row CSV now loads in about 8 seconds with under 0.5 GB of memory (before: 23 seconds and 2.7 GB), and the 480 MB CSV ceiling is gone. Grouping, crosstabs and the file inspector work on the compact columns directly.
- Default file limit raised to 2 GB (`STATS_EXPLORER_MAX_FILE_MB`).
- Results are unchanged: the streaming reader follows the app's import rules exactly, checked against the app's parser on 25 edge-case files and 300 random ones at chunk sizes down to 1 character, and against 1.1.1's output for every tool.

## 1.1.1

- **Bigger data files.** The file limit is now 250 MB (was 50 MB) and can be changed with `STATS_EXPLORER_MAX_FILE_MB`. A 190 MB, 1,000,000-row CSV loads in about 25 seconds the first time and is then cached. Loading needs roughly 14 times the file size in free memory, and a CSV can't exceed about 480 MB, so larger files get a clear message suggesting a sample or Parquet.
- Fixed a Windows-only test that assumed `/etc/passwd` exists.

## 1.1.0

- **Guided workflow by default.** Every analysis starts with `start_analysis`, where the AI classifies the request as a hypothesis test or an exploration. Hypothesis tests follow the six "Bring it all together" steps from the Stats Explorer app, in order (`state_hypotheses`, `check_assumptions`, `check_spread`, `power_analysis`, `run_test`, `base_rate_check` / `skip_step`). Explorations have no hypotheses, no p-values and no hypothesis section in reports.
- **User confirmation by default** of every column, group, chart type and report section: dropdown forms in clients that support MCP elicitation (e.g. VS Code), a one-time confirmation token elsewhere.
- New `create_visualization` (histogram, box plot, scatter, bar, line, pie; accessible SVG, light and dark) and `build_report` (HTML or Markdown, confirmed sections only; hypothesis tests written up in the app's format).
- New checks: ANCOVA equal-slopes test (step 2); power for one-sample, paired, proportion and correlation tests (step 4); base-rate PPV/NPV (step 6). Verified against statsmodels.
- Data files are now read with the app's own import module: CSV, TSV, Excel and Parquet (all compression codecs), identical to the app.
- JSON, BSON and NoSQL sources are answered with "Stats Explorer is built for tabular formats (CSV, TSV, Excel and Parquet) to run hypothesis tests or explore statistics", plus how to export them.
- `correlation` in guided mode is descriptive (r, CI, fitted line); significance testing goes through the workflow.
- `STATS_EXPLORER_GUIDED=off` and `STATS_EXPLORER_CONFIRM_SELECTIONS=off` restore the 1.0 behaviour.
- Requires Node.js 22 or later (Node 18 and 20 have reached end of life); tested on Node 22 and 24 LTS.
- Fixed: very large numeric columns could crash `inspect_data_file` (array spread); hex like "0x1A" was accepted as a number.

## 1.0.0

- 14 tools: choose_test, inspect_data_file, describe, t_test, z_test, anova, ancova, manova, chi_square, fisher_exact, binomial_test, correlation, confidence_interval, power_analysis.
- Statistics engine shared with the Stats Explorer app; 43 reference cases verified against SciPy and statsmodels.
- VS Code extension that registers the server automatically.
