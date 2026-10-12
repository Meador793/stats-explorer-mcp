# Changelog

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
