// Reading local data files for the tools, confined to allowed folders.
// Parsing is the Stats Explorer app's own import module (engine/dataImport.js), so the MCP and the
// app read CSV, TSV, Excel and Parquet identically: missing cells are null, numbers are strict,
// dates are YYYY-MM-DD text, duplicate column names are renamed.

import { readFile, realpath, stat, access } from 'node:fs/promises';
import { isAbsolute, resolve, relative, extname, dirname } from 'node:path';
import { parseDelimitedText, readExcel, readParquet, isMissingValue } from './engine/dataImport.js';

// Files are read whole and parsed into memory (about 14 bytes of RAM per byte of CSV), so the limit is
// configurable: STATS_EXPLORER_MAX_FILE_MB (default 250). Text files also have a hard ceiling because
// Node cannot hold a string longer than about 512 MB; for bigger data, export a sample or use Parquet.
export const DEFAULT_MAX_FILE_MB = 250;
export const HARD_MAX_TEXT_MB = 480;
export const HARD_MAX_BINARY_MB = 1900; // readFile() refuses files over 2 GiB
const MB = 1024 * 1024;

export function maxFileBytes(env = process.env) {
  const n = Number(env.STATS_EXPLORER_MAX_FILE_MB);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_MB) * MB;
}
export const TABULAR_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx', '.xlsm', '.xls', '.parquet', '.pq'];

export class UserError extends Error {}

/** Raised for document / NoSQL data. Its message is the statement users should see. */
export class NotTabularError extends UserError {}

export const TABULAR_STATEMENT =
  'Stats Explorer is built for tabular formats (CSV, TSV, Excel and Parquet) to run hypothesis tests or explore statistics.';

function notTabular(what, kind = 'document-style (NoSQL) data such as JSON or BSON') {
  return new NotTabularError(
    `${TABULAR_STATEMENT} ${what} is ${kind}, which isn't tabular. ` +
    'To analyse it, first export it as a table with one row per record and one column per field ' +
    '(for example `mongoexport --type=csv --fields=...`, or flatten it to CSV or Parquet), then use that file.'
  );
}

const NOSQL_EXTENSIONS = ['.json', '.jsonl', '.ndjson', '.bson', '.geojson'];
const DATABASE_URI = /^(mongodb(\+srv)?|couchdb|couchbase|redis|rediss|cassandra|dynamodb|firestore|elasticsearch|neo4j|bolt|arangodb):\/\//i;

/** Throws the tabular statement for NoSQL sources (files, connection strings) and other unsupported inputs. */
export function assertTabularSource(file) {
  const f = String(file || '').trim();
  if (DATABASE_URI.test(f)) {
    throw notTabular(`The ${f.split('://')[0]} connection you referenced`, 'a NoSQL database (document, key-value or graph data)');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(f) && !/^file:\/\//i.test(f)) {
    throw new UserError(`${TABULAR_STATEMENT} It reads local files only, not URLs or database connections. Save the data as a CSV, TSV, Excel or Parquet file in your workspace and use that path.`);
  }
  const ext = extname(f).toLowerCase();
  if (NOSQL_EXTENSIONS.includes(ext)) throw notTabular(`"${f}"`);
  if (ext && !TABULAR_EXTENSIONS.includes(ext)) {
    throw new UserError(`${TABULAR_STATEMENT} "${f}" (${ext}) is not one of those formats.`);
  }
}

/** Throws the tabular statement if inline rows contain nested objects or arrays (documents, not a table). */
export function assertFlatRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new UserError('rows must be a non-empty array of row objects.');
  for (const r of rows) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw notTabular('The rows you passed are not one-object-per-row data; this');
    for (const v of Object.values(r)) {
      if (v !== null && typeof v === 'object') throw notTabular('The rows you passed contain nested objects or arrays, so this');
    }
  }
}

// ---------------------------------------------------------------- allowed folders

let allowedRoots = [];

/** Sets the folders files may be read from (absolute paths). The first one is used for relative paths. */
export function setAllowedRoots(roots) {
  allowedRoots = roots.filter(Boolean).map((r) => resolve(r));
}
export function getAllowedRoots() {
  return [...allowedRoots];
}

async function insideRoots(real) {
  for (const root of allowedRoots) {
    let realRoot;
    try { realRoot = await realpath(root); } catch { continue; }
    const rel = relative(realRoot, real);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true;
  }
  return false;
}

function candidatePath(file) {
  if (typeof file !== 'string' || !file.trim()) throw new UserError('file must be a non-empty path');
  if (allowedRoots.length === 0) throw new UserError('No data folders are allowed. Set STATS_EXPLORER_ROOTS or open a workspace folder.');
  const f = file.replace(/^file:\/\//i, '');
  return isAbsolute(f) ? resolve(f) : resolve(allowedRoots[0], f);
}

async function resolveAllowedPath(file) {
  const candidate = candidatePath(file);
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    throw new UserError(`File not found: ${file}`);
  }
  if (await insideRoots(real)) return real;
  throw new UserError(`${file} is outside the allowed data folders (${allowedRoots.join(', ')}).`);
}

