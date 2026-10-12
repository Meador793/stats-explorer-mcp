// One parallel pass over a large file, computing a list of accumulators.
//
// CSV: the data is split at line ends into pieces that worker threads parse independently. A piece
// that ends inside a quoted value means a split point fell inside a multi-line value; that is
// detected and the file is then read in one piece, so results are always the same as a sequential
// read. Parquet: one piece per row group, reading only the needed columns. Cached columns: one piece
// per cached chunk. Pieces are merged strictly in file order.
import { open, stat } from 'node:fs/promises';
import { planColumns, mergeAll, createAll } from './acc.js';
import { describeCsv, describeParquet, isParquet, nextLineStart, chunkBytes } from './source.js';
import { submit, shutdown, workerCount } from './pool.js';
import { readManifest, addToManifest, cacheDir } from './cache.js';

const MB = 1024 * 1024;

// Throughput per worker, refined from real scans (bytes per second).
export const rates = { csv: 30 * MB, parquet: 40 * MB, cache: 400 * MB };

const infos = new Map();

/** Header, size and layout of a file (cached while the file is unchanged). */
export async function describe(path, opts = {}) {
  const st = await stat(path);
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  if (infos.has(key)) return infos.get(key);
  const info = isParquet(path) ? await describeParquet(path) : await describeCsv(path, opts);
  infos.set(key, info);
  if (infos.size > 50) infos.delete(infos.keys().next().value);
  return info;
}

async function csvChunks(info) {
  const fh = await open(info.path, 'r');
  try {
    const step = chunkBytes(info.size);
    const chunks = [];
    let start = info.dataStart;
    while (start < info.size) {
      const end = start + step >= info.size ? info.size : await nextLineStart(fh, start + step, info.size);
      chunks.push({ start, end });
      start = end;
    }
    return chunks;
  } finally { await fh.close(); }
}

async function csvSampleBlocks(info, fraction) {
  const fh = await open(info.path, 'r');
  try {
    const BS = MB;
    const data = info.size - info.dataStart;
    const B = Math.max(16, Math.ceil((data * fraction) / BS));
    const stratum = data / B;
    const blocks = [];
    let seed = (info.size % 2147483647) >>> 0;
    const r = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let prevEnd = info.dataStart;
    for (let i = 0; i < B; i++) {
      const at = Math.floor(info.dataStart + i * stratum + r() * Math.max(0, stratum - BS));
      const start = Math.max(prevEnd, at === info.dataStart ? at : await nextLineStart(fh, at, info.size));
      if (start >= info.size) break;
      const end = await nextLineStart(fh, Math.min(info.size, start + BS), info.size);
      if (end <= start) continue;
      blocks.push({ start, end });
      prevEnd = end;
    }
    return blocks;
  } finally { await fh.close(); }
}

/** Estimated seconds for a pass, given what is cached. */
export function estimateSeconds(info, { cached, sample } = {}) {
  const w = workerCount();
  if (cached) return Math.max(1, cached.bytes / (rates.cache * w));
  const bytes = sample ? Math.max(16 * MB, info.size * 0.01) : info.size;
  return bytes / ((info.kind === 'parquet' ? rates.parquet : rates.csv) * Math.min(w, Math.max(1, Math.ceil(info.size / chunkBytes(info.size)))));
}

/**
 * Runs the accumulators over the file.
 * options: { sample: fraction | false, cache: boolean, signal, onProgress({ fraction, rows, seconds }) }
 * Returns { states, rows, blank, ragged, sampled, fromCache, seconds }.
 */
