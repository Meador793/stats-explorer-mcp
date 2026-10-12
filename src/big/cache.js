// Column cache: after one full pass over a large CSV or Parquet file, the columns it read can be kept
// as compact binary files (8 bytes per number, 4 per text value plus each distinct text once), so later
// questions on those columns read only them, at disk speed. Only with the user's consent.
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const cacheRoot = () => process.env.STATS_EXPLORER_CACHE_DIR || join(tmpdir(), 'stats-explorer-cache');

export function cacheDir(info) {
  const h = createHash('sha1').update(`${info.path}|${info.size}|${info.mtimeMs}`).digest('hex').slice(0, 20);
  return join(cacheRoot(), h);
}

export async function readManifest(info) {
  try {
    const m = JSON.parse(await readFile(join(cacheDir(info), 'manifest.json'), 'utf8'));
    if (m.path !== info.path || m.size !== info.size || m.mtimeMs !== info.mtimeMs) return null;
    return m;
  } catch { return null; }
}

/** Records that these columns (header indexes) are complete for the given chunk list. */
export async function addToManifest(info, chunks, colIds) {
  const dir = cacheDir(info);
  await mkdir(dir, { recursive: true });
  let m = await readManifest(info);
  const sameChunks = m && JSON.stringify(m.chunks) === JSON.stringify(chunks);
  if (!sameChunks) m = { version: 1, path: info.path, size: info.size, mtimeMs: info.mtimeMs, headers: info.headers, chunks, columns: [] };
  m.columns = [...new Set([...m.columns, ...colIds])].sort((a, b) => a - b);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(m));
  return m;
}

async function dirSize(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Cached files: [{ path, columns, bytes }]. */
export async function listCache() {
  const out = [];
  for (const e of await readdir(cacheRoot(), { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const dir = join(cacheRoot(), e.name);
    try {
      const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      out.push({ path: m.path, columns: m.columns.map((i) => m.headers[i]), bytes: await dirSize(dir), dir });
    } catch { out.push({ path: '(incomplete)', columns: [], bytes: await dirSize(dir), dir }); }
  }
  return out;
}

/** Deletes the cache for one file (by its path) or for every file. Returns bytes freed. */
export async function clearCache(path) {
  let freed = 0;
  for (const c of await listCache()) {
    if (path && c.path !== path) continue;
    freed += c.bytes;
    await rm(c.dir, { recursive: true, force: true });
  }
  return freed;
}
