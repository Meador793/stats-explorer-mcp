# Changelog

## 1.5.0

- **A/B tests:** ask "did variant B beat A?" and get the lift with its interval, a sample ratio mismatch check, adjusted p-values for several variants, the Bayesian probability to beat the control, segment breakdowns and a clear decision. Conversion rates and revenue-type metrics; files of any size.
- **A/B sample size:** "how many visitors do I need to detect a 10% lift?", with days from your daily traffic.
- **ANOVA now says which groups differ:** a Tukey HSD post-hoc test marks the significant pairs, the best group and a letter display, in answers and reports.

## 1.4.0

- **Works with Jev** (TypeSafe's judgment model). Jev checks the test plan and the AI's written conclusions against the computed results. Stats Explorer also checks every claim itself: the numbers, significance, and causal wording. Only claims that pass go into reports, and each report lists every check.
- New setting **Jev: Mode**:
  - `cooperate`: no orchestrator; Copilot or Claude calls your Jev MCP server.
  - `enforce`: Stats Explorer calls the Jev API itself.
- New settings for checkpoints, thresholds and an audit log.
- New commands:
  - **Set TypeSafe API Key**, which keeps the key in secret storage.
  - **Add Jev Routing Instructions to This Workspace**.
  - **Copy Setup Commands for Claude Code (with Jev)**.

## 1.3.1

- Step-by-step setup for Copilot and Claude Code on this page; new command **Copy Setup Command for Claude Code**.
- New setting **Confirm In**: forms (Copilot) or chat messages.
- Ask everyday analytics questions: totals and averages by category, top N, and "what drives X?" rankings.

## 1.3.0

- Data files of any size, including terabytes: large CSV, TSV and Parquet files are read in parallel streaming passes; memory doesn't grow with the file size. Tests are exact on every row; medians and histograms of very large groups are estimated and labelled.
- You're asked before a long read (every row, or a quick sample); long reads continue in the background with progress; columns can be kept for fast follow-up questions.
- New settings under **Stats Explorer › Large Files**.

## 1.2.1

- Attaching a data file to the chat works: the assistant passes the file to the tools instead of reading it into the conversation, and file links, `@name` and `#file:` references are understood.

## 1.2.0

- Much faster and lighter on large files: a 1,000,000-row, 190 MB CSV loads in about 8 seconds using under 0.5 GB of memory (was 2.7 GB). Files up to 2 GB open by default; change it under **Settings → Stats Explorer: Max File MB**.

## 1.1.1

- Data files up to 250 MB now load (was 50 MB). Change the limit under **Settings → Stats Explorer: Max File MB**. Large files need free memory of roughly 14 times their size.

## 1.1.0

- The agent now classifies each request (hypothesis test or exploration) and follows Stats Explorer's six "Bring it all together" steps for hypothesis tests.
- Every column, group, chart type and report section is confirmed with you in a form before anything runs.
- Charts (histogram, box plot, scatter, bar, line, pie) and HTML/Markdown reports containing only the sections you choose.
- Reads CSV, TSV, Excel and Parquet like the app; JSON/BSON/NoSQL data gets a clear "tabular formats only" message.
- New settings: `statsExplorer.guidedWorkflow`, `statsExplorer.confirmSelections` (both on).

## 1.0.0

- First release: 14 statistics tools for agent mode, registered automatically through VS Code's MCP API.
