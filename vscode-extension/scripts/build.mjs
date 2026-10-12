// Bundles the MCP server (../src) into one file the extension runs with VS Code's own Node runtime.
import { build } from 'esbuild';
import { readFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ext = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const { version } = JSON.parse(readFileSync(ext('package.json'), 'utf8'));
const serverVersion = JSON.parse(readFileSync(root('package.json'), 'utf8')).version;
if (version !== serverVersion) {
  console.warn(`Note: extension version ${version} differs from server package version ${serverVersion}.`);
}

await build({
  entryPoints: [root('src/index.js')],
  outfile: ext('dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22', // VS Code 1.101+ runs extensions on Node 22
  minify: true,
  keepNames: true,
  legalComments: 'eof',
  define: { __STATS_EXPLORER_VERSION__: JSON.stringify(serverVersion) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
copyFileSync(root('LICENSE'), ext('LICENSE'));
