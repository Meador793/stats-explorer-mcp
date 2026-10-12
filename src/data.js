// Reading local data files for the tools, confined to allowed folders.
// Parsing is the Stats Explorer app's own import module (engine/dataImport.js), so the MCP and the
// app read CSV, TSV, Excel and Parquet identically: missing cells are null, numbers are strict,
// dates are YYYY-MM-DD text, duplicate column names are renamed.

import { readFile, realpath, stat, access, readdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve, relative, extname, dirname, basename } from 'node:path';
import { readExcel, readParquet, isMissingValue } from './engine/dataImport.js';
import { readDelimitedFile, fromRows } from './table.js';

// Files up to STATS_EXPLORER_STREAM_MB (default 512 MB) are loaded into compact column storage
// (src/table.js). Larger CSV, TSV and Parquet files are streamed in parallel passes (src/big/), so
// there is no size limit unless STATS_EXPLORER_MAX_FILE_MB sets one. Excel files are read whole.
export const DEFAULT_MAX_FILE_MB = Infinity; // no limit: large CSV and Parquet files are streamed
export const HARD_MAX_BINARY_MB = 1900; // readFile() refuses files over 2 GiB (Excel, Parquet)
const MB = 1024 * 1024;

export function maxFileBytes(env = process.env) {
  const n = Number(env.STATS_EXPLORER_MAX_FILE_MB);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_MB) * MB;
}
export const TABULAR_EXTENSIONS = ['.csv', '.tsv', '.txt', '.xlsx', '.xlsm', '.xls', '.parquet', '.pq'];

import { UserError, NotTabularError, LargeFileError } from './errors.js';
export { UserError, NotTabularError, LargeFileError };

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
/**
 * Turns the ways chat clients refer to an attached or mentioned file into a plain path:
 * "@data/sales.csv" (Claude Code), "#file:sales.csv" (VS Code), file:///D:/My%20Data/sales.csv URIs,
 * and names wrapped in quotes or backticks.
 */