/** Resolves a path the report may be written to: inside the allowed folders, parent folder must exist. */
export async function resolveWritablePath(file, { overwrite = false } = {}) {
  const candidate = candidatePath(file);
  let parent;
  try { parent = await realpath(dirname(candidate)); } catch { throw new UserError(`Folder does not exist: ${dirname(candidate)}`); }
  const target = resolve(parent, candidate.slice(dirname(candidate).length + 1));
  if (!(await insideRoots(target))) throw new UserError(`${file} is outside the allowed folders (${allowedRoots.join(', ')}).`);
  let exists = true;
  try { await access(target); } catch { exists = false; }
  if (exists) {
    if (!overwrite) throw new UserError(`${file} already exists. Choose another name or pass overwrite: true.`);
    if (!(await insideRoots(await realpath(target)))) throw new UserError(`${file} points outside the allowed folders.`);
  }
  return target;
}

// ---------------------------------------------------------------- loading

const cache = new Map(); // path -> { mtimeMs, size, table }

/** Loads a data file (cached until it changes). Returns { headers, rows, warnings, path, sheetName? }. */
export async function loadTable(file) {
  assertTabularSource(file);
  const path = await resolveAllowedPath(file);
  const st = await stat(path);
  if (!st.isFile()) throw new UserError(`${file} is not a file.`);
  const ext0 = extname(path).toLowerCase();
  const isText = !['.xlsx', '.xlsm', '.xls', '.parquet', '.pq'].includes(ext0);
  const sizeMB = Math.round(st.size / MB);
  const hard = isText ? HARD_MAX_TEXT_MB : HARD_MAX_BINARY_MB;
  if (st.size > hard * MB) {
    throw new UserError(`${file} is ${sizeMB} MB, more than the ${hard} MB this server can load${isText ? ' from a text file' : ''}. Export a sample of the rows${isText ? ', or convert it to Parquet (smaller and faster to read)' : ''} and analyse that.`);
  }
  if (st.size > maxFileBytes()) {
    const limit = Math.round(maxFileBytes() / MB);
    throw new UserError(`${file} is ${sizeMB} MB, larger than the current ${limit} MB limit. Raise it with the STATS_EXPLORER_MAX_FILE_MB setting (in VS Code: Settings → Stats Explorer: Max File MB). Loading needs roughly 14× the file size in free memory, so for very large files analyse a sample instead.`);
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.table;
  const ext = extname(path).toLowerCase();
  const buf = await readFile(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let parsed;
  try {
    if (['.xlsx', '.xlsm', '.xls'].includes(ext)) parsed = readExcel(ab);
    else if (['.parquet', '.pq'].includes(ext)) parsed = await readParquet(ab);
    else {
      const text = buf.toString('utf8');
      // A .csv/.txt that actually holds JSON documents.
      if (/^﻿?\s*[[{]/.test(text) && /^﻿?\s*[[{]\s*["{[]/.test(text)) throw notTabular(`"${file}" contains JSON, which`);
      parsed = parseDelimitedText(text);
    }
  } catch (e) {
    if (e instanceof UserError) throw e;
    if (e && (e.code === 'ERR_STRING_TOO_LONG' || e.code === 'ERR_FS_FILE_TOO_LARGE' || /array buffer allocation|out of memory/i.test(e.message))) {
      throw new UserError(`${file} is too large to load in memory. Export a sample of the rows, or convert it to Parquet.`);
    }
    throw new UserError(`Could not read ${file}: ${e.message}`);
  }
  const table = { ...parsed, path };
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, table });
  if (cache.size > 20) cache.delete(cache.keys().next().value);
  return table;
}

// ---------------------------------------------------------------- column helpers

export const isMissing = (v) => isMissingValue(v);

/** Strict numeric conversion for inline values: plain decimal notation only (no hex, no "12 kg"). */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  // Plain decimal notation only: Number() alone would also accept hex ("0x1A"), binary and octal.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function requireColumn(table, name, role = 'column') {
  if (!table.headers.includes(name)) {
    throw new UserError(`No ${role} named "${name}". Columns are: ${table.headers.join(', ')}`);
  }
}

/** Numeric values of one column, skipping missing cells. Text in a numeric column is an error. */
export function numericColumn(table, column, rows = table.rows) {
  requireColumn(table, column);
  const out = [];
  let bad = 0, firstBad;
  for (const r of rows) {
    const v = r[column];
    if (isMissing(v)) continue;
    const n = toNumber(v);
    if (n === null) { bad++; firstBad ??= v; } else out.push(n);
  }
  if (bad) throw new UserError(`Column "${column}" has ${bad} non-numeric value(s), e.g. "${firstBad}". Clean the column or pick a numeric one.`);
  return out;
}

/** True when every non-missing value is a number (and there is at least one). */
export function isNumericColumn(table, column) {
  let seen = false;
  for (const r of table.rows) {
    const v = r[column];
    if (isMissing(v)) continue;
    if (toNumber(v) === null) return false;
    seen = true;
  }
  return seen;
}

export const categoryKey = (v) => (typeof v === 'string' ? v.trim() : String(v));

/** Distinct non-missing values of a column, most frequent first. */
export function categories(table, column) {
  const counts = new Map();
  for (const r of table.rows) {
    if (isMissing(r[column])) continue;
    const k = categoryKey(r[column]);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}
