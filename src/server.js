import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TOOLS } from './tools.js';
import { guidedTools } from './workflow.js';
import { createVisualizationTool, buildReportTool, withChecks } from './report.js';
import { UserError, NotTabularError, LargeFileError, setAllowedRoots, getAllowedRoots, TABULAR_STATEMENT, largeFilePath, openTable } from './data.js';
import { runCall, jobStartedResult, jobTools } from './big/jobs.js';
import { relationshipsTool, guidedRelationshipsTool } from './relationships.js';
import { Session, STEPS } from './session.js';
import { readConfig } from './config.js';
import { APP_NAME, APP_URL, VERSION } from './brand.js';
import { readJevConfig } from './jev/config.js';
import { JevGate } from './jev/gate.js';
import { jevTools, jevInstructions } from './jev/tools.js';
import { dataPacket, textSample } from './jev/checks.js';

const GUIDED_INSTRUCTIONS = `Statistics and analytics tools from ${APP_NAME}, for questions about tabular data files (CSV, TSV, Excel, Parquet) of any size. Results come from an engine verified against SciPy and statsmodels: report the returned numbers, never estimate or recompute them yourself.

Answering a data question:
1. Find the file. When the user attaches or mentions a data file, pass its path, name or file:// link as \`file\`; never open, read or paste its contents into the conversation (the tools read it directly, even very large files; pasting wastes the context and can freeze the chat). If no file is named, ask which one.
2. Learn the columns with inspect_data_file before choosing any. Map the user's words to the real column names ("sales" → Revenue, "region" → State) and say which columns you picked.
3. Decide what kind of question it is, then call start_analysis with the user's words:
   - mode "explore" for analytics and data-science questions that describe, compare, rank, summarise, visualise, estimate or look for patterns: "total revenue by region", "top 10 products by profit", "average order value by segment", "how is X distributed", "what drives Y", "what is related to Y", "trend of X by month", "how many customers churned", "what does this data look like". Most business questions are this kind.
   - mode "hypothesis_test" when the user wants to know whether a difference, effect, change or relationship is real, significant, or not due to chance, or wants to test or prove a claim: "is the difference significant", "does the new design increase conversion", "is A really better than B". Experiments with variants (A/B, A/B/n, control vs treatment, split tests) use test "ab_test" (metric "conversion" for converted yes/no, "continuous" for revenue, time, order value).
   - If it is unclear, explore first and offer a test afterwards. Never add a hypothesis test the user did not ask for.
4. Explorations: pick the tools that answer the question, and combine several when needed:
   - group_summary: totals, averages, medians, counts, min/max per category; top N; shares of rows ("revenue by state", "top products").
   - find_relationships: rank which columns relate most to a numeric outcome ("what drives profit"). Follow up on the top findings with group_summary or a chart.
   - describe: distribution, spread, shape, outliers of a column (optionally by group). confidence_interval: an estimate with its uncertainty.
   - correlation: strength of one relationship (no p-value). create_visualization: histogram, box plot, scatter, bar, line or pie.
   - power_analysis: sample-size planning. ab_test_plan: visitors and days needed for an A/B test. base_rate_check: rare-event screening (fraud, defects, diagnoses).
   Explorations have no hypotheses and no p-values. Answer in plain language with the key numbers, point out caveats (associations are not causes; estimates from samples), and suggest one sensible next step.
5. Hypothesis tests follow the six steps of ${APP_NAME}'s "Bring it all together" guide, in order:
${STEPS.map((s) => `   ${s.number}. ${s.title} (${s.tool})`).join('\n')}
   Step 1 fixes the hypotheses, direction, α, test and columns before any result is seen (choose_test helps pick the test). Steps 4 and 6 may be skipped only with a reason (skip_step). Report the p-value together with the effect size and confidence interval.
   ANOVA results include a Tukey HSD post-hoc test: name the groups that differ (★ pairs and the letters) rather than only saying "at least one group differs". A/B results: lead with the sample ratio check (a mismatch means the result can't be trusted), then each variant's lift with its interval and adjusted p-value, then the decision; the Bayesian probabilities are a supplement, not a replacement.
6. Use only the columns, groups and chart types the user asked about or that the question clearly needs. Every such selection is shown to the user to confirm. When a tool answers "CONFIRMATION NEEDED", show the user the proposed choices in plain words, wait for their reply, then call again with the confirmation_token. Never confirm on the user's behalf. If the user declines a form, ask what to change.
7. build_report only when the user asks for a report (or a write-up / document); it contains only the sections the user confirms. To save it, pass save_to (.html or .md).
8. ${TABULAR_STATEMENT} If the data is JSON, BSON or another NoSQL / document source, say exactly that and suggest exporting it to CSV or Parquet; do not try to analyse it.
9. Very large files (gigabytes to terabytes) are read in parallel passes. If a tool answers LARGE FILE, ask the user whether to read every row (exact, may take a while) or a quick sample, then call large_file_plan and repeat the call. If a tool answers STILL RUNNING, tell the user and call job_status with the job_id until it returns. Results estimated from a sketch or sample say so; mention that when reporting them.`;

