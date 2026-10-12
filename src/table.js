// Memory-efficient tables for large data files.
//
// The app's import module (engine/dataImport.js) turns a whole file into one string and then into one
// JavaScript object per row. That is fine in a browser with small files, but a 190 MB CSV becomes
// about 2.7 GB of memory. Here the same rules are applied while the file is streamed in 1 MB chunks,
// and each column is stored compactly:
//   • numeric columns in a Float64Array (8 bytes per value; NaN marks a missing cell);
//   • any other column as Uint32 codes into a list of its distinct values (4 bytes per value),
//     so "Consumer"/"Business" repeated a million times is stored once.
// Values are identical to parseDelimitedText(): the same tokenizer rules, parseCell(), header
// cleaning, blank-row skipping and warnings (checked in test/table.test.mjs).

import { createReadStream } from 'node:fs';
import { parseCell, cleanHeaders, detectDelimiter } from './engine/dataImport.js';

// ------------------------------------------------------------------ columns

class NumColumn {
  constructor(data) { this.kind = 'num'; this.data = data; }
  get(i) { const v = this.data[i]; return v !== v ? null : v; } // NaN = missing
}

class DictColumn {
  constructor(codes, dict) { this.kind = 'dict'; this.codes = codes; this.dict = dict; }
  get(i) { return this.dict[this.codes[i]]; }
}

// V8 keeps a substring of 13+ characters as a view into its parent string; storing such views would
// keep every 1 MB chunk of the file alive. Copy them into standalone strings.
const own = (s) => (s.length >= 13 ? Buffer.from(s, 'utf8').toString('utf8') : s);

export class ColumnBuilder {
  constructor() {
    this.n = 0;
    this.num = new Float64Array(1024);
    this.codes = null; // switches to dictionary mode on the first non-number
    this.dict = null;
    this.index = null;
  }

  #grow() {
    const cap = this.n * 2;
    if (this.codes) { const c = new Uint32Array(cap); c.set(this.codes); this.codes = c; }
    else { const a = new Float64Array(cap); a.set(this.num); this.num = a; }
  }

  #toDict() {
    this.dict = [null];
    this.index = new Map();
    this.codes = new Uint32Array(this.num.length);
    for (let i = 0; i < this.n; i++) { const v = this.num[i]; this.codes[i] = v !== v ? 0 : this.#code(v); }
    this.num = null;
  }

  #code(v) {
    let c = this.index.get(v);
    if (c === undefined) {
      c = this.dict.length;
      this.dict.push(typeof v === 'string' ? own(v) : v);
      this.index.set(v, c);
    }
    return c;
  }

  push(v) {
    if (this.n === (this.codes ? this.codes.length : this.num.length)) this.#grow();
    if (!this.codes) {
      if (v === null || v === undefined) { this.num[this.n++] = NaN; return; }
      if (typeof v === 'number') { this.num[this.n++] = v; return; }
      this.#toDict();
    }
    this.codes[this.n++] = v === null || v === undefined || (typeof v === 'number' && v !== v) ? 0 : this.#code(v);
  }

  finish() {
    if (this.codes) return new DictColumn(this.codes.slice(0, this.n), this.dict);
    return new NumColumn(this.num.slice(0, this.n));
  }
}

// ------------------------------------------------------------------ table

export class ColumnTable {
  constructor(headers, columns, rowCount, warnings = []) {
    this.headers = headers;
    this.columns = new Map(headers.map((h, i) => [h, columns[i]]));
    this.rowCount = rowCount;
    this.warnings = warnings;
  }

  col(name) { return this.columns.get(name); }

  value(name, i) { return this.columns.get(name).get(i); }

  /** All values of one column as a plain array (null = missing). */
  column(name) {
    const c = this.columns.get(name);
    const out = new Array(this.rowCount);
    for (let i = 0; i < this.rowCount; i++) out[i] = c.get(i);
    return out;
  }

  /** Row objects holding only the named columns. */
  rowsOf(names) {
    const cols = names.map((n) => [n, this.columns.get(n)]);
    const out = new Array(this.rowCount);
    for (let i = 0; i < this.rowCount; i++) {
      const o = {};
      for (const [n, c] of cols) o[n] = c.get(i);
      out[i] = o;
    }
    return out;
  }

  preview(k = 5) {
    const out = [];
    for (let i = 0; i < Math.min(k, this.rowCount); i++) {
      const o = {};
      for (const h of this.headers) o[h] = this.value(h, i);
      out.push(o);
    }
    return out;
  }