export function normalizeFileRef(file) {
  let f = String(file ?? '').trim();
  for (let k = 0; k < 3; k++) {
    const m = /^(["'`])(.*)\1$/s.exec(f);
    if (m) f = m[2].trim();
  }
  f = f.replace(/^#file:/i, '').replace(/^@(?=[^\s@])/, '');
  if (/^file:\/\//i.test(f)) {
    try { f = fileURLToPath(f); } catch { f = decodeURIComponent(f.replace(/^file:\/\/(localhost)?/i, '')); }
  }
  return f;
}

export function assertTabularSource(file) {
  const f = normalizeFileRef(file);
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
  const f = normalizeFileRef(file);
  return isAbsolute(f) ? resolve(f) : resolve(allowedRoots[0], f);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache']);

/** Finds files with this name anywhere in the allowed folders (bounded search). */
async function findByName(name) {
  const found = [];
  let visited = 0;
  const walk = async (dir, depth) => {
    if (depth > 8 || visited > 50000 || found.length > 10) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      visited++;
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) found.push(resolve(dir, e.name));
      else if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(resolve(dir, e.name), depth + 1);
    }
  };
  for (const root of allowedRoots) await walk(root, 0);
  return [...new Set(found)];
}

async function resolveAllowedPath(file) {
  let candidate = candidatePath(file);
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    // Relative names: try the other allowed folders, then search them for the file name, so
    // "sales.csv" works even when the file sits in a subfolder of the workspace.
    const f = normalizeFileRef(file);
    if (!isAbsolute(f)) {
      for (const root of allowedRoots.slice(1)) {
        try { real = await realpath(resolve(root, f)); break; } catch { /* next */ }
      }
      if (!real) {
        const hits = await findByName(basename(f));
        const matching = hits.filter((h) => h.replace(/\\/g, '/').toLowerCase().endsWith(f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()));
        if (matching.length === 1) real = await realpath(matching[0]);
        else if (matching.length > 1) throw new UserError(`More than one file matches "${file}": ${matching.slice(0, 5).join(', ')}. Give the full path.`);
      }
    }
    if (!real) throw new UserError(`File not found: ${file}`);
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

/**
 * Loads a data file (cached until it changes). Returns a ColumnTable (src/table.js):
 * { headers, rowCount, warnings, path, sheetName?, col(), value(), column(), rowsOf(), preview() }.
 */
export async function loadTable(file) {
  assertTabularSource(file);
  const path = await resolveAllowedPath(file);
  const st = await stat(path);
  if (!st.isFile()) throw new UserError(`${file} is not a file.`);
  const ext = extname(path).toLowerCase();
  const binary = ['.xlsx', '.xlsm', '.xls', '.parquet', '.pq'].includes(ext);
  const sizeMB = Math.round(st.size / MB);
  if (binary && st.size > HARD_MAX_BINARY_MB * MB) {
    throw new UserError(`${file} is ${sizeMB} MB, more than the ${HARD_MAX_BINARY_MB} MB this server can load from an Excel or Parquet file. Export it to CSV (which is streamed, with no such ceiling) or analyse a sample.`);
  }
  if (st.size > maxFileBytes()) {
    const limit = Math.round(maxFileBytes() / MB);
    throw new UserError(`${file} is ${sizeMB} MB, larger than the current ${limit} MB limit. Raise it with the STATS_EXPLORER_MAX_FILE_MB setting (in VS Code: Settings → Stats Explorer: Max File MB).`);
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.table;
  let table;
  try {
    if (binary) {
      const buf = await readFile(path);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      const parsed = ext.startsWith('.xls') ? readExcel(ab) : await readParquet(ab);
      table = fromRows(parsed);
      if (parsed.sheetName) table.sheetName = parsed.sheetName;
    } else {
      table = await readDelimitedFile(path, {
        // A .csv/.txt that actually holds JSON documents.
        inspectStart: (text) => {
          if (/^\uFEFF?\s*[[{]/.test(text) && /^\uFEFF?\s*[[{]\s*["{[]/.test(text)) throw notTabular(`"${file}" contains JSON, which`);
        },
      });
    }
  } catch (e) {
    if (e instanceof UserError) throw e;
    if (e && (e.code === 'ERR_FS_FILE_TOO_LARGE' || e instanceof RangeError || /array buffer allocation|out of memory/i.test(e.message))) {
      throw new UserError(`${file} is too large to load in the memory available. Analyse a sample of the rows instead.`);
    }
    throw new UserError(`Could not read ${file}: ${e.message}`);
  }
  table.path = path;
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, table });
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return table;
}

/**
 * The resolved path when this data file should be streamed (a large CSV, TSV or Parquet file),
 * otherwise null (the tools then use loadTable).
 */
export async function largeFilePath(file) {
  assertTabularSource(file);
  const path = await resolveAllowedPath(file);
  const st = await stat(path);
  if (!st.isFile()) return null;
  const { shouldStream } = await import('./big/service.js');
  if (!(await shouldStream(path))) return null;
  if (!['.parquet', '.pq'].includes(extname(path).toLowerCase())) {
    // A .csv/.txt that actually holds JSON documents.
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, 4096, 0);
      const head = buf.subarray(0, bytesRead).toString('utf8');
      if (/^\uFEFF?\s*[[{]/.test(head) && /^\uFEFF?\s*[[{]\s*["{[]/.test(head)) throw notTabular(`"${file}" contains JSON, which`);
    } finally { await fh.close(); }
  }
  if (st.size > maxFileBytes()) {
    throw new UserError(`${file} is ${Math.round(st.size / MB)} MB, larger than the ${Math.round(maxFileBytes() / MB)} MB limit set by STATS_EXPLORER_MAX_FILE_MB.`);
  }
  return path;
}

/**
 * A table to choose columns from. Small files: the loaded table. Large (streamed) files: the header
 * plus the first few thousand rows (`sample`), marked `big: true`; statistics on them are computed by
 * streaming passes, never from the sample.
 */
export async function openTable(file) {
  const big = await largeFilePath(file);
  if (!big) return loadTable(file);
  const { headSample, describe } = await import('./big/service.js');
  try {
    const info = await describe(big);
    const sample = await headSample(big);
    return { big: true, path: big, headers: info.headers, sample, warnings: info.warnings, info };
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(`Could not read ${file}: ${e.message}`);
  }
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

/** Per distinct value of a dictionary column: its number, or null if missing, or NaN if text. */
function dictNumbers(dict) {
  return dict.map((v) => (v === null || isMissing(v) ? null : (toNumber(v) ?? NaN)));
}

/**
 * Numeric values of one column, skipping missing cells. Text in a numeric column is an error.
 * `rows` (row objects) restricts it to those rows; otherwise the whole column is read.
 */
export function numericColumn(table, column, rows) {
  requireColumn(table, column);
  const out = [];
  let bad = 0, firstBad;
  if (rows) {
    for (const r of rows) {
      const v = r[column];
      if (isMissing(v)) continue;
      const n = toNumber(v);
      if (n === null) { bad++; firstBad ??= v; } else out.push(n);
    }
  } else {
    const c = table.col(column);
    if (c.kind === 'num') {
      for (const v of c.data) if (v === v) out.push(v);
    } else {
      const nums = dictNumbers(c.dict);
      for (const code of c.codes) {
        const n = nums[code];
        if (n === null) continue;
        if (n !== n) { bad++; firstBad ??= c.dict[code]; } else out.push(n);
      }
    }
  }
  if (bad) throw new UserError(`Column "${column}" has ${bad} non-numeric value(s), e.g. "${firstBad}". Clean the column or pick a numeric one.`);
  return out;
}

/** True when every non-missing value is a number (and there is at least one). */
export function isNumericColumn(table, column) {
  if (table.big) return isNumericColumn(table.sample, column);
  const c = table.col(column);
  if (!c) return false;
  if (c.kind === 'num') { for (const v of c.data) if (v === v) return true; return false; }
  let seen = false;
  const used = new Uint8Array(c.dict.length);
  for (const code of c.codes) used[code] = 1;
  for (let k = 1; k < c.dict.length; k++) {
    if (!used[k]) continue;
    const v = c.dict[k];
    if (isMissing(v)) continue;
    if (toNumber(v) === null) return false;
    seen = true;
  }
  return seen;
}

/** Count of missing cells in a column. */
export function missingCount(table, column) {
  const c = table.col(column);
  let m = 0;
  if (c.kind === 'num') { for (const v of c.data) if (v !== v) m++; }
  else { for (const code of c.codes) if (code === 0) m++; }
  return m;
}

/**
 * Calls fn(key, rowIndex) for every row where the column is not missing; key is the trimmed text
 * form used for grouping (categoryKey). Computed once per distinct value for dictionary columns.
 */
export function forEachCategory(table, column, fn) {
  const c = table.col(column);
  if (c.kind === 'num') {
    for (let i = 0; i < c.data.length; i++) { const v = c.data[i]; if (v === v) fn(String(v), i); }
  } else {
    const keys = c.dict.map((v) => (v === null || isMissing(v) ? null : categoryKey(v)));
    for (let i = 0; i < c.codes.length; i++) { const k = keys[c.codes[i]]; if (k !== null) fn(k, i); }
  }
}

export const categoryKey = (v) => (typeof v === 'string' ? v.trim() : String(v));

/** Distinct non-missing values of a column, most frequent first. */
export function categories(table, column) {
  if (table.big) return categories(table.sample, column);
  const counts = new Map();
  forEachCategory(table, column, (k) => counts.set(k, (counts.get(k) || 0) + 1));
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}
