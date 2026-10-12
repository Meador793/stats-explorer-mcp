// Synced from the Stats Explorer app (src/lib) by scripts/sync-engine.mjs. Do not edit here;
// change the app and re-run the sync so both stay identical.
// Turning files and pasted text into a dataset { headers, rows, warnings }.
// Shared by CSV, pasted data, Google Sheets, Excel and Parquet, so every source follows the same rules:
//   • missing cells (blank, NA, N/A, null, #N/A, ...) become null and are skipped by the statistics;
//   • numbers are parsed strictly ("12 kg" and "2026-01-05" stay text, unlike parseFloat);
//   • dates become YYYY-MM-DD text, never time-zone-shifted or Excel serial numbers;
//   • duplicate or blank column names are renamed instead of silently overwriting each other.
// No React here, so it can be tested directly (npm test).

import * as XLSX from 'xlsx';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const MISSING = new Set([
    '', 'na', 'n/a', '#n/a', '#na', 'nan', 'null', 'none', 'nil', '.', '-', '?',
    '#value!', '#div/0!', '#ref!', '#num!', '#name?', '#null!', '#error!',
]);

/** True for values the statistics should skip. */
export const isMissingValue = (v) => v === null || v === undefined
    || (typeof v === 'number' && !Number.isFinite(v))
    || (typeof v === 'string' && MISSING.has(v.trim().toLowerCase()));

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const THOUSANDS = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;      // 1,234 or 1,234.56
const DECIMAL_COMMA = /^[+-]?\d+,\d+$/;                   // 1,5 (only in ;-separated files)
const LEADING_ZERO_CODE = /^[+-]?0\d/;                     // 00123, 007: IDs and ZIP codes, keep as text

/**
 * Converts one text cell to number, text or null (missing).
 * Accepts plain numbers, thousands separators, a leading currency symbol and a trailing %
 * ("45%" → 45). Rejects anything else (hex, dates, units, "Infinity").
 */
export function parseCell(raw, { decimalComma = false } = {}) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (isMissingValue(s)) return null;
    let t = s.replace(/^[$€£¥]\s?/, '').replace(/^([+-])[$€£¥]\s?/, '$1').replace(/\s?%$/, '');
    if (decimalComma && DECIMAL_COMMA.test(t)) t = t.replace(',', '.');
    else if (!decimalComma && THOUSANDS.test(t)) t = t.replace(/,/g, '');
    if (PLAIN_NUMBER.test(t) && !LEADING_ZERO_CODE.test(t)) {
        const n = Number(t);
        if (Number.isFinite(n)) return n;
    }
    return s;
}

/** Makes column names unique and non-blank. Returns { headers, renamed }. */
export function cleanHeaders(raw) {
    const seen = new Map();
    let renamed = 0;
    const headers = raw.map((h, i) => {
        let name = String(h ?? '').replace(/^\uFEFF/, '').trim();
        if (!name) { name = `Column ${i + 1}`; renamed++; }
        const base = name;
        let k = seen.get(base) || 0;
        while (seen.has(name)) { k++; name = `${base} (${k + 1})`; }
        if (name !== base) renamed++;
        seen.set(base, k);
        seen.set(name, 0);
        return name;
    });
    return { headers, renamed };
}

/** Builds a dataset from a header row plus value rows (values already converted). */
function buildDataset(headerRow, valueRows, warnings) {
    const { headers, renamed } = cleanHeaders(headerRow);
    if (renamed) warnings.push(`${renamed} blank or duplicate column name${renamed > 1 ? 's were' : ' was'} renamed (for example "${headers.find((h, i) => h !== String(headerRow[i] ?? '').trim()) || headers[0]}").`);
    let ragged = 0;
    const rows = [];
    for (const r of valueRows) {
        if (r.every((v) => v === null)) continue; // blank row
        if (r.length > headers.length && r.slice(headers.length).some((v) => v !== null)) ragged++;
        const obj = {};
        headers.forEach((h, i) => { obj[h] = r[i] === undefined ? null : r[i]; });
        rows.push(obj);
    }
    if (ragged) warnings.push(`${ragged} row${ragged > 1 ? 's have' : ' has'} more values than there are column names; the extra values were ignored.`);
    if (rows.length === 0) throw new Error('The data has a header row but no data rows.');
    return { headers, rows, warnings };
}

