import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const SERVER = fileURLToPath(new URL('../src/index.js', import.meta.url));

/** Starts the server as a child process (like an MCP client would) and connects to it. */
export async function connect({ command = process.execPath, args = [SERVER], env = {}, guided = true, confirm = guided, elicitation = null } = {}) {
  // elicitation: null = a client without forms; a function(params) => result = a client that shows forms.
  const client = new Client({ name: 'stats-explorer-tests', version: '1.0.0' }, { capabilities: elicitation ? { elicitation: {} } : {} });
  if (elicitation) client.setRequestHandler(ElicitRequestSchema, async (req) => elicitation(req.params));
  await client.connect(new StdioClientTransport({
    command, args, stderr: 'ignore',
    env: { ...process.env, STATS_EXPLORER_ROOTS: FIXTURES, STATS_EXPLORER_HIDE_LINK: '1', STATS_EXPLORER_GUIDED: guided ? 'on' : 'off', STATS_EXPLORER_CONFIRM_SELECTIONS: confirm ? 'on' : 'off', ...env },
  }));
  return client;
}

export const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
