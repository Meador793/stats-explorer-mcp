#!/usr/bin/env node
import { isMainThread } from 'node:worker_threads';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

// Worker threads that scan large files load this same file (in the bundled extension); only the
// main thread runs the server.
if (isMainThread) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('Stats Explorer MCP server running on stdio');
}
