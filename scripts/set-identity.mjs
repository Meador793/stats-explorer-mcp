#!/usr/bin/env node
// Fills in the placeholders (GitHub username, VS Code publisher, app URL, copyright name)
// across every file that needs them. Run once before publishing:
//
//   node scripts/set-identity.mjs --github janedoe --publisher janedoe-stats \
//        --app-url https://statsexplorer.com --owner "Jane Doe"
//
// Safe to re-run with new values only on a fresh checkout (it replaces the placeholders,
// which are gone after the first run).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const need = ['github', 'publisher', 'app-url', 'owner'];
const missing = need.filter((k) => !args[k]);
if (missing.length) {
  console.error(`Missing: ${missing.map((m) => `--${m}`).join(' ')}\n` +
    'Example: node scripts/set-identity.mjs --github janedoe --publisher janedoe-stats --app-url https://statsexplorer.com --owner "Jane Doe"');
  process.exit(1);
}
if (!/^[A-Za-z0-9-]+$/.test(args.github)) throw new Error('--github must be a GitHub username');
if (!/^[a-z0-9][a-z0-9-]*$/i.test(args.publisher)) throw new Error('--publisher must be a VS Code Marketplace publisher ID (letters, numbers, hyphens)');
if (!/^https:\/\//.test(args['app-url'])) throw new Error('--app-url must start with https://');

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const FILES = ['package.json', 'server.json', 'README.md', 'LICENSE', 'src/brand.js', 'vscode-extension/package.json', 'vscode-extension/README.md'];
const swaps = [
  ['YOUR_GITHUB_USERNAME', args.github],
  ['your-publisher-id', args.publisher],
  ['https://yourdomain.com', args['app-url'].replace(/\/$/, '')],
  ['YOUR NAME OR COMPANY', args.owner],
];
for (const f of FILES) {
  let s = readFileSync(root(f), 'utf8');
  const before = s;
  for (const [from, to] of swaps) s = s.split(from).join(to);
  if (s !== before) { writeFileSync(root(f), s); console.log(`updated ${f}`); }
}
console.log('Done. Search for "YOUR_" to confirm nothing is left.');