  /** Every row as an object. Avoid on large files; use rowsOf() with the columns you need. */
  get rows() { return this.rowsOf(this.headers); }
}

/** Builds a table from { headers, rows } (Excel, Parquet and inline data). */
export function fromRows({ headers, rows, warnings = [] }) {
  const builders = headers.map(() => new ColumnBuilder());
  for (const r of rows) headers.forEach((h, i) => builders[i].push(r[h]));
  return new ColumnTable(headers, builders.map((b) => b.finish()), rows.length, warnings);
}

// ------------------------------------------------------------------ streaming CSV / TSV

const CHUNK = 1 << 20;

/** Incremental version of engine splitDelimited(): same rules, fed one chunk at a time. */
export class Tokenizer {
  constructor(delimiter, onRow) {
    this.d = delimiter;
    this.D = delimiter.charCodeAt(0);
    this.onRow = onRow;
    this.row = [];
    this.field = '';
    this.quoted = false;
    this.wasQuoted = false;
    this.carry = '';
    this.first = true;
    this.fed = 0;        // characters passed to feed() so far
    this.rowEndChar = 0; // character offset just after the last completed row
  }

  #endField() {
    this.row.push(this.wasQuoted ? { q: this.field } : this.field);
    this.field = '';
    this.wasQuoted = false;
  }

  feed(chunk, final = false) {
    const base = this.fed - this.carry.length; // character offset of text[0]
    this.fed += chunk.length;
    const text = this.carry + chunk;
    this.carry = '';
    const n = text.length;
    let i = 0;
    if (this.first) { this.first = false; if (text.charCodeAt(0) === 0xfeff) i = 1; }
    const D = this.D;
    for (; i < n; i++) {
      const ch = text[i];
      if (this.quoted) {
        if (ch === '"') {
          if (i + 1 >= n && !final) { this.carry = text.slice(i); return; }
          if (text[i + 1] === '"') { this.field += '"'; i++; } else this.quoted = false;
        } else {
          const j = text.indexOf('"', i);
          const end = j < 0 ? n : j;
          this.field += text.slice(i, end);
          i = end - 1;
        }
      } else if (ch === '"' && this.field.trim() === '') {
        this.quoted = true; this.wasQuoted = true; this.field = '';
      } else if (ch === this.d) {
        this.#endField();
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r') {
          if (i + 1 >= n && !final) { this.carry = text.slice(i); return; }
          if (text[i + 1] === '\n') i++;
        }
        this.#endField(); this.rowEndChar = base + i + 1; this.onRow(this.row); this.row = [];
      } else {
        // A run of ordinary characters, copied in one slice.
        let j = i + 1;
        while (j < n) { const c = text.charCodeAt(j); if (c === D || c === 10 || c === 13 || c === 34) break; j++; }
        this.field += text.slice(i, j);
        i = j - 1;
      }
    }
  }

  end() {
    if (this.carry) { const c = this.carry; this.carry = ''; this.feed(c, true); }
    if (this.quoted) throw new Error('A quoted value is never closed (unmatched " character).');
    if (this.field !== '' || this.wasQuoted || this.row.length) { this.#endField(); this.onRow(this.row); }
  }
}

export const unq = (c) => (typeof c === 'object' ? c.q : c);

/**
 * Fast path for the commonest cell, a plain decimal like 149.97 or -3: returns the number, or
 * undefined to let parseCell() decide (anything else, including codes with a leading zero like 007).
 */
export function plainNumber(s) {
  const n = s.length;
  if (n === 0 || n > 15) return undefined;
  let i = 0, c = s.charCodeAt(0);
  if (c === 45) { if (n === 1) return undefined; i = 1; c = s.charCodeAt(1); } // '-'
  if (c < 48 || c > 57) return undefined;
  if (c === 48 && i + 1 < n && s.charCodeAt(i + 1) !== 46) return undefined; // 0 then not '.'
  let dot = false;
  for (i++; i < n; i++) {
    c = s.charCodeAt(i);
    if (c === 46) { if (dot) return undefined; dot = true; } else if (c < 48 || c > 57) return undefined;
  }
  return Number(s);
}
export const isBlankRaw = (r) => r.every((c) => unq(c).trim() === '');

/**
 * Streams a CSV/TSV file into a ColumnTable. Same results and messages as parseDelimitedText().
 * `inspectStart(text)` sees the start of the file first (used to recognise JSON content).
 */
