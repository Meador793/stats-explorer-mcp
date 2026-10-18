// Registers the bundled Stats Explorer MCP server with VS Code, so agent mode (Copilot Chat and
// other MCP-aware chat features) can call its tools with no mcp.json setup.
const vscode = require('vscode');
const path = require('path');

const PROVIDER_ID = 'statsExplorer.mcp';
const KEY_SECRET = 'statsExplorer.typesafeApiKey';

function settings() {
  const cfg = vscode.workspace.getConfiguration('statsExplorer');
  return {
    extraFolders: cfg.get('dataFolders', []).filter((f) => typeof f === 'string' && f.trim()),
    showAppLink: cfg.get('showAppLink', true),
    guided: cfg.get('guidedWorkflow', true),
    confirm: cfg.get('confirmSelections', true),
    confirmIn: cfg.get('confirmIn', 'form'),
    maxFileMB: cfg.get('maxFileMB', 0),
    jev: {
      mode: cfg.get('jev.mode', 'off'),
      checkpoints: cfg.get('jev.checkpoints', ['plan', 'conclusions']),
      waitForJev: cfg.get('jev.waitForJev', true),
      passAt: cfg.get('jev.passAt', 0.8),
      failBelow: cfg.get('jev.failBelow', 0.5),
      auditLog: cfg.get('jev.auditLog', ''),
    },
    large: {
      streamMB: cfg.get('largeFiles.streamAboveMB', 512),
      workers: cfg.get('largeFiles.parallelReaders', 0),
      askMinutes: cfg.get('largeFiles.askAboveMinutes', 2),
      samplePercent: cfg.get('largeFiles.samplePercent', 1),
      saveColumns: cfg.get('largeFiles.saveColumns', 'ask'),
      cacheFolder: cfg.get('largeFiles.cacheFolder', ''),
    },
  };
}

