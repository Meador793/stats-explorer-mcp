// Runs every SciPy/statsmodels reference case through the real MCP server over stdio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connect, get } from './helpers.mjs';

const { cases } = JSON.parse(readFileSync(new URL('./reference/cases.json', import.meta.url)));
let client;
before(async () => { client = await connect({ guided: false }); });
after(async () => { await client?.close(); });

const REL_TOL = 1e-6;

for (const c of cases) {
  test(`${c.tool}: ${c.name}`, async () => {
    const res = await client.callTool({ name: c.tool, arguments: c.args });
    assert.ok(!res.isError, res.content?.[0]?.text);
    for (const [path, want] of Object.entries(c.expect)) {
      const got = get(res.structuredContent, path);
      assert.equal(typeof got, 'number', `${path} missing in result`);
      const err = Math.abs(got - want) / Math.max(Math.abs(want), 1e-300);
      // Absolute floor for values that should be ~0.
      assert.ok(err < REL_TOL || Math.abs(got - want) < 1e-12, `${path}: got ${got}, SciPy/statsmodels ${want} (rel err ${err.toExponential(2)})`);
    }
  });
}
