import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTable, setAllowedRoots, maxFileBytes, DEFAULT_MAX_FILE_MB } from '../src/data.js';

test('file size limit has no default cap (large files are streamed) and follows STATS_EXPLORER_MAX_FILE_MB', () => {
  assert.equal(maxFileBytes({}), DEFAULT_MAX_FILE_MB * 1024 * 1024);
  assert.equal(maxFileBytes({ STATS_EXPLORER_MAX_FILE_MB: '1000' }), 1000 * 1024 * 1024);
  assert.equal(maxFileBytes({ STATS_EXPLORER_MAX_FILE_MB: 'abc' }), DEFAULT_MAX_FILE_MB * 1024 * 1024);
  assert.equal(maxFileBytes({ STATS_EXPLORER_MAX_FILE_MB: '-5' }), DEFAULT_MAX_FILE_MB * 1024 * 1024);
});

test('a file over the limit is refused with the setting to change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-lim-'));
  const old = process.env.STATS_EXPLORER_MAX_FILE_MB;
  try {
    writeFileSync(join(dir, 'big.csv'), 'a,b\n' + '1,2\n'.repeat(400000)); // about 1.6 MB
    setAllowedRoots([dir]);
    process.env.STATS_EXPLORER_MAX_FILE_MB = '1';
    await assert.rejects(loadTable(join(dir, 'big.csv')), /larger than the current 1 MB limit.*STATS_EXPLORER_MAX_FILE_MB/);
    process.env.STATS_EXPLORER_MAX_FILE_MB = '5';
    const t = await loadTable(join(dir, 'big.csv'));
    assert.equal(t.rows.length, 400000);
  } finally {
    if (old === undefined) delete process.env.STATS_EXPLORER_MAX_FILE_MB; else process.env.STATS_EXPLORER_MAX_FILE_MB = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
