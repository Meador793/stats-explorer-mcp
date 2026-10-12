// The large-file service the tools use: when to stream, asking the user before a long read,
// background jobs with progress, reusing results between steps, and the column cache.
import { AsyncLocalStorage } from 'node:async_hooks';
import { open, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { scan, describe, estimateSeconds } from './scan.js';
import { readManifest, cacheDir } from './cache.js';
import { workerCount } from './pool.js';
import { parseDelimitedText } from '../engine/dataImport.js';
import { parquetRead } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { parquetValue } from '../engine/dataImport.js';
import { fromRows } from '../table.js';
import { fileBuffer } from './source.js';
import { LargeFileError } from '../errors.js';
export { LargeFileError };

const MB = 1024 * 1024;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);

export const settings = () => ({
  streamMB: num(process.env.STATS_EXPLORER_STREAM_MB, 512),
  askSeconds: num(process.env.STATS_EXPLORER_ASK_SECONDS, 120),
  backgroundSeconds: num(process.env.STATS_EXPLORER_BACKGROUND_SECONDS, 40),
  cache: (process.env.STATS_EXPLORER_CACHE || 'ask').toLowerCase(), // ask | on | off
  sampleFraction: num(process.env.STATS_EXPLORER_SAMPLE_PERCENT, 1) / 100,
});

// ------------------------------------------------------------------ the current tool call

/** Per-call state: progress reporting, cancellation, the MCP context, background switch. */
export const callContext = new AsyncLocalStorage();
export const currentCall = () => callContext.getStore() || null;

// ------------------------------------------------------------------ which files stream

const STREAMABLE = ['.csv', '.tsv', '.txt', '.parquet', '.pq'];

/** True when the file is read by streaming rather than loaded into memory. */
export async function shouldStream(path) {
  const ext = extname(path).toLowerCase();
  if (!STREAMABLE.includes(ext)) return false;
  const { size } = await stat(path);
  const limit = settings().streamMB * MB;
  if (size > limit) return true;
  if (ext === '.parquet' || ext === '.pq') {
    // Parquet is compressed, so judge by cells (rows × columns) from the footer: about 20 bytes of
    // memory per cell when loaded, the same budget as a CSV of the limit's size.
    const info = await describe(path);
    return info.rows * info.headers.length > limit / 20;
  }
  return false;
}

// ------------------------------------------------------------------ decisions per file

const plans = new Map(); // `${path}|${size}|${mtime}` -> { choice: 'full' | 'sample', cache: boolean }
const fileKey = (info) => `${info.path}|${info.size}|${info.mtimeMs}`;

export function setPlan(info, plan) { plans.set(fileKey(info), plan); }
export function getPlan(info) { return plans.get(fileKey(info)); }

