# Changelog

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
