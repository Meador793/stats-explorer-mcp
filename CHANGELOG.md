# Changelog

## 1.3.1

- **Easier setup.** The README and Marketplace page have step-by-step setup for GitHub Copilot in VS Code (install, Agent mode, tools icon) and for Claude Code (one command, new session, `/mcp`), plus Claude Desktop / Cursor config. New VS Code command **Stats Explorer: Copy Setup Command for Claude Code**.
- **Confirmations in the chat** (`STATS_EXPLORER_CONFIRM_VIA=chat`, VS Code setting `statsExplorer.confirmIn`): some clients, including Claude Code, advertise forms but decline them without showing them; in chat mode the proposal is shown as a message and the user's reply approves it.
- **Flexible analytics questions.** New `group_summary` (totals, averages, medians, counts per category, top N) and `find_relationships` ("what drives X?": every column ranked by Pearson r or correlation ratio η against a numeric outcome, with highest/lowest groups), both on files of any size and in reports. Server instructions now cover everyday analytics and data-science questions (map words to columns, explore first, combine tools, plain-language answers) and a new `analyze` prompt starts any question.

## 1.3.0

**Data files of any size, including terabytes.** Files above `STATS_EXPLORER_STREAM_MB` (512 MB; for Parquet, the equivalent in rows × columns) are no longer loaded into memory; they are streamed.

- **Parallel one-pass engine** (`src/big/`). Each tool reads only the columns it uses, in pieces split at line ends (CSV) or row groups (Parquet), one worker thread per core. Pieces are merged in file order. Memory doesn't grow with the file (about 0.5 GB with one reader, plus about 0.2 GB per extra reader): a 2.5 GB, 13-million-row CSV took 45 s on 1 core and 22 s on 2, and the same data as Parquet took 9 s.
- **Exact statistics from running totals**: counts, means, variances, skewness and kurtosis (Pébay's merge formulas), covariances, and the sums of squares and cross-products behind ANOVA, ANCOVA and MANOVA. Every hypothesis test is exact on every row. Samples of up to 100,000 values keep their values, so for them every number equals the in-memory result.
- **Estimates, labelled**: medians, quartiles, histogram bars and outlier counts of larger samples from a KLL quantile sketch (worst rank error 0.025% in tests on 5 million values); Spearman's ρ from a 100,000-pair random sample (0.878 vs an exact 0.8789 on 13 million rows); distinct-value counts above 10,000 from HyperLogLog (within about 2%). Results list their estimates in `large_file.approximate`.
- **Line breaks inside quoted values** are detected at split points; the file is then re-read in one piece, so results never depend on how it was split.
- **Asking first**: a full read expected to take over 2 minutes needs the user's choice: every row (exact) or a quick sample of about 1% in blocks spread across the file. Shown as a form where supported; otherwise via the new `large_file_plan` tool.
- **Background jobs**: a read running longer than 40 s continues in the background (`STILL RUNNING` + `job_id`); `job_status` returns the normal result, with progress and time left meanwhile; `cancel_job` stops it. MCP progress notifications are sent while the request is open.
- **Read once**: workflow steps 1–5 share one pass; with consent, the columns read are kept on disk for fast follow-ups (`manage_cache` lists or deletes them).
- **Verified**: the whole test suite also passes with every file forced through the streaming path, and with only one-pass summaries; 228 tool calls (tests, charts, six-step workflows, CSV and Parquet, split into as many as 3 parallel pieces) give results identical to the in-memory path. New `test/big.test.mjs` covers the plan, sample, form, cache, background and cancel flows.
- No default size limit any more (`STATS_EXPLORER_MAX_FILE_MB` can set one).

## 1.2.1

- **Files attached to the chat work.** References the way chat clients pass them are understood: `@sales.csv` (Claude Code), `#file:sales.csv` (VS Code), `file:///D:/My%20Data/sales.csv` links (decoded correctly on Windows), and names in quotes or backticks. A bare file name is also found in subfolders of the workspace.
- The assistant is told to pass an attached file's path to the tools and never to read or paste its contents into the chat, which can make the chat unresponsive with large files.

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