export async function scan(path, specs, { sample = false, cache = false, signal, onProgress } = {}) {
  const info = await describe(path);
  const { cols, pos } = planColumns(specs);
  const ids = cols.map((c) => { const i = info.headers.indexOf(c); if (i < 0) throw new Error(`No column named "${c}".`); return i; });
  const t0 = Date.now();
  const manifest = await readManifest(info);
  const fromCache = manifest && ids.every((i) => manifest.columns.includes(i));
  let pieces, kind;
  if (fromCache) {
    kind = 'cache';
    pieces = manifest.chunks.map((c, i) => ({ kind, chunk: i, dir: cacheDir(info), colIds: ids, weight: c.end - c.start || c.rowEnd - c.rowStart }));
  } else if (info.kind === 'parquet') {
    kind = 'parquet';
    let groups = info.rowGroups.map((g, i) => ({ ...g, chunk: i }));
    if (sample) { const keepEvery = Math.max(1, Math.round(1 / sample)); groups = groups.filter((_, i) => i % keepEvery === 0); }
    pieces = groups.map((g) => ({ kind, chunk: g.chunk, path, mtimeMs: info.mtimeMs, sourceCols: ids.map((i) => info.sourceNames[i]), rowStart: g.rowStart, rowEnd: g.rowEnd, weight: g.rowEnd - g.rowStart }));
  } else {
    kind = 'csv';
    const ranges = sample ? await csvSampleBlocks(info, sample) : await csvChunks(info);
    pieces = ranges.map((r, i) => ({ kind, chunk: i, path, start: r.start, end: r.end, last: !sample && i === ranges.length - 1, delimiter: info.delimiter, headerLength: info.headers.length, cols: ids, weight: r.end - r.start }));
  }
  const writeCache = cache && !fromCache && !sample;
  const chunkList = kind === 'parquet' ? info.rowGroups : pieces.map((p) => ({ start: p.start, end: p.end }));
  if (writeCache) for (const p of pieces) p.cache = { dir: cacheDir(info), positions: ids.map((_, j) => j), colIds: ids };

  const total = pieces.reduce((s, p) => s + p.weight, 0) || 1;
  let done = 0, rows = 0, blank = 0, ragged = 0, badSplit = false, lastReport = 0;
  let merged = createAll(specs);
  const results = new Map();
  let next = 0;
  const report = (force) => {
    const now = Date.now();
    if (!onProgress || (!force && now - lastReport < 500)) return;
    lastReport = now;
    onProgress({ fraction: done / total, rows, seconds: (now - t0) / 1000 });
  };
  const onAbort = () => shutdown('cancelled');
  signal?.addEventListener('abort', onAbort);
  try {
    if (signal?.aborted) throw new Error('cancelled');
    await Promise.all(pieces.map((p) => submit({ ...p, specs, pos }).then((res) => {
      if (res.endQuoted && kind === 'csv' && !sample) badSplit = true;
      results.set(p.chunk, res);
      done += p.weight;
      while (results.has(pieces[next]?.chunk)) {
        const r = results.get(pieces[next].chunk);
        results.delete(pieces[next].chunk);
        merged = mergeAll(specs, merged, r.states);
        rows += r.rows; blank += r.blank; ragged += r.ragged;
        next++;
      }
      report(false);
    })));
  } catch (e) {
    if (signal?.aborted) throw new Error('The scan was cancelled.');
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (badSplit && pieces.length === 1) throw new Error('A quoted value is never closed (unmatched " character).');
  if (badSplit) {
    // A line break inside a quoted value fell on a split point: read the data in one piece instead.
    const one = { kind: 'csv', chunk: 0, path, start: info.dataStart, end: info.size, last: true, delimiter: info.delimiter, headerLength: info.headers.length, cols: ids, specs, pos };
    const res = await submit(one);
    if (res.endQuoted) throw new Error('A quoted value is never closed (unmatched " character).');
    merged = res.states; rows = res.rows; blank = res.blank; ragged = res.ragged;
  }
  const seconds = (Date.now() - t0) / 1000;
  if (!fromCache && !sample && seconds > 0.5) {
    const perWorker = info.size / seconds / Math.min(workerCount(), pieces.length);
    rates[kind] = rates[kind] * 0.5 + perWorker * 0.5;
  }
  if (writeCache && !badSplit) await addToManifest(info, chunkList, ids);
  report(true);
  return { states: merged, rows, blank, ragged, sampled: sample ? { fraction: sample, pieces: pieces.length } : false, fromCache: !!fromCache, seconds, info };
}