// ------------------------------------------------------------------ delimited text (CSV, TSV, pasted)

/** RFC 4180 tokenizer: quoted fields, "" escapes, delimiters and newlines inside quotes. */
export function splitDelimited(text, delimiter) {
    const out = [];
    let row = [], field = '', quoted = false, wasQuoted = false;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const endField = () => { row.push(wasQuoted ? { q: field } : field); field = ''; wasQuoted = false; };
    for (; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
            else field += ch;
        } else if (ch === '"' && field.trim() === '') { quoted = true; wasQuoted = true; field = ''; }
        else if (ch === delimiter) endField();
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            endField(); out.push(row); row = [];
        } else field += ch;
    }
    if (quoted) throw new Error('A quoted value is never closed (unmatched " character).');
    if (field !== '' || wasQuoted || row.length) { endField(); out.push(row); }
    return out;
}

/** Picks the delimiter that splits the first lines most consistently (quote-aware). */
export function detectDelimiter(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
    let best = ',', bestScore = -1;
    for (const d of ['\t', ';', ',', '|']) {
        const counts = lines.map((l) => { let n = 0, q = false; for (const ch of l) { if (ch === '"') q = !q; else if (!q && ch === d) n++; } return n; });
        if (!counts.length || counts[0] === 0) continue;
        const consistent = counts.filter((c) => c === counts[0]).length / counts.length;
        const score = consistent * 1000 + counts[0];
        if (score > bestScore) { best = d; bestScore = score; }
    }
    return best;
}

/** Parses CSV/TSV/semicolon/pipe-separated text. Throws an Error with a user-facing message. */
export function parseDelimitedText(text) {
    if (!text || !text.trim()) throw new Error('There is no data to read.');
    const delimiter = detectDelimiter(text);
    const decimalComma = delimiter === ';';
    const all = splitDelimited(text, delimiter);
    const blank = (r) => r.every((c) => (typeof c === 'object' ? c.q : c).trim() === '');
    const raw = all.slice(Math.max(0, all.findIndex((r) => !blank(r))));
    if (raw.length < 2) throw new Error('Need a header row and at least one data row.');
    const unq = (c) => (typeof c === 'object' ? c.q : c);
    const header = raw[0].map(unq);
    // A quoted cell is still converted ("1,234" from Excel exports is a number), except an empty one.
    const rows = raw.slice(1).map((r) => r.map((c) => (typeof c === 'object' ? (c.q === '' ? null : parseCell(c.q, { decimalComma })) : parseCell(c, { decimalComma }))));
    const warnings = [];
    if (decimalComma) warnings.push('Semicolon-separated file: commas inside numbers were read as decimal points (1,5 = 1.5).');
    return buildDataset(header, rows, warnings);
}

// ------------------------------------------------------------------ Excel

const pad = (n) => String(n).padStart(2, '0');

/** Excel serial date → "YYYY-MM-DD" (plus " HH:MM" / ":SS" when there is a time). Time-zone independent. */
export function excelSerialToText(serial, date1904 = false) {
    let days = Math.floor(serial);
    let secs = Math.round((serial - days) * 86400);
    if (secs >= 86400) { days += 1; secs -= 86400; }
    if (!date1904 && days < 60) days += 1; // Excel's fictional 29 Feb 1900
    const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const d = new Date(base + days * 86400000);
    const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    if (!secs) return date;
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return `${date} ${pad(h)}:${pad(m)}${s ? `:${pad(s)}` : ''}`;
}

/** True when an Excel number format displays a date or time (e.g. "yyyy-mm-dd", "m/d/yy h:mm"). */
export function isDateFormat(fmt) {
    if (!fmt || /^general$/i.test(fmt)) return false;
    if (/\[(h+|m+|s+)\]/i.test(fmt)) return false; // elapsed-time durations like [h]:mm are amounts, not dates
    const stripped = String(fmt).split(';')[0].replace(/"[^"]*"/g, '').replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, '').replace(/\\./g, '');
    return /[dmyhs]/i.test(stripped) && !/^[#0.,%\s]*$/.test(stripped);
}

function decodeCell(ref) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) return null;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    return { r: Number(m[2]) - 1, c: c - 1 };
}