/** Folders the server may read data files from: open workspace folders plus any configured extras. */
function dataFolders() {
  const ws = (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
  return [...ws, ...settings().extraFolders];
}

function serverDefinition(context, { apiKey = '' } = {}) {
  const { showAppLink, guided, confirm, confirmIn, maxFileMB, large, jev } = settings();
  const folders = dataFolders();
  const env = {
    // VS Code's own runtime runs the server, so users don't need Node.js installed.
    ELECTRON_RUN_AS_NODE: '1',
    STATS_EXPLORER_HIDE_LINK: showAppLink ? '0' : '1',
    STATS_EXPLORER_GUIDED: guided ? 'on' : 'off',
    STATS_EXPLORER_CONFIRM_SELECTIONS: confirm ? 'on' : 'off',
    STATS_EXPLORER_STREAM_MB: String(large.streamMB >= 0 ? large.streamMB : 512),
    STATS_EXPLORER_ASK_SECONDS: String(Math.max(0, large.askMinutes) * 60),
    STATS_EXPLORER_SAMPLE_PERCENT: String(large.samplePercent > 0 ? large.samplePercent : 1),
    STATS_EXPLORER_CACHE: { always: 'on', never: 'off' }[large.saveColumns] || 'ask',
  };
  if (confirmIn === 'chat') env.STATS_EXPLORER_CONFIRM_VIA = 'chat';
  if (maxFileMB > 0) env.STATS_EXPLORER_MAX_FILE_MB = String(maxFileMB);
  if (large.workers > 0) env.STATS_EXPLORER_WORKERS = String(Math.floor(large.workers));
  if (large.cacheFolder && large.cacheFolder.trim()) env.STATS_EXPLORER_CACHE_DIR = large.cacheFolder.trim();
  if (folders.length) env.STATS_EXPLORER_ROOTS = folders.join(path.delimiter);
  if (['cooperate', 'enforce'].includes(jev.mode)) {
    env.STATS_EXPLORER_JEV = jev.mode;
    env.STATS_EXPLORER_JEV_CHECKPOINTS = (Array.isArray(jev.checkpoints) && jev.checkpoints.length ? jev.checkpoints : ['plan', 'conclusions']).join(',');
    if (jev.mode === 'cooperate' && !jev.waitForJev) env.STATS_EXPLORER_JEV_REQUIRE = 'off';
    if (jev.passAt > 0 && jev.passAt <= 1) env.STATS_EXPLORER_JEV_PASS_AT = String(jev.passAt);
    if (jev.failBelow >= 0 && jev.failBelow <= 1) env.STATS_EXPLORER_JEV_FAIL_BELOW = String(jev.failBelow);
    if (jev.auditLog && jev.auditLog.trim()) env.STATS_EXPLORER_AUDIT_LOG = jev.auditLog.trim();
    // The key comes from VS Code's secret storage, never from settings.json.
    if (jev.mode === 'enforce' && apiKey) env.TYPESAFE_API_KEY = apiKey;
  }
  const def = new vscode.McpStdioServerDefinition(
    'Stats Explorer',
    process.execPath,
    [context.asAbsolutePath(path.join('dist', 'server.mjs'))],
    env,
    context.extension.packageJSON.version
  );
  if (folders.length) def.cwd = vscode.Uri.file(folders[0]);
  return def;
}

function activate(context) {
  if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
    // VS Code-based editors without the MCP API: the commands below still work.
    console.warn('Stats Explorer: this editor does not support MCP server registration.');
  } else {
    const changed = new vscode.EventEmitter();
    context.subscriptions.push(
      changed,
      vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
        onDidChangeMcpServerDefinitions: changed.event,
        provideMcpServerDefinitions: async () => [serverDefinition(context)],
        // The API key is added only when VS Code is about to start the server.
        resolveMcpServerDefinition: async (server) => {
          if (settings().jev.mode !== 'enforce') return server;
          const apiKey = (await context.secrets?.get(KEY_SECRET)) || '';
          if (!apiKey) vscode.window.showWarningMessage('Stats Explorer: Jev mode is "enforce" but no TypeSafe API key is set, so every Jev checkpoint will be blocked. Run "Stats Explorer: Set TypeSafe API Key".');
          return serverDefinition(context, { apiKey });
        },
      }),
      ...(context.secrets?.onDidChange ? [context.secrets.onDidChange((e) => { if (e.key === KEY_SECRET) changed.fire(); })] : []),
      vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('statsExplorer')) changed.fire(); })
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('statsExplorer.copyMcpConfig', async () => {
      const config = { mcpServers: { 'stats-explorer': { command: 'npx', args: ['-y', 'stats-explorer-mcp'], env: { STATS_EXPLORER_CONFIRM_VIA: 'chat' } } } };
      await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
      vscode.window.showInformationMessage('Copied MCP config for Cursor, Claude Desktop, Windsurf and other MCP clients (requires Node.js 22 or later).');
    }),
    vscode.commands.registerCommand('statsExplorer.copyClaudeCommand', async () => {
      await vscode.env.clipboard.writeText('claude mcp add -s user stats-explorer -e STATS_EXPLORER_CONFIRM_VIA=chat -- npx -y stats-explorer-mcp');
      vscode.window.showInformationMessage('Copied. Paste it into a terminal, then start a new Claude session (Developer: Reload Window). Requires Node.js 22 or later.');
    }),
    vscode.commands.registerCommand('statsExplorer.setTypeSafeKey', async () => {
      const key = await vscode.window.showInputBox({ title: 'TypeSafe API key for Jev', prompt: 'Used only when Jev mode is "enforce". Stored in VS Code\'s secret storage.', password: true, ignoreFocusOut: true });
      if (key === undefined) return;
      if (key.trim()) { await context.secrets.store(KEY_SECRET, key.trim()); vscode.window.showInformationMessage('TypeSafe API key saved in secret storage. Set "Stats Explorer › Jev: Mode" to enforce to use it.'); }
      else { await context.secrets.delete(KEY_SECRET); vscode.window.showInformationMessage('TypeSafe API key removed.'); }
    }),
    vscode.commands.registerCommand('statsExplorer.addJevRouting', async () => {
      const folder = (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === 'file');
      if (!folder) { vscode.window.showWarningMessage('Open a folder first: the instructions are written into the workspace.'); return; }
      const picks = await vscode.window.showQuickPick([
        { label: '.github/copilot-instructions.md', description: 'GitHub Copilot', target: 'copilot', picked: true },
        { label: 'CLAUDE.md', description: 'Claude Code', target: 'claude', picked: true },
        { label: 'AGENTS.md', description: 'Other agents', target: 'agents', picked: false },
      ], { canPickMany: true, title: 'Add Stats Explorer + Jev routing instructions to' });
      if (!picks || !picks.length) return;
      const { writeRouting } = require('./dist/workspace.cjs');
      const written = await writeRouting(folder.uri.fsPath, picks.map((p) => p.target));
      vscode.window.showInformationMessage(`Added the Stats Explorer + Jev section to ${written.map((p) => path.relative(folder.uri.fsPath, p)).join(' and ')}.`);
    }),
    vscode.commands.registerCommand('statsExplorer.copyClaudeJevCommands', async () => {
      const mode = settings().jev.mode === 'enforce' ? 'enforce' : 'cooperate';
      const lines = mode === 'enforce'
        ? ['claude mcp add -s user stats-explorer -e STATS_EXPLORER_JEV=enforce -e TYPESAFE_API_KEY=YOUR_TYPESAFE_KEY -e STATS_EXPLORER_CONFIRM_VIA=chat -- npx -y stats-explorer-mcp']
        : ['claude mcp add -s user jev -e TYPESAFE_API_KEY=YOUR_TYPESAFE_KEY -- npx -y @jkudish/jev-mcp',
          'claude mcp add -s user stats-explorer -e STATS_EXPLORER_JEV=cooperate -e STATS_EXPLORER_CONFIRM_VIA=chat -- npx -y stats-explorer-mcp'];
      lines.push('npx -y stats-explorer-mcp init-jev');
      await vscode.env.clipboard.writeText(lines.join('\n'));
      vscode.window.showInformationMessage(`Copied the ${mode} setup for Claude Code (${lines.length} commands). Replace YOUR_TYPESAFE_KEY, run them in a terminal in your project folder, then start a new Claude session.`);
    }),
    vscode.commands.registerCommand('statsExplorer.openApp', () => {
      vscode.env.openExternal(vscode.Uri.parse(context.extension.packageJSON.statsExplorer.appUrl));
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate, _serverDefinition: serverDefinition };
