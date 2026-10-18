// Loads extension.js against a stub of the VS Code API, checks the MCP server it registers,
// then launches that server exactly as VS Code would and runs a tool through it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const extDir = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-ws-'));
fs.writeFileSync(path.join(dataDir, 'scores.csv'), 'group,score\nA,1\nA,2\nA,3\nB,4\nB,5\nB,7\n');

const registered = {}, commands = {};
let config = { dataFolders: [], showAppLink: true, guidedWorkflow: true, confirmSelections: true };
const listeners = { folders: [], config: [] };
class EventEmitter { constructor() { this.fired = 0; this.event = () => {}; } fire() { this.fired++; } dispose() {} }
class McpStdioServerDefinition {
  constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); }
}
const vscodeStub = {
  EventEmitter, McpStdioServerDefinition,
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file' }), parse: (u) => ({ toString: () => u }) },
  lm: { registerMcpServerDefinitionProvider: (id, provider) => { registered[id] = provider; return { dispose() {} }; } },
  workspace: {
    workspaceFolders: [{ uri: { scheme: 'file', fsPath: dataDir } }],
    getConfiguration: () => ({ get: (k, d) => (k in config ? config[k] : d) }),
    onDidChangeWorkspaceFolders: (fn) => { listeners.folders.push(fn); return { dispose() {} }; },
    onDidChangeConfiguration: (fn) => { listeners.config.push(fn); return { dispose() {} }; },
  },
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; } },
  window: {
    showInformationMessage: (m) => { vscodeStub.window.lastInfo = m; },
    showWarningMessage: (m) => { vscodeStub.window.lastWarning = m; },
    showInputBox: async () => vscodeStub.window.nextInput,
    showQuickPick: async (items) => items.filter((i) => i.picked),
  },
  env: { clipboard: { writeText: async (t) => { vscodeStub.env.clipboard.last = t; } }, openExternal: () => {} },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscodeStub : origLoad.call(this, request, ...rest); };

const pkg = require(path.join(extDir, 'package.json'));
const ext = require(path.join(extDir, 'extension.js'));
const secretStore = new Map();
const context = {
  secrets: { get: async (k) => secretStore.get(k), store: async (k, v) => { secretStore.set(k, v); }, delete: async (k) => { secretStore.delete(k); }, onDidChange: () => ({ dispose() {} }) },
  subscriptions: [],
  asAbsolutePath: (p) => path.join(extDir, p),
  extension: { packageJSON: pkg },
};

test('package.json contributes the provider id the code registers', () => {
  ext.activate(context);
  const ids = pkg.contributes.mcpServerDefinitionProviders.map((p) => p.id);
  assert.deepEqual(Object.keys(registered), ids);
  assert.ok(commands['statsExplorer.copyMcpConfig'] && commands['statsExplorer.openApp']);
});

test('server definition: bundled server, VS Code runtime, workspace roots', async () => {
  const [def] = await registered['statsExplorer.mcp'].provideMcpServerDefinitions();
  assert.equal(def.command, process.execPath);
  assert.equal(def.args[0], path.join(extDir, 'dist', 'server.mjs'));
  assert.ok(fs.existsSync(def.args[0]), 'dist/server.mjs must be built');
  assert.equal(def.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(def.env.STATS_EXPLORER_ROOTS, dataDir);
  assert.equal(def.env.STATS_EXPLORER_GUIDED, 'on', 'guided workflow is the default');
  assert.equal(def.env.STATS_EXPLORER_CONFIRM_SELECTIONS, 'on', 'confirmations are the default');
  assert.equal(def.version, pkg.version);
  config = { dataFolders: ['/extra'], showAppLink: false, guidedWorkflow: false, confirmSelections: false };
  const [def2] = await registered['statsExplorer.mcp'].provideMcpServerDefinitions();
  assert.equal(def2.env.STATS_EXPLORER_ROOTS, [dataDir, '/extra'].join(path.delimiter));
  assert.equal(def2.env.STATS_EXPLORER_HIDE_LINK, '1');
  assert.equal(def2.env.STATS_EXPLORER_GUIDED, 'off');
  assert.equal(def2.env.STATS_EXPLORER_CONFIRM_SELECTIONS, 'off');
  config = { dataFolders: [], showAppLink: true, guidedWorkflow: true, confirmSelections: true };
});

test('copy-config command writes valid JSON', async () => {
  await commands['statsExplorer.copyMcpConfig']();
  assert.equal(JSON.parse(vscodeStub.env.clipboard.last).mcpServers['stats-explorer'].command, 'npx');
});

test('the registered server starts and answers a tool call on a workspace file', async () => {
  const [def] = await registered['statsExplorer.mcp'].provideMcpServerDefinitions();
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'ext-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: def.command, args: def.args, env: { ...process.env, ...def.env }, cwd: def.cwd?.fsPath, stderr: 'ignore' }));
  try {
  const info = client.getServerVersion();
  assert.equal(info.version, require('../../package.json').version);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'start_analysis') && !tools.some((t) => t.name === 't_test'), 'guided tools by default');
  await client.callTool({ name: 'start_analysis', arguments: { question: 'Do groups A and B differ in score?', mode: 'hypothesis_test' } });
  const args = { test: 't_test', test_arguments: { type: 'independent', file: 'scores.csv', column: 'score', group_column: 'group', equal_variances: true } };
  const ask = await client.callTool({ name: 'state_hypotheses', arguments: args });
  assert.equal(ask.structuredContent.status, 'needs_confirmation', 'columns are confirmed with the user first');
  await client.callTool({ name: 'state_hypotheses', arguments: { ...args, confirmation_token: ask.structuredContent.confirmation_token } });
  await client.callTool({ name: 'check_assumptions', arguments: {} });
  await client.callTool({ name: 'check_spread', arguments: {} });
  await client.callTool({ name: 'skip_step', arguments: { step: 4, reason: 'Toy example with three values per group.' } });
  const r = await client.callTool({ name: 'run_test', arguments: {} });
  assert.ok(!r.isError, r.content[0].text);
  // SciPy: ttest_ind([1,2,3],[4,5,7]) -> t = -3.1622776601683795, p = 0.03410942316740962
  assert.ok(Math.abs(r.structuredContent.statistic.value - -3.1622776601683795) < 1e-9);
  assert.ok(Math.abs(r.structuredContent.p_value - 0.03410942316740962) < 1e-9);
  assert.match(r.content[0].text, /Explore this visually/);
  } finally {
    await client.close();
  }
});

