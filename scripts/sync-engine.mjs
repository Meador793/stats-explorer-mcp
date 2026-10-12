#!/usr/bin/env node
// Copies the verified statistics engine from the Stats Explorer app into src/engine/,
// so the app and this MCP server always run the same math.
//
//   node scripts/sync-engine.mjs ../stats-explorer
//
// The app files are copied unchanged except for two mechanical rewrites:
//   1. Vite's "@/lib/x" alias becomes a relative "./x.js" import.
//   2. The app's demo-edition value cap is replaced with a pass-through (the MCP has no demo).
// Any other import is treated as an error, so a new app-only dependency can't slip in unnoticed.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_FILES = ['statsUtils.js', 'hypothesisTests.js', 'hypothesisUtils.js', 'regression.js', 'dataImport.js'];
// Other app files the MCP reuses verbatim: the Learn tab's "Bring it all together" workflow.
const EXTRA_FILES = [['src/components/learn/learnContent.js', 'learnContent.js']];
// npm packages engine files may import (all are dependencies of this package too).
const ALLOWED_PACKAGES = ['xlsx', 'hyparquet', 'hyparquet-compressors'];
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'src', 'engine');

const appDir = process.argv[2];
if (!appDir) {
  console.error('Usage: node scripts/sync-engine.mjs <path-to-stats-explorer-app>');
  process.exit(1);
}
const libDir = resolve(appDir, 'src', 'lib');
if (!existsSync(join(libDir, 'hypothesisTests.js'))) {
  console.error(`Could not find src/lib/hypothesisTests.js under ${resolve(appDir)}`);
  process.exit(1);
}

const HEADER = '// Synced from the Stats Explorer app (src/lib) by scripts/sync-engine.mjs. Do not edit here;\n' +
  '// change the app and re-run the sync so both stay identical.\n';

for (const file of ENGINE_FILES) {
  let src = readFileSync(join(libDir, file), 'utf8');

  // Demo cap -> pass-through.
  src = src.replace(
    /^import\s*\{\s*applyDemoValueLimit\s*\}\s*from\s*['"]@\/lib\/edition['"];?\s*$/m,
    'const applyDemoValueLimit = (values) => values;'
  );
  // Alias -> relative import.
  src = src.replace(/from\s*['"]@\/lib\/([A-Za-z0-9_]+)['"]/g, (_, name) => {
    if (!ENGINE_FILES.includes(`${name}.js`)) {
      throw new Error(`${file} imports @/lib/${name}, which is not part of the engine. Add it to ENGINE_FILES or remove the import.`);
    }
    return `from './${name}.js'`;
  });

  for (const m of src.matchAll(/^import .* from\s*['"]([^'"]+)['"]/gm)) {
    if (!m[1].startsWith('./') && !ALLOWED_PACKAGES.includes(m[1])) throw new Error(`${file}: unexpected import "${m[0]}"`);
  }

  writeFileSync(join(outDir, file), HEADER + src);
  console.log(`synced ${file}`);
}

for (const [from, to] of EXTRA_FILES) {
  const src = readFileSync(resolve(appDir, from), 'utf8');
  if (/^import /m.test(src)) throw new Error(`${from} has imports; it must stay plain data to be shared.`);
  writeFileSync(join(outDir, to), HEADER.replace('(src/lib)', `(${from})`) + src);
  console.log(`synced ${to}`);
}
