// What one worker thread does with one piece of a file: parse it, keep the needed columns, feed the
// accumulators, and optionally save those columns to the cache. Also runs in the main thread for
// tests and single-threaded fallbacks.
import { open, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parquetRead } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { parseCell, parquetValue } from '../engine/dataImport.js';
import { Tokenizer, plainNumber, ColumnBuilder } from '../table.js';
import { createAll, makeFeeder, reseed } from './acc.js';
import { fileBuffer } from './source.js';

const PIECE = 4 * 1024 * 1024;

/** Converts one tokenized cell exactly as the in-memory loader does. */
function makeConverter(decimalComma) {
  return (c) => {
    if (c === undefined) return null;
    const quoted = typeof c === 'object';
    const raw = quoted ? c.q : c;
    if (quoted && raw === '') return null;
    const fast = plainNumber(raw);
    if (fast !== undefined) return fast;
    return parseCell(raw, { decimalComma });
  };
}

function cacheWriters(task) {
  if (!task.cache) return null;
  return task.cache.positions.map(() => new ColumnBuilder());
}

async function flushCache(task, builders) {
  if (!builders) return;
  await Promise.all(task.cache.positions.map(async (p, j) => {
    const col = builders[j].finish();
    const dir = join(task.cache.dir, String(task.cache.colIds[j]));
    await mkdir(dir, { recursive: true });
    const base = join(dir, String(task.chunk));
    if (col.kind === 'num') await writeFile(`${base}.f64`, Buffer.from(col.data.buffer, col.data.byteOffset, col.data.byteLength));
    else {
      await writeFile(`${base}.u32`, Buffer.from(col.codes.buffer, col.codes.byteOffset, col.codes.byteLength));
      await writeFile(`${base}.json`, JSON.stringify(col.dict));
    }
  }));
}

/** Parses bytes [start, end) of a delimited file. */
async function runCsv(task, specs, pos, states, feed) {
  const { path, start, end, delimiter, headerLength: h, cols: idx } = task;
  const convert = makeConverter(delimiter === ';');
  const need = new Set(idx);
  const builders = cacheWriters(task);
  let rows = 0, blank = 0, ragged = 0;
  const vals = new Array(idx.length);
  const tok = new Tokenizer(delimiter, (raw) => {
    let any = false;
    for (let j = 0; j < idx.length; j++) { const v = convert(raw[idx[j]]); vals[j] = v; if (v !== null) any = true; }
    if (!any) {
      for (let k = 0; k < raw.length; k++) if (!need.has(k) && convert(raw[k]) !== null) { any = true; break; }
      if (!any) { blank++; return; }
    }
    if (raw.length > h) for (let k = h; k < raw.length; k++) if (convert(raw[k]) !== null) { ragged++; break; }
    rows++;
    feed(vals);
    if (builders) task.cache.positions.forEach((p, j) => builders[j].push(vals[p]));
  });
  tok.first = false; // a BOM can only be at the very start of the file, which is the header
  const fh = await open(path, 'r');
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const buf = Buffer.allocUnsafe(PIECE);
  let posn = start, endQuoted = false;
  try {
    while (posn < end) {
      const len = Math.min(PIECE, end - posn);
      const { bytesRead } = await fh.read(buf, 0, len, posn);
      if (!bytesRead) break;
      posn += bytesRead;
      const last = posn >= end;
      tok.feed(decoder.decode(buf.subarray(0, bytesRead), { stream: !last }), last);
      if (task.abortCheck && task.abortCheck()) break;
    }
  } finally {
    await fh.close();
  }
  if (tok.quoted) endQuoted = true; // the piece ends inside a quoted value: the split point was wrong
  else if (task.last) tok.end();
  await flushCache(task, builders);
  return { rows, blank, ragged, endQuoted };
}

const metaCache = new Map();

/** Reads rows [rowStart, rowEnd) of the needed Parquet columns. */
async function runParquet(task, feed) {
  const file = await fileBuffer(task.path);
  const builders = cacheWriters(task);
  let rows = 0;
  try {
    const key = `${task.path}:${task.mtimeMs}`;
    let metadata = metaCache.get(key);
    let data = [];
    const opts = { file, compressors, columns: task.sourceCols, rowStart: task.rowStart, rowEnd: task.rowEnd, rowFormat: 'array', onComplete: (r) => { data = r; } };
    if (metadata) opts.metadata = metadata;
    await parquetRead(opts);
    if (!metadata && opts.metadata) metaCache.set(key, opts.metadata);
    const vals = new Array(task.sourceCols.length);
    for (const r of data) {
      for (let j = 0; j < vals.length; j++) vals[j] = parquetValue(r[j]);
      rows++;
      feed(vals);
      if (builders) task.cache.positions.forEach((p, j) => builders[j].push(vals[p]));
    }
  } finally {
    await file.close();
  }
  await flushCache(task, builders);
  return { rows, blank: 0, ragged: 0, endQuoted: false };
}

/** Reads cached columns of one chunk. */
async function runCache(task, feed) {
  const cols = await Promise.all(task.colIds.map(async (id) => {
    const base = join(task.dir, String(id), String(task.chunk));
    try {
      const b = await readFile(`${base}.f64`);
      return { num: new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8) };
    } catch {
      const b = await readFile(`${base}.u32`);
      return { codes: new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4), dict: JSON.parse(await readFile(`${base}.json`, 'utf8')) };
    }
  }));
  const n = cols[0].num ? cols[0].num.length : cols[0].codes.length;
  const vals = new Array(cols.length);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < cols.length; j++) {
      const c = cols[j];
      if (c.num) { const v = c.num[i]; vals[j] = v !== v ? null : v; } else vals[j] = c.dict[c.codes[i]];
    }
    feed(vals);
  }
  return { rows: n, blank: 0, ragged: 0, endQuoted: false };
}

/** Runs one task and returns its accumulator states plus row counts. */
export async function runTask(task) {
  reseed(task.chunk + 1);
  const { specs, pos } = task;
  const states = createAll(specs);
  const feed = makeFeeder(specs, pos, states);
  const res = task.kind === 'csv' ? await runCsv(task, specs, pos, states, feed)
    : task.kind === 'parquet' ? await runParquet(task, feed)
      : await runCache(task, feed);
  return { chunk: task.chunk, states, ...res };
}
