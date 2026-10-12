// The streaming column loader (src/table.js) must read every file exactly like the app's
// parseDelimitedText(): same headers, values, warnings and error messages, wherever the chunk
// boundaries fall (inside quotes, between \r and \n, inside a multi-byte character).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDelimitedText } from '../src/engine/dataImport.js';
import { readDelimitedFile, fromRows } from '../src/table.js';
import { FIXTURES } from './helpers.mjs';

const dir = mkdtempSync(join(tmpdir(), 'se-table-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

let fileNo = 0;
async function both(text, chunkSize) {
  const path = join(dir, `t${fileNo++}.csv`);
  writeFileSync(path, text);
  let expected, actual;
  try { const p = parseDelimitedText(text); expected = { headers: p.headers, rows: p.rows, warnings: p.warnings }; } catch (e) { expected = { error: e.message }; }
  try { const t = await readDelimitedFile(path, { chunkSize }); actual = { headers: t.headers, rows: t.rows, warnings: t.warnings }; } catch (e) { actual = { error: e.message }; }
  return { expected, actual };
}

const CASES = {
  simple: 'a,b\n1,2\n3,4\n',
  crlf: 'a,b\r\n1,2\r\n3,4\r\n',
  bareCr: 'a,b\r1,2\r3,4',
  bom: '﻿name,score\nx,1\ny,2',
  quotes: 'id,text,n\n1,"hello, world",3\n2,"she said ""hi""",4\n3,"line1\nline2",5\n',
  quotedNumbers: 'v,w\n"1,234",""\n"5",x\n',
  spaceBeforeQuote: 'a,b\n  "q,1",2\n',
  quoteInField: 'a,b\nab"c,2\n',
  leadingBlank: '\n\n,,\nh1,h2\n1,2\n\n3,4\n\n',
  missing: 'a,b,c\nNA,,n/a\n1,#N/A,3\n-,.,?\n',
  ragged: 'a,b\n1,2,3\n4\n5,6,,\n7,8,9,10\n',
  dupHeaders: 'x,x,,y\n1,2,3,4\n',
  semicolon: 'a;b\n1,5;2\n3;4,25\n',
  tabs: 'a\tb\n1\t2\n"x\ty"\t3\n',
  unicode: 'città,值,emoji\nRomà,中文,😀\nnaïve,1,🎉🎉\n',
  ids: 'zip,code,pct,money\n00123,007,45%,$1,200\n02134,0,5 %,€3\n',
  dates: 'd,t\n2026-01-05,1/20/2018\n2026-02-01,12/31/2018\n',
  allBlank: '\n,\n , \n',
  headerOnly: 'a,b\n',
  headerAndBlank: 'a,b\n,\n',
  empty: '   \n  ',
  unclosed: 'a,b\n"open,2\n',
  trailingDelim: 'a,b,\n1,2,\n',
  json: 'a,b\n{"x":1},2\n',
  numberEdges: 'a,b,c,d,e,f,g,h,i,j,k\n-0,0,0.,007,1.,0.50,-12.5,1.2.3,+5,12345678901234567,-\n.5,-.5,1e5, 7 ,0x1A,1-2,--1,00.5,9.,-0.0,1..2\n',
};

for (const [name, text] of Object.entries(CASES)) {
  test(`streaming loader matches the app: ${name}`, async () => {
    for (const chunkSize of [1, 2, 3, 5, 17, 1 << 20]) {
      const { expected, actual } = await both(text, chunkSize);
      assert.deepEqual(actual, expected, `chunk size ${chunkSize}`);
    }
  });
}

test('streaming loader matches the app on random CSV-like text', async () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const atoms = ['a', '1', '2.5', '"', '""', ',', ',', ',', '\n', '\r\n', '\r', ' ', ';', '\t', 'é', '中', '😀', 'NA', '-', '1,234', '00', '%', '$'];
  for (let k = 0; k < 300; k++) {
    let text = 'h1,h2,h3\n';
    const len = 5 + Math.floor(rnd() * 60);
    for (let i = 0; i < len; i++) text += atoms[Math.floor(rnd() * atoms.length)];
    const chunkSize = 1 + Math.floor(rnd() * 9);
    const { expected, actual } = await both(text, chunkSize);
    assert.deepEqual(actual, expected, `case ${k}: ${JSON.stringify(text)} (chunk ${chunkSize})`);
  }
});

test('the trial.csv fixture loads identically', async () => {
  const text = readFileSync(join(FIXTURES, 'trial.csv'), 'utf8');
  const p = parseDelimitedText(text);
  for (const chunkSize of [7, 1 << 20]) {
    const t = await readDelimitedFile(join(FIXTURES, 'trial.csv'), { chunkSize });
    assert.deepEqual(t.headers, p.headers);
    assert.deepEqual(t.rows, p.rows);
    assert.deepEqual(t.warnings, p.warnings);
  }
});

test('column storage: numeric columns are packed, text columns dictionary-encoded', async () => {
  const t = fromRows({ headers: ['n', 'g', 'mixed'], rows: [{ n: 1, g: 'A', mixed: 1 }, { n: null, g: 'B', mixed: 'x' }, { n: 3, g: 'A', mixed: null }] });
  assert.equal(t.col('n').kind, 'num');
  assert.equal(t.col('g').kind, 'dict');
  assert.deepEqual(t.col('g').dict, [null, 'A', 'B']);
  assert.deepEqual(t.column('n'), [1, null, 3]);
  assert.deepEqual(t.column('mixed'), [1, 'x', null]);
  assert.deepEqual(t.rowsOf(['g']), [{ g: 'A' }, { g: 'B' }, { g: 'A' }]);
  assert.equal(t.rowCount, 3);
});