const CLASSIC_INSTRUCTIONS = `Statistics and analytics tools from ${APP_NAME} for tabular data files of any size. Every result is computed deterministically by an engine verified against SciPy and statsmodels, so report the returned numbers rather than estimating them yourself.
When the user attaches or mentions a data file, pass its path as file; never read or paste its contents into the conversation (the tools read it directly, even very large files). Call inspect_data_file first to get exact column and group names, and map the user's words to them. For analytics questions use group_summary (totals, averages, counts or top N per category), find_relationships (what relates to / drives a numeric column), describe, correlation and confidence_interval; for "is it significant / real" questions use the test tools (choose_test helps pick one; ab_test for A/B/n experiments, ab_test_plan to size one; anova includes a Tukey HSD post-hoc that names the groups that differ) and report the statistic, p-value, effect size and confidence interval with any warnings. Use only columns the question needs. Very large files: if a tool answers LARGE FILE, ask the user and call large_file_plan; if it answers STILL RUNNING, call job_status with the job_id. ${TABULAR_STATEMENT}`;

/** Footer line pointing to the visual app; set STATS_EXPLORER_HIDE_LINK=1 to drop it. */
const footer = () => (process.env.STATS_EXPLORER_HIDE_LINK === '1' || !APP_URL ? '' : `\n\nExplore this visually in ${APP_NAME}: ${APP_URL}`);

