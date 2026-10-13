// Registers the bundled Stats Explorer MCP server with VS Code, so agent mode (Copilot Chat and
// other MCP-aware chat features) can call its tools with no mcp.json setup.
const vscode = require('vscode');
const path = require('path');

const PROVIDER_ID = 'statsExplorer.mcp';

function settings() {
  const cfg = vscode.workspace.getConfiguration('statsExplorer');
  return {
    extraFolders: cfg.get('dataFolders', []).filter((f) => typeof f === 'string' && f.trim()),
    showAppLink: cfg.get('showAppLink', true),
    guided: cfg.get('guidedWorkflow', true),
    confirm: cfg.get('confirmSelections', true),
    confirmIn: cfg.get('confirmIn', 'form'),
    maxFileMB: cfg.get('maxFileMB', 0),
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

function serverDefinition(context) {
  const { showAppLink, guided, confirm, confirmIn, maxFileMB, large } = settings();
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
        resolveMcpServerDefinition: async (server) => server,
      }),
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
    vscode.commands.registerCommand('statsExplorer.openApp', () => {
      vscode.env.openExternal(vscode.Uri.parse(context.extension.packageJSON.statsExplorer.appUrl));
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate, _serverDefinition: serverDefinition };
