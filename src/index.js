#!/usr/bin/env node
import { isMainThread } from 'node:worker_threads';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

// Worker threads that scan large files load this same file (in the bundled extension); only the
// main thread runs the server.
if (isMainThread) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'init-jev') {
    // npx stats-explorer-mcp init-jev [--claude] [--copilot] [--agents] [--print]
    const { writeRouting, ROUTING } = await import('./jev/workspace.js');
    if (rest.includes('--print')) {
      console.log(ROUTING);
    } else {
      const which = ['claude', 'copilot', 'agents'].filter((w) => rest.includes(`--${w}`));
      const written = await writeRouting(process.cwd(), which.length ? which : ['claude', 'copilot']);
      for (const p of written) console.log(`Wrote the Stats Explorer + Jev routing section to ${p}`);
    }
  } else {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    console.error('Stats Explorer MCP server running on stdio');
  }
}