function sheetToGrid(ws, date1904) {
    const cells = [];
    let maxR = -1, maxC = -1;
    for (const ref of Object.keys(ws)) {
        if (ref[0] === '!') continue;
        const pos = decodeCell(ref);
        const cell = ws[ref];
        if (!pos || !cell) continue;
        let v;
        if (cell.t === 'n') v = isDateFormat(cell.z) ? excelSerialToText(cell.v, date1904) : (Number.isFinite(cell.v) ? cell.v : null);
        else if (cell.t === 'd') v = cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : String(cell.v);
        else if (cell.t === 'b') v = cell.v ? 'TRUE' : 'FALSE';
        else if (cell.t === 'e') v = null;
        else if (cell.t === 's' || cell.t === 'str') v = parseCell(cell.v);
        else v = null;
        if (v === null) continue;
        cells.push([pos.r, pos.c, v]);
        if (pos.r > maxR) maxR = pos.r;
        if (pos.c > maxC) maxC = pos.c;
    }
    if (maxR < 0) return [];
    const grid = Array.from({ length: maxR + 1 }, () => new Array(maxC + 1).fill(null));
    for (const [r, c, v] of cells) grid[r][c] = v;
    return grid;
}

/** Reads the first sheet that has data. Returns { headers, rows, warnings, sheetName }. */
export function readExcel(arrayBuffer) {
    const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', cellNF: true, cellDates: false, dense: false });
    const date1904 = !!wb.Workbook?.WBProps?.date1904;
    for (const name of wb.SheetNames) {
        const grid = sheetToGrid(wb.Sheets[name], date1904);
        // Skip leading blank rows so the first non-blank row is the header.
        const start = grid.findIndex((r) => r.some((v) => v !== null));
        if (start < 0) continue;
        const header = grid[start].map((v) => (v === null ? '' : String(v)));
        const warnings = [];
        if (wb.SheetNames.length > 1) warnings.push(`Read sheet "${name}" (the workbook has ${wb.SheetNames.length} sheets; only one is loaded).`);
        return { ...buildDataset(header, grid.slice(start + 1), warnings), sheetName: name };
    }
    throw new Error('The workbook has no data.');
}

// ------------------------------------------------------------------ Parquet

/** Converts one Parquet value (typed by the file) to number, text or null. */
export function parquetValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'bigint') return (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)) ? Number(v) : v.toString();
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return v.trim() === '' ? null : v;
    if (v instanceof Date) {
        if (isNaN(v.getTime())) return null;
        const iso = v.toISOString(); // Parquet dates/timestamps are UTC (or zone-less); show them as stored
        return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/(:00)?\.000Z$/, '').replace(/Z$/, '');
    }
    if (v instanceof Uint8Array) return `(binary, ${v.length} bytes)`;
    try {
        return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? (typeof parquetValue(x) === 'number' ? Number(x) : x.toString()) : x));
    } catch {
        return String(v);
    }
}

/** Reads a Parquet file (all common compression codecs). Returns { headers, rows, warnings }. */
export async function readParquet(arrayBuffer) {
    const records = await parquetReadObjects({ file: arrayBuffer, compressors });
    if (records.length === 0) throw new Error('The Parquet file has no rows.');
    // pandas writes its row index as "__index_level_0__"; it is not data.
    const keys = Object.keys(records[0]).filter((k) => !/^__index_level_\d+__$/.test(k));
    const rows = records.map((r) => keys.map((k) => parquetValue(r[k])));
    return buildDataset(keys, rows, []);
}

// ------------------------------------------------------------------ dispatch

export const SUPPORTED_EXTENSIONS = ['csv', 'tsv', 'txt', 'xlsx', 'xlsm', 'xls', 'parquet', 'pq'];

/** Reads a File (from an <input type=file>) into a dataset. */
export async function readDataFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (['csv', 'tsv', 'txt'].includes(ext)) return parseDelimitedText(await file.text());
    if (['xlsx', 'xlsm', 'xls'].includes(ext)) return readExcel(await file.arrayBuffer());
    if (['parquet', 'pq'].includes(ext)) return readParquet(await file.arrayBuffer());
    throw new Error('Unsupported file type. Use CSV, TSV, Excel (.xlsx/.xls) or Parquet (.parquet).');
}
