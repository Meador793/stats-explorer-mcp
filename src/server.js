import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TOOLS } from './tools.js';
import { guidedTools } from './workflow.js';
import { createVisualizationTool, buildReportTool } from './report.js';
import { UserError, NotTabularError, setAllowedRoots, getAllowedRoots, TABULAR_STATEMENT } from './data.js';
import { Session, STEPS } from './session.js';
import { readConfig } from './config.js';
import { APP_NAME, APP_URL, VERSION } from './brand.js';

const GUIDED_INSTRUCTIONS = `Statistics tools from ${APP_NAME}. Results are computed by an engine verified against SciPy and statsmodels: report the returned numbers, never estimate them yourself.

How to work with these tools (default behaviour):
1. Classify the request before doing anything else, then call start_analysis with the user's words:
   - mode "hypothesis_test" when the user wants to know whether a difference, effect, change or relationship is real, significant, or caused by something, or wants to test a claim ("does X affect Y", "is A better than B", "is this significant").
   - mode "explore" when the user wants to describe, summarise, visualise, estimate a value with a confidence interval, check a correlation's strength, or plan a sample size, without testing a claim.
   - If it is genuinely unclear, ask the user which they want. Never add a hypothesis test the user did not ask for.
2. Hypothesis tests follow the six steps of ${APP_NAME}'s "Bring it all together" guide, in order:
${STEPS.map((s) => `   ${s.number}. ${s.title} (${s.tool})`).join('\n')}
   Step 1 fixes the hypotheses, direction, α, test and columns before any result is seen. Steps 4 and 6 may be skipped only with a reason (skip_step).
3. Explorations use describe, confidence_interval, correlation (descriptive, no p-value), create_visualization, power_analysis and base_rate_check. They have no hypotheses, no p-values and no hypothesis section in the report.
4. Use only the columns, groups and chart types the user asked about. Every such selection is shown to the user to confirm; when a tool answers "CONFIRMATION NEEDED", relay the choices to the user, wait for their answer, and only then call again with the confirmation_token. Never confirm on the user's behalf.
5. build_report only when the user asks for a report; it contains only the sections the user confirms.
6. ${TABULAR_STATEMENT} If the data is JSON, BSON or another NoSQL / document source, say exactly that and suggest exporting it to CSV or Parquet; do not try to analyse it.
Use inspect_data_file to learn a file's exact column names before proposing columns.`;

const CLASSIC_INSTRUCTIONS = `Statistics tools from ${APP_NAME}. Every result is computed deterministically by a test engine verified against SciPy and statsmodels, so report the returned numbers rather than estimating them yourself.
Workflow: if the right test is unclear, call choose_test. For data in a file, call inspect_data_file first to get exact column and group names, then pass file + column names instead of copying values into the call. Use only columns the user asked about. Report the statistic, p-value, effect size and confidence interval, and mention any warnings. ${TABULAR_STATEMENT}`;

/** Footer line pointing to the visual app; set STATS_EXPLORER_HIDE_LINK=1 to drop it. */
const footer = () => (process.env.STATS_EXPLORER_HIDE_LINK === '1' || !APP_URL ? '' : `\n\nExplore this visually in ${APP_NAME}: ${APP_URL}`);

function rootsFromEnv() {
  const env = process.env.STATS_EXPLORER_ROOTS;
  if (!env) return null;
  return env.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
}

export function createServer({ env = process.env } = {}) {
  const config = readConfig(env);
  const session = new Session(config);
  const server = new McpServer(
    { name: 'stats-explorer', title: APP_NAME, version: VERSION },
    { instructions: config.guided ? GUIDED_INSTRUCTIONS : CLASSIC_INSTRUCTIONS, capabilities: { prompts: {} } }
  );
  const ctx = { session, server: server.server, config };
  const tools = config.guided
    ? guidedTools({ create_visualization: createVisualizationTool, build_report: buildReportTool })
    : TOOLS;

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args) => {
        try {
          const { summary, data } = await tool.run(args, ctx);
          const pending = data?.status === 'needs_confirmation' || data?.status === 'needs_input' || data?.status === 'not_confirmed';
          const warnings = !pending && data?.warnings?.length ? `\nWarnings:\n${data.warnings.map((w) => `- ${w}`).join('\n')}` : '';
          return {
            content: [{ type: 'text', text: `${summary.join('\n')}${warnings}${pending ? '' : footer()}\n\n${JSON.stringify(data)}` }],
            structuredContent: data,
          };
        } catch (err) {
          if (err instanceof NotTabularError) {
            return { content: [{ type: 'text', text: err.message }], structuredContent: { status: 'not_tabular', message: err.message }, isError: true };
          }
          const message = err instanceof UserError ? err.message : `Unexpected error: ${err?.message || err}`;
          if (!(err instanceof UserError)) console.error(err);
          return { content: [{ type: 'text', text: message }], isError: true };
        }
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