test('Jev settings: modes map to server settings; the API key comes only from secret storage', async () => {
  const provider = registered['statsExplorer.mcp'];
  const [off] = await provider.provideMcpServerDefinitions();
  assert.equal(off.env.STATS_EXPLORER_JEV, undefined, 'off by default');
  config = { 'jev.mode': 'cooperate', 'jev.checkpoints': ['plan', 'conclusions', 'data'], 'jev.waitForJev': false };
  const [coop] = await provider.provideMcpServerDefinitions();
  assert.equal(coop.env.STATS_EXPLORER_JEV, 'cooperate');
  assert.equal(coop.env.STATS_EXPLORER_JEV_CHECKPOINTS, 'plan,conclusions,data');
  assert.equal(coop.env.STATS_EXPLORER_JEV_REQUIRE, 'off');
  assert.equal(coop.env.TYPESAFE_API_KEY, undefined);

  config = { 'jev.mode': 'enforce' };
  vscodeStub.window.nextInput = '  ts-secret-key  ';
  await commands['statsExplorer.setTypeSafeKey']();
  const [listed] = await provider.provideMcpServerDefinitions();
  assert.equal(listed.env.TYPESAFE_API_KEY, undefined, 'not in the listed definition');
  const resolved = await provider.resolveMcpServerDefinition(listed);
  assert.equal(resolved.env.TYPESAFE_API_KEY, 'ts-secret-key');
  assert.equal(resolved.env.STATS_EXPLORER_JEV, 'enforce');
  vscodeStub.window.nextInput = '';
  await commands['statsExplorer.setTypeSafeKey']();
  const noKey = await provider.resolveMcpServerDefinition(listed);
  assert.equal(noKey.env.TYPESAFE_API_KEY, undefined);
  assert.match(vscodeStub.window.lastWarning, /no TypeSafe API key/);

  await commands['statsExplorer.copyClaudeJevCommands']();
  assert.match(vscodeStub.env.clipboard.last, /STATS_EXPLORER_JEV=enforce/);
  assert.match(vscodeStub.env.clipboard.last, /init-jev/);
  config = { dataFolders: [], showAppLink: true, guidedWorkflow: true, confirmSelections: true };
});

test('Add Jev Routing Instructions writes CLAUDE.md and Copilot instructions once', async () => {
  fs.writeFileSync(path.join(dataDir, 'CLAUDE.md'), '# Notes\n');
  await commands['statsExplorer.addJevRouting']();
  await commands['statsExplorer.addJevRouting']();
  const claude = fs.readFileSync(path.join(dataDir, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^# Notes/);
  assert.equal(claude.split('stats-explorer:jev BEGIN').length, 2, 'one section after running twice');
  assert.match(fs.readFileSync(path.join(dataDir, '.github', 'copilot-instructions.md'), 'utf8'), /JEV CHECK NEEDED/);
});

test('the bundled server runs Jev cooperate mode', async () => {
  config = { 'jev.mode': 'cooperate' };
  const [def] = await registered['statsExplorer.mcp'].provideMcpServerDefinitions();
  config = { dataFolders: [], showAppLink: true, guidedWorkflow: true, confirmSelections: true };
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'ext-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: def.command, args: def.args, env: { ...process.env, ...def.env, STATS_EXPLORER_CONFIRM_SELECTIONS: 'off' }, cwd: def.cwd?.fsPath, stderr: 'ignore' }));
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.some((t) => t.name === 'check_conclusions') && tools.some((t) => t.name === 'record_verification'));
    await client.callTool({ name: 'start_analysis', arguments: { question: 'Do groups A and B differ in score?', mode: 'hypothesis_test' } });
    const st = await client.callTool({ name: 'state_hypotheses', arguments: { test: 't_test', test_arguments: { type: 'independent', file: 'scores.csv', column: 'score', group_column: 'group' } } });
    assert.equal(st.structuredContent.status, 'needs_verification');
  } finally {
    await client.close();
  }
});