export async function readDelimitedFile(path, { inspectStart, chunkSize = CHUNK } = {}) {
  const decoder = new TextDecoder('utf-8');
  const stream = createReadStream(path, { highWaterMark: chunkSize });
  const it = stream[Symbol.asyncIterator]();

  // The delimiter is chosen from the first 20 non-blank lines, as in the app.
  let prefix = '', done = false;
  const enoughLines = () => prefix.split(/\r?\n/).filter((l) => l.trim()).length > 20;
  while (!done && !enoughLines() && prefix.length < 64 * CHUNK) {
    const r = await it.next();
    if (r.done) { done = true; prefix += decoder.decode(); } else prefix += decoder.decode(r.value, { stream: true });
  }
  try {
    if (inspectStart) inspectStart(prefix);
    if (done && !prefix.trim()) throw new Error('There is no data to read.');
    const delimiter = detectDelimiter(prefix);
    const decimalComma = delimiter === ';';
    const warnings = decimalComma ? ['Semicolon-separated file: commas inside numbers were read as decimal points (1,5 = 1.5).'] : [];

    let headers = null, headerRaw = null, builders = null, rowCount = 0, ragged = 0, rawAfterHeader = 0, sawAny = false;
    const leadingBlank = [];
    // parseCell results repeat a lot in text columns: cache them per column while that pays off.
    let caches = [];

    const convert = (c, col) => {
      const quotedCell = typeof c === 'object';
      const raw = quotedCell ? c.q : c;
      if (quotedCell && raw === '') return null;
      const fast = plainNumber(raw);
      if (fast !== undefined) return fast;
      const cache = caches[col];
      if (cache && raw.length < 64) {
        const key = quotedCell ? '\u0000' + raw : raw;
        const hit = cache.map.get(key);
        if (hit !== undefined) { cache.hits++; return hit; }
        const v = parseCell(raw, { decimalComma });
        cache.misses++;
        if (cache.map.size < 20000) cache.map.set(key.length >= 13 ? own(key) : key, v);
        if (cache.misses === 5000 && cache.hits < cache.misses) caches[col] = null; // mostly unique values
        return v;
      }
      return parseCell(raw, { decimalComma });
    };

    const startHeader = (raw) => {
      headerRaw = raw.map(unq);
      const cleaned = cleanHeaders(headerRaw);
      headers = cleaned.headers;
      if (cleaned.renamed) warnings.push(`${cleaned.renamed} blank or duplicate column name${cleaned.renamed > 1 ? 's were' : ' was'} renamed (for example "${headers.find((h, i) => h !== String(headerRaw[i] ?? '').trim()) || headers[0]}").`);
      builders = headers.map(() => new ColumnBuilder());
      caches = headers.map(() => ({ map: new Map(), hits: 0, misses: 0 }));
    };

    const addRow = (raw) => {
      rawAfterHeader++;
      const h = headers.length;
      const vals = new Array(Math.max(raw.length, h));
      let any = false;
      for (let i = 0; i < raw.length; i++) { const v = convert(raw[i], i < h ? i : -1); vals[i] = v; if (v !== null) any = true; }
      if (!any) return; // blank row
      if (raw.length > h) { for (let i = h; i < raw.length; i++) if (vals[i] !== null) { ragged++; break; } }
      for (let i = 0; i < h; i++) builders[i].push(i < raw.length ? vals[i] : null);
      rowCount++;
    };

    const onRow = (raw) => {
      sawAny = true;
      if (headers) { addRow(raw); return; }
      if (isBlankRaw(raw)) { leadingBlank.push(raw); return; }
      startHeader(raw);
      leadingBlank.length = 0;
    };

    const tok = new Tokenizer(delimiter, onRow);
    tok.feed(prefix);
    prefix = '';
    while (!done) {
      const r = await it.next();
      if (r.done) { done = true; const tail = decoder.decode(); if (tail) tok.feed(tail); } else tok.feed(decoder.decode(r.value, { stream: true }));
    }
    tok.end();

    if (!headers) {
      // Every row is blank: the app then treats the first row as the header.
      if (!sawAny || leadingBlank.length < 2) throw new Error('Need a header row and at least one data row.');
      startHeader(leadingBlank[0]);
      for (const r of leadingBlank.slice(1)) addRow(r);
    }
    if (rawAfterHeader < 1) throw new Error('Need a header row and at least one data row.');
    if (ragged) warnings.push(`${ragged} row${ragged > 1 ? 's have' : ' has'} more values than there are column names; the extra values were ignored.`);
    if (rowCount === 0) throw new Error('The data has a header row but no data rows.');
    return new ColumnTable(headers, builders.map((b) => b.finish()), rowCount, warnings);
  } finally {
    stream.destroy();
  }
}
