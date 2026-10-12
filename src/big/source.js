// Opening a large data file for streaming: the header, where the data starts, and how to split it.
import { open, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { cleanHeaders, detectDelimiter } from '../engine/dataImport.js';
import { parquetMetadataAsync, parquetSchema } from 'hyparquet';
import { Tokenizer, isBlankRaw, unq } from '../table.js';

const MB = 1024 * 1024;

/** AsyncBuffer over a local file, for hyparquet (reads only the byte ranges it asks for). */
export async function fileBuffer(path) {
  const fh = await open(path, 'r');
  const { size } = await fh.stat();
  return {
    byteLength: size,
    async slice(start, end = size) {
      const len = Math.max(0, end - start);
      const buf = Buffer.allocUnsafe(len);
      let off = 0;
      while (off < len) { const { bytesRead } = await fh.read(buf, off, len - off, start + off); if (!bytesRead) break; off += bytesRead; }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + off);
    },
    close: () => fh.close(),
  };
}

export const isParquet = (path) => ['.parquet', '.pq'].includes(extname(path).toLowerCase());

/**
 * Describes a delimited file: headers, delimiter, the byte offset of the first data row.
 * Applies the app's rules (delimiter from the first 20 non-blank lines, leading blank rows skipped,
 * header names cleaned).
 */
export async function describeCsv(path, { inspectStart } = {}) {
  const { size, mtimeMs } = await stat(path);
  const fh = await open(path, 'r');
  try {
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    let prefix = '', read = 0;
    const buf = Buffer.allocUnsafe(MB);
    const enough = () => prefix.split(/\r?\n/).filter((l) => l.trim()).length > 20;
    while (read < size && !enough() && prefix.length < 64 * MB) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, read);
      if (!bytesRead) break;
      read += bytesRead;
      prefix += decoder.decode(buf.subarray(0, bytesRead), { stream: read < size });
    }
    if (inspectStart) inspectStart(prefix.replace(/^﻿/, ''));
    if (read >= size && !prefix.trim()) throw new Error('There is no data to read.');
    const delimiter = detectDelimiter(prefix);
    let header = null, headerEnd = 0;
    const tok = new Tokenizer(delimiter, (row) => {
      if (header) return;
      if (isBlankRaw(row)) return;
      header = row.map(unq);
      headerEnd = tok.rowEndChar;
    });
    tok.feed(prefix, read >= size);
    if (!header && read >= size) { tok.end(); }
    if (!header) throw new Error('Need a header row and at least one data row.');
    const { headers, renamed } = cleanHeaders(header);
    const warnings = [];
    if (delimiter === ';') warnings.push('Semicolon-separated file: commas inside numbers were read as decimal points (1,5 = 1.5).');
    if (renamed) warnings.push(`${renamed} blank or duplicate column name${renamed > 1 ? 's were' : ' was'} renamed (for example "${headers.find((h, i) => h !== String(header[i] ?? '').trim()) || headers[0]}").`);
    const dataStart = Buffer.byteLength(prefix.slice(0, headerEnd), 'utf8');
    return { kind: 'csv', path, size, mtimeMs, delimiter, headers, rawHeaders: header, dataStart, warnings };
  } finally {
    await fh.close();
  }
}

/** Byte offset just after the first newline at or after `pos` (or the file size). */
export async function nextLineStart(fh, pos, size) {
  const buf = Buffer.allocUnsafe(1 << 16);
  while (pos < size) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
    if (!bytesRead) break;
    const i = buf.subarray(0, bytesRead).indexOf(10);
    if (i >= 0) return pos + i + 1;
    pos += bytesRead;
  }
  return size;
}

/** Chunk size depends only on the file size, so chunk boundaries (and cached columns) are stable. */
export const chunkBytes = (size) => {
  const testKB = Number(process.env.STATS_EXPLORER_CHUNK_KB); // tests only: force many small pieces
  if (testKB > 0) return testKB * 1024;
  return Math.max(4 * MB, Math.min(64 * MB, Math.ceil(size / 64)));
};

/** Describes a Parquet file from its footer: headers, row groups, row count. */
export async function describeParquet(path) {
  const { size, mtimeMs } = await stat(path);
  const file = await fileBuffer(path);
  try {
    const metadata = await parquetMetadataAsync(file);
    const top = parquetSchema(metadata).children.map((c) => c.element.name);
    const keys = top.filter((k) => !/^__index_level_\d+__$/.test(k));
    const { headers } = cleanHeaders(keys);
    const groups = [];
    let start = 0;
    for (const rg of metadata.row_groups) { const n = Number(rg.num_rows); groups.push({ rowStart: start, rowEnd: start + n }); start += n; }
    return { kind: 'parquet', path, size, mtimeMs, headers, sourceNames: keys, rowGroups: groups, rows: start, warnings: [] };
  } finally {
    await file.close();
  }
}