function rootsFromEnv() {
  const env = process.env.STATS_EXPLORER_ROOTS;
  if (!env) return null;
  return env.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** Tools whose results are hypothesis tests (classic mode keeps them for check_conclusions). */
const TEST_TOOLS = new Set(['t_test', 'z_test', 'anova', 'chi_square', 'fisher_exact', 'binomial_test', 'ancova', 'manova', 'ab_test']);
const PENDING = ['needs_confirmation', 'needs_input', 'not_confirmed', 'running', 'needs_plan', 'cancelled', 'needs_verification', 'needs_approval', 'blocked_by_jev'];

export function createServer({ env = process.env, fetchImpl } = {}) {
  const config = readConfig(env);
  const jevConfig = readJevConfig(env);
  for (const p of jevConfig.problems) console.error(`Stats Explorer (Jev): ${p}`);
  const session = new Session(config);
  const jev = new JevGate(jevConfig, { fetchImpl });
  const server = new McpServer(
    { name: 'stats-explorer', title: APP_NAME, version: VERSION },
    { instructions: (config.guided ? GUIDED_INSTRUCTIONS : CLASSIC_INSTRUCTIONS) + (jev.enabled ? jevInstructions(jevConfig) : ''), capabilities: { prompts: {} } }
  );
  const ctx = { session, server: server.server, config, jev };
  const tools = [
    ...(config.guided
      ? [...guidedTools({ create_visualization: createVisualizationTool, build_report: jev.enabled ? withChecks(buildReportTool) : buildReportTool }), guidedRelationshipsTool]
      : [...TOOLS, relationshipsTool]),
    ...(jev.enabled ? jevTools() : []),
  ];
  const jevToolNames = new Set(['check_conclusions', 'record_verification', 'job_status', 'cancel_job', 'large_file_plan']);

  /** Data checkpoint: screen text in each file a tool is about to read (only when enabled). */
  async function screenFiles(name, args) {
    if (!jev.uses('data') || jevToolNames.has(name)) return { ok: true, notes: [] };
    const files = [args?.file, args?.test_arguments?.file].filter((f) => typeof f === 'string' && f);
    const notes = [];
    for (const f of files) {
      let table;
      try { table = await openTable(f); } catch { continue; } // the tool reports the problem itself
      const g = await jev.gate('data', table.path, dataPacket({ path: table.path, headers: table.headers, text: textSample(table) }));
      if (!g.ok) return g;
      notes.push(...g.notes);
    }
    return { ok: true, notes };
  }

  const formatResult = ({ summary, data }) => {
    const pending = PENDING.includes(data?.status);
    const warnings = !pending && data?.warnings?.length ? `\nWarnings:\n${data.warnings.map((w) => `- ${w}`).join('\n')}` : '';
    return {
      content: [{ type: 'text', text: `${summary.join('\n')}${warnings}${pending ? '' : footer()}\n\n${JSON.stringify(data)}` }],
      structuredContent: data,
    };
  };
  const formatError = (err) => {
    if (err instanceof NotTabularError) {
      return { content: [{ type: 'text', text: err.message }], structuredContent: { status: 'not_tabular', message: err.message }, isError: true };
    }
    if (err instanceof LargeFileError) {
      return { content: [{ type: 'text', text: err.message }], structuredContent: { status: 'needs_plan', message: err.message } };
    }
    const message = err instanceof UserError ? err.message : `Unexpected error: ${err?.message || err}`;
    if (!(err instanceof UserError)) console.error(err);
    return { content: [{ type: 'text', text: message }], isError: true };
  };

  for (const tool of [...tools, ...jobTools({ largeFilePath, formatResult })]) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args, extra) => {
        if (tool.raw) {
          try { return await tool.raw(args, ctx); } catch (err) { return formatError(err); }
        }
        let screen;
        try { screen = await screenFiles(tool.name, args); } catch (err) { return formatError(err); }
        if (!screen.ok) return formatResult(screen.result);
        const r = await runCall(tool.name, () => tool.run(args, ctx), { ctx, extra });
        if (r.job) return formatResult(jobStartedResult(r.job));
        if (r.error) return formatError(r.error);
        const value = r.value;
        // Classic mode has no saved results; keep them for check_conclusions when Jev checks are on.
        if (jev.enabled && !config.guided && !jevToolNames.has(tool.name) && value?.data && !PENDING.includes(value.data.status) && tool.name !== 'inspect_data_file' && tool.name !== 'choose_test') {
          const saved = session.addResult({ kind: TEST_TOOLS.has(tool.name) ? 'hypothesis_test' : tool.name, title: value.data.test || tool.title, data: value.data, summary: value.summary, selection: args });
          value.data = { ...value.data, result_id: saved.id };
        }
        if (screen.notes.length) value.summary = [...value.summary, ...screen.notes];
        return formatResult(value);
      }
    );
  }

  if (config.guided) {
    server.registerPrompt('hypothesis_test', {
      title: 'Test a hypothesis with Stats Explorer',
      description: 'Walks through the six "Bring it all together" steps for a question about a data file.',
      argsSchema: { question: z.string().describe('What do you want to know?'), file: z.string().optional().describe('Data file (CSV, TSV, Excel, Parquet)') },
    }, ({ question, file }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Use Stats Explorer to answer this as a hypothesis test${file ? ` using ${file}` : ''}: ${question}\nStart with start_analysis (mode hypothesis_test), follow steps 1–6 in order, ask me to confirm every column and group choice, and only build a report if I ask for one.` } }],
    }));
    server.registerPrompt('analyze', {
      title: 'Ask a data question with Stats Explorer',
      description: 'Any analytics or statistics question about a data file: summaries, rankings, drivers, distributions, charts or significance tests.',
      argsSchema: { question: z.string().describe('Your question, in your own words'), file: z.string().optional().describe('Data file (CSV, TSV, Excel, Parquet)') },
    }, ({ question, file }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Use the Stats Explorer tools to answer this${file ? ` about ${file}` : ''}: ${question}\nInspect the columns first, pick the right tools (explore unless I'm asking whether something is significant or real), ask me to confirm the columns before running anything, and answer in plain language with the key numbers.` } }],
    }));
    if (jev.enabled) {
      server.registerPrompt('analyze_with_jev', {
        title: 'Analyze with Stats Explorer, checked by Jev',
        description: 'A data question where Stats Explorer computes the statistics and Jev independently checks the test plan and the written conclusions.',
        argsSchema: { question: z.string().describe('Your question, in your own words'), file: z.string().optional().describe('Data file (CSV, TSV, Excel, Parquet)') },
      }, ({ question, file }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Use Stats Explorer to answer this${file ? ` about ${file}` : ''}: ${question}\nStats Explorer computes every number; Jev checks the work. Inspect the columns first and ask me to confirm them. Whenever a tool answers JEV CHECK NEEDED, run the Jev tool with the packet it gives and record the answer with record_verification before continuing. Before you give me findings, run check_conclusions on your finding sentences and only tell me the claims that pass.` } }],
      }));
    }
    server.registerPrompt('explore_data', {
      title: 'Explore data with Stats Explorer',
      description: 'Describe, chart and estimate, without hypothesis tests.',
      argsSchema: { question: z.string().describe('What do you want to see or summarise?'), file: z.string().optional() },
    }, ({ question, file }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Use Stats Explorer to explore${file ? ` ${file}` : ' my data'} (no hypothesis test): ${question}\nStart with start_analysis (mode explore), only use the columns I mention, and ask me to confirm columns and chart types before running anything.` } }],
    }));
  }

  // Data folders: STATS_EXPLORER_ROOTS wins; otherwise ask the client for its workspace roots,
  // falling back to the current directory.
  const envRoots = env === process.env ? rootsFromEnv() : (env.STATS_EXPLORER_ROOTS ? env.STATS_EXPLORER_ROOTS.split(process.platform === 'win32' ? ';' : ':') : null);
  setAllowedRoots(envRoots || [process.cwd()]);
  if (!envRoots) {
    const refresh = async () => {
      if (!server.server.getClientCapabilities()?.roots) return;
      try {
        const { roots } = await server.server.listRoots();
        const paths = roots.filter((r) => r.uri.startsWith('file://')).map((r) => fileURLToPath(r.uri));
        if (paths.length) setAllowedRoots(paths);
      } catch (e) {
        console.error('Could not read workspace roots:', e?.message || e);
      }
    };
    server.server.oninitialized = refresh;
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, refresh);
  }
  return server;
}

export { getAllowedRoots };