function minutes(sec) {
  if (sec < 90) return `about ${Math.max(1, Math.round(sec))} seconds`;
  if (sec < 5400) return `about ${Math.round(sec / 60)} minutes`;
  return `about ${(sec / 3600).toFixed(1)} hours`;
}
export const human = (bytes) => (bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

/** Rough size of the column cache for some columns (8 bytes per row per column at most). */
export function cacheEstimate(info, ncols) {
  const rows = info.rows ?? Math.round((info.size - (info.dataStart || 0)) / Math.max(20, info.avgRowBytes || 80));
  return rows * 8 * ncols;
}

export function planText(info, ncols = 2) {
  const full = estimateSeconds(info), quick = estimateSeconds(info, { sample: true });
  return {
    full, quick,
    message: `${info.path} is ${human(info.size)}. Reading all of it gives exact results and takes ${minutes(full)} (${workerCount()} parallel reader${workerCount() > 1 ? 's' : ''}). A quick estimate from about ${Math.round(settings().sampleFraction * 100)}% of the rows takes ${minutes(quick)}.`,
    cacheNote: `Keeping the columns this question reads makes follow-up questions on them much faster (uses up to about ${human(cacheEstimate(info, ncols))} of disk in ${cacheDir(info).replace(/[\\/][^\\/]+$/, '')}).`,
  };
}

/** Makes sure the user agreed to a long read, asking with a form when the client supports it. */
async function ensurePlan(info, ncols, cached) {
  const s = settings();
  const existing = getPlan(info);
  if (existing) return existing;
  if (cached) return { choice: 'full', cache: false };
  const { full, message, cacheNote } = planText(info, ncols);
  if (full <= s.askSeconds) return { choice: 'full', cache: s.cache === 'on' };
  const call = currentCall();
  const server = call?.ctx?.server;
  if (server?.getClientCapabilities?.()?.elicitation) {
    const properties = {
      choice: { type: 'string', title: 'How should Stats Explorer read this file?', enum: ['full', 'sample', 'cancel'], enumNames: [`Read all of it: exact (${minutes(full)})`, `Quick estimate from a sample (${minutes(estimateSeconds(info, { sample: true }))})`, 'Cancel'], default: 'full' },
    };
    if (s.cache === 'ask') properties.save_columns = { type: 'boolean', title: 'Keep the columns for faster follow-up questions', description: cacheNote, default: false };
    const res = await server.elicitInput({ message, requestedSchema: { type: 'object', properties, required: ['choice'] } });
    if (res.action !== 'accept' || res.content?.choice === 'cancel') throw new LargeFileError('The user chose not to read the file. Nothing was run.');
    const plan = { choice: res.content.choice, cache: s.cache === 'on' || (s.cache === 'ask' && !!res.content.save_columns) };
    setPlan(info, plan);
    return plan;
  }
  throw new LargeFileError([
    'LARGE FILE: nothing has run yet.',
    message,
    s.cache === 'ask' ? cacheNote : '',
    `Ask the user which they want, then call large_file_plan with file "${info.path}", choice "full" or "sample"${s.cache === 'ask' ? ', and save_columns true or false' : ''}, and then call this tool again.`,
  ].filter(Boolean).join('\n'));
}


// ------------------------------------------------------------------ scanning with reuse

const memo = new Map(); // `${fileKey}|${mode}|${JSON spec}` -> state
const MEMO_MAX = 40;

/**
 * Accumulator results for the specs, reading the file once for whatever isn't already known.
 * `prefetch` specs are computed in the same pass if needed (for the next workflow steps).
 * Returns { states, meta: { rows, sampled, fromCache, seconds, warnings } }.
 */
export async function accumulate(path, specs, { prefetch = [] } = {}) {
  const info = await describe(path);
  const cols = new Set(specs.flatMap(specColumns));
  for (const c of cols) if (!info.headers.includes(c)) throw new Error(`No column named "${c}". Columns are: ${info.headers.join(', ')}`);
  const manifest = await readManifest(info);
  const cached = manifest && [...cols].every((c) => manifest.columns.includes(info.headers.indexOf(c)));
  const plan = await ensurePlan(info, cols.size, cached);
  const mode = cached || plan.choice === 'full' ? 'full' : 'sample';
  const key = (sp) => `${fileKey(info)}|${mode}|${JSON.stringify(sp)}`;
  const todo = [...specs, ...prefetch.filter((p) => !specs.some((s) => JSON.stringify(s) === JSON.stringify(p)))].filter((sp) => !memo.has(key(sp)));
  let meta = memo.get(`${fileKey(info)}|${mode}|meta`);
  if (todo.length) {
    const call = currentCall();
    call?.scanStarted?.();
    const res = await scan(path, todo, {
      sample: mode === 'sample' ? settings().sampleFraction : false,
      cache: plan.cache,
      signal: call?.signal,
      onProgress: (p) => call?.progress?.(p, info),
    });
    todo.forEach((sp, i) => memo.set(key(sp), res.states[i]));
    meta = { rows: res.rows, sampled: res.sampled, fromCache: res.fromCache, seconds: res.seconds, ragged: res.ragged, warnings: [...info.warnings] };
    if (res.ragged) meta.warnings.push(`${res.ragged} row${res.ragged > 1 ? 's have' : ' has'} more values than there are column names; the extra values were ignored.`);
    memo.set(`${fileKey(info)}|${mode}|meta`, meta);
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    if (res.rows === 0) throw new Error('The data has a header row but no data rows.');
  }
  return { states: specs.map((sp) => memo.get(key(sp))), meta: meta || { warnings: [] }, info };
}

function specColumns(sp) {
  switch (sp.type) {
    case 'num': case 'counts': return [sp.col];
    case 'grouped': return [sp.col, sp.by];
    case 'pair': return [sp.x, sp.y];
    case 'crosstab': return [sp.row, sp.col];
    case 'groupedMulti': return [sp.by, ...sp.nums];
    case 'missing': case 'profile': return sp.cols;
    case 'baseRate': return [sp.cond, sp.test];
    default: return [];
  }
}

// ------------------------------------------------------------------ a quick look at the first rows

const heads = new Map();

/** The first rows (up to about 4 MB) as an in-memory table, for column lists and dropdowns. */
export async function headSample(path) {
  const info = await describe(path);
  const k = fileKey(info);
  if (heads.has(k)) return heads.get(k);
  let table;
  if (info.kind === 'parquet') {
    const file = await fileBuffer(path);
    try {
      let rows = [];
      await parquetRead({ file, compressors, rowStart: 0, rowEnd: Math.min(info.rows, 2000), rowFormat: 'array', columns: info.sourceNames, onComplete: (r) => { rows = r; } });
      table = fromRows({ headers: info.headers, rows: rows.map((r) => Object.fromEntries(info.headers.map((h, i) => [h, parquetValue(r[i])]))), warnings: [] });
    } finally { await file.close(); }
  } else {
    const fh = await open(path, 'r');
    try {
      const len = Math.min(info.size, info.dataStart + 4 * MB);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      let text = new TextDecoder('utf-8').decode(buf.subarray(0, bytesRead));
      if (bytesRead < info.size) { const cut = text.lastIndexOf('\n'); if (cut > 0) text = text.slice(0, cut + 1); }
      const p = parseDelimitedText(text);
      info.avgRowBytes = (Math.max(1, bytesRead - info.dataStart)) / Math.max(1, p.rows.length);
      table = fromRows(p);
    } finally { await fh.close(); }
  }
  heads.set(k, table);
  if (heads.size > 20) heads.delete(heads.keys().next().value);
  return table;
}

export { describe };
