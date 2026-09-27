import { existsSync, readFileSync, writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const VALID_PANELS = ['basic', 'models', 'integrations', 'daily', 'system', 'updates', 'repair', 'recovery'] as const;
type Panel = (typeof VALID_PANELS)[number];
const VALID_THEMES = ['dark', 'light'] as const;
type PreviewTheme = (typeof VALID_THEMES)[number];

const root = process.cwd();
const rendererHtml = join(root, 'out', 'renderer', 'index.html');

const panelArg = process.argv.find((arg) => arg.startsWith('--panel='));
const panel: Panel = panelArg
  ? (panelArg.slice('--panel='.length) as Panel)
  : 'basic';
if (!VALID_PANELS.includes(panel)) {
  throw new Error(`Invalid panel "${panel}". Valid values: ${VALID_PANELS.join(', ')}`);
}

const themeArg = process.argv.find((arg) => arg.startsWith('--theme='));
const theme: PreviewTheme = themeArg
  ? (themeArg.slice('--theme='.length) as PreviewTheme)
  : 'dark';
if (!VALID_THEMES.includes(theme)) {
  throw new Error(`Invalid theme "${theme}". Valid values: ${VALID_THEMES.join(', ')}`);
}

const outputArg = process.argv.find((arg) => arg.startsWith('--out='));
const output = outputArg
  ? outputArg.slice('--out='.length)
  : join(root, 'out', `renderer-preview-${panel}.png`);
const prepareOnly = process.argv.includes('--prepare-only');
const firstRun = process.argv.includes('--first-run');
const memorySetupHint = process.argv.includes('--memory-setup-hint');
const postgres = process.argv.includes('--postgres');
const integrationDialogArg = process.argv.find((arg) => arg.startsWith('--integration-dialog='));
const integrationDialog = integrationDialogArg?.slice('--integration-dialog='.length) ?? '';
const integrationDialogDeep = integrationDialog.endsWith(':deep');
const integrationDialogClient = integrationDialog.replace(/:deep$/, '');
const preparedHtmlArg = process.argv.find((arg) => arg.startsWith('--html='));

function chromePath(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

if (!existsSync(rendererHtml)) {
  throw new Error('Renderer build not found. Run `bun run build` once, then rerun `bun run preview:renderer`.');
}

const browser = chromePath();
if (!prepareOnly && !browser) {
  throw new Error('Chrome or Edge was not found. Set CHROME_PATH to a browser executable.');
}

// 按 --panel 参数切换到指定面板，并滚动到对应区域
// panelScrollMap 和 switchPanel 逻辑已内联到 mock 脚本中
const panelScrollTarget: Record<Panel, string> = {
  basic: '#database-path',
  models: '#chat-provider',
  integrations: '#integration-grid',
  daily: '#daily-connectors',
  system: '#shared-address',
  updates: '#update-current',
  repair: '#repair-backup-list',
  recovery: '#recovery-message',
};
const scrollTarget = panelScrollTarget[panel];

const mockApi = `
<script>
window.pmbrainDesktop = {
   onNavigate: () => () => {},
   productRequest: async ({ path }) => {
     const overview = {
       version: 'preview', engine: 'pglite', schema_pack: 'preview', chat_model: 'mimo:mimo-v2.5-pro', embedding_model: 'zhipu:embedding-3', embedding_dimensions: 1024, expansion_model: null,
       stats: { page_count: 0, chunk_count: 0, embedded_count: 0, link_count: 0, timeline_entry_count: 0, pages_by_type: {} },
       embedding_coverage: 0, pending_embeddings: 0, recent_write_at: null, sources: [], main_source_id: 'default', federated_source_count: 0,
       provider_status: { providers: { mimo: true, zhipu: true }, chat: { enabled: true, chat_model: 'mimo:mimo-v2.5-pro', provider: 'mimo', missing: [] } }, llm_enabled: true, config: {}
     };
     const body = path.startsWith('/admin/api/brain/overview') ? overview : path === '/admin/api/theme' ? { source: '${theme}' } : { error: '此预览不连接真实知识服务' };
     return { status: path.startsWith('/admin/api/brain/overview') || path === '/admin/api/theme' ? 200 : 503, contentType: 'application/json', body: JSON.stringify(body) };
   },
   getSetup: async () => ({
    setup: {
      needsSetup: ${firstRun},
      configPath: 'C:\\\\Users\\\\zhengyunhui\\\\.pmbrain\\\\config.json',
      defaults: {
        databasePath: 'C:\\\\Users\\\\zhengyunhui\\\\.pmbrain\\\\brain.pglite',
        knowledgeDirectory: 'C:\\\\Users\\\\zhengyunhui\\\\Documents\\\\PMBrain'
      },
      current: {
          engine: ${postgres ? "'postgres'" : "'pglite'"},
        theme: 'system',
         databasePath: 'D:\\\\tmp\\\\brain.pglite',
         databaseUrl: ${postgres ? "'postgresql://pmbrain:secret@127.0.0.1:55142/pmbrain'" : 'undefined'},
        databaseConfigured: true,
        knowledgeDirectory: ${firstRun ? "''" : "'C:\\\\\\\\Users\\\\\\\\zhengyunhui\\\\\\\\Documents\\\\\\\\PMBrain'"},
        knowledgeSourceId: ${firstRun ? "''" : "'PMBrain'"},
        chatModel: 'mimo:mimo-v2.5-pro',
        embeddingModel: 'zhipu:embedding-3',
        embeddingDimensions: 1024,
        keyStatus: { mimo: true, zhipu: true, deepseek: true, openai: false, anthropic: false, zeroentropy: false },
        keyValues: {
          mimo: 'mimo-sk-abcdefghijklmnopqrstuvwxyz123456',
          zhipu: 'zhipu-sk-abcdefghijklmnopqrstuvwxyz123456',
          deepseek: 'deepseek-sk-old-unused'
        }
      }
    },
    integrations: [
      { id: 'cherry', name: 'CherryStudio', path: null, configured: false, automatic: false },
      { id: 'workbuddy', name: 'Workbuddy', path: 'C:\\\\Users\\\\zhengyunhui\\\\.workbuddy\\\\mcp.json', configured: true, automatic: true, connectionState: 'connected', launchAvailable: true },
      { id: 'cursor', name: 'Cursor', path: 'C:\\\\Users\\\\zhengyunhui\\\\.cursor\\\\mcp.json', configured: true, automatic: true, launchAvailable: true },
      { id: 'trae', name: 'Trae Work', path: 'C:\\\\Users\\\\zhengyunhui\\\\AppData\\\\Roaming\\\\TRAE SOLO CN\\\\User\\\\mcp.json', configured: true, automatic: true, connectionState: 'connected', launchAvailable: true },
      { id: 'qwen', name: 'Qwen Code', path: 'C:\\\\Users\\\\zhengyunhui\\\\.qwen\\\\settings.json', configured: false, automatic: true },
      { id: 'qoder', name: 'Qoder CN（通义灵码）', path: 'C:\\\\Users\\\\zhengyunhui\\\\.qoder-cn\\\\settings.json', configured: false, automatic: true },
      { id: 'zcode', name: 'ZCode（智谱）', path: 'C:\\\\Users\\\\zhengyunhui\\\\.zcode\\\\cli\\\\config.json', configured: false, automatic: true },
      { id: 'mimo', name: 'MiMo Code（小米）', path: 'C:\\\\Users\\\\zhengyunhui\\\\AppData\\\\Local\\\\mimocode\\\\mimocode.jsonc', configured: false, automatic: true },
      { id: 'kimi', name: 'Kimi Code（月之暗面）', path: 'C:\\\\Users\\\\zhengyunhui\\\\.kimi-code\\\\mcp.json', configured: false, automatic: true },
      { id: 'qwenpaw', name: 'QwenPaw', path: 'C:\\\\Users\\\\zhengyunhui\\\\.qwenpaw\\\\workspaces\\\\default\\\\drivers\\\\mcp\\\\pmbrain.yaml', configured: true, automatic: true, connectionState: 'connected', launchAvailable: true },
      { id: 'codex', name: 'Codex', path: 'C:\\\\Users\\\\zhengyunhui\\\\.codex\\\\config.toml', configured: true, automatic: true, connectionState: 'connected', launchAvailable: true },
      { id: 'claude', name: 'Claude', path: 'C:\\Users\\zhengyunhui\\.claude.json', configured: true, automatic: false, connectionState: 'invalid' },
      { id: 'grok', name: 'Grok Build', path: 'C:\\\\Users\\\\zhengyunhui\\\\.grok\\\\config.toml', configured: true, automatic: true, connectionState: 'connected', launchAvailable: true },
      { id: 'hermes', name: 'Hermes', path: null, configured: false, automatic: false },
      { id: 'openclaw', name: 'OpenClaw', path: null, configured: false, automatic: false },
      { id: 'codebuddy', name: 'CodeBuddy', path: 'C:\\\\Users\\\\zhengyunhui\\\\.codebuddy\\\\mcp.json', configured: true, automatic: true },
    ],
    port: 3132
   }),
   listDockerDatabases: async () => (${postgres ? `[
    { containerName: 'pmbrain-postgres-694e698fdd7e', databaseUrl: 'postgresql://pmbrain:secret@127.0.0.1:55142/pmbrain', displayAddress: 'postgresql://pmbrain:••••@127.0.0.1:55142/pmbrain', current: true, createdAt: '2026-09-19T07:02:40Z', status: 'running', verified: true },
    { containerName: 'gbrain-pg', databaseUrl: 'postgresql://postgres:secret@127.0.0.1:5433/gbrain', displayAddress: 'postgresql://postgres:••••@127.0.0.1:5433/gbrain', current: false, createdAt: '2026-08-16T00:27:48Z', status: 'stopped', verified: false }
  ]` : '[]'}),
   activateDockerDatabase: async (containerName) => ({ containerName, databaseUrl: 'postgresql://postgres:secret@127.0.0.1:5433/gbrain', displayAddress: 'postgresql://postgres:••••@127.0.0.1:5433/gbrain', current: false, createdAt: '2026-08-16T00:27:48Z', status: 'running', verified: true }),
  getIntegrations: async () => (await window.pmbrainDesktop.getSetup()).integrations,
  getState: async () => (${panel === 'recovery'
    ? "({ phase: 'failed', message: 'PGLite database is already owned by another process (pid=37564, type=desktop-sidecar).' })"
    : "({ phase: 'ready', port: 3132 })"}),
  getStartupProgress: async () => ({ visible: false, stage: 'sidecar', title: '', message: '' }),
  onStartupProgress: () => () => {},
  getTheme: async () => ({ source: '${theme}', resolved: '${theme}' }),
  setTheme: async (source) => ({ source, resolved: source === 'light' ? 'light' : 'dark' }),
  onThemeState: () => () => {},
  getSystemSettings: async () => ({
    preferences: {
      networkMode: 'shared', closeBehavior: 'tray', sharedAdapter: 'Wi-Fi',
      sharedIp: '192.168.1.20', sharedResumeRequired: false,
    },
    theme: { source: '${theme}', resolved: '${theme}' },
    launchAtLogin: true,
    networkCandidates: [{
      adapterName: 'Wi-Fi', address: '192.168.1.20', netmask: '255.255.255.0',
      cidr: '192.168.1.20/24', mac: '00:11:22:33:44:55', virtual: false, recommended: true,
    }],
    selectedAddressAvailable: true,
    localMcpUrl: 'http://127.0.0.1:3132/mcp',
    sharedMcpUrl: 'http://192.168.1.20:3131/mcp',
    gateway: {
      running: true, bindAddress: '192.168.1.20', port: 3131,
      mcpUrl: 'http://192.168.1.20:3131/mcp', healthUrl: 'http://192.168.1.20:3131/health',
      targetMcpUrl: 'http://127.0.0.1:3132/mcp',
    },
  }),
  saveSystemSettings: async (payload) => ({
    canceled: false,
    state: { ...(await window.pmbrainDesktop.getSystemSettings()), launchAtLogin: payload.launchAtLogin },
  }),
  onSystemSettingsState: () => () => {},
  getMemoryWriteback: async () => ({
    mode: 'off', enabled: false, ttl: '30d', notice_shown: false, visibility: 'private', agents: [], issues: [],
  }),
  saveMemoryWriteback: async (payload) => ({
    mode: payload.mode ?? 'off', enabled: payload.mode !== undefined && payload.mode !== 'off', ttl: '30d', notice_shown: true, visibility: 'private', agents: [], issues: [],
  }),
  getSharedAccess: async () => ({
    mcpUrl: 'http://192.168.1.20:3131/mcp',
    mainSourceId: 'default',
    sources: [
      { id: 'default', name: '公司知识', federated: true, archived: false },
      { id: 'projects', name: '项目资料', federated: true, archived: false },
    ],
    credentials: [{
      id: 'key-1', name: '产品部 Alice', credentialName: 'shared:产品部 Alice:preview',
      status: 'active', scope: 'read', federatedRead: ['default'], totalRequests: 18,
    }],
  }),
  createSharedIntegration: async () => ({
    id: 'key-preview', name: 'shared:preview', token: 'preview-token', scopes: ['read'],
    federatedRead: ['default'], mcpUrl: 'http://192.168.1.20:3131/mcp',
    snippet: '{ "type": "http", "url": "http://192.168.1.20:3131/mcp" }',
  }),
  revokeSharedIntegration: async () => window.pmbrainDesktop.getSharedAccess(),
  getUpdateState: async () => ({ phase: 'up-to-date', currentVersion: '1.0.55', message: '当前已经是最新版本' }),
  onState: () => () => {},
  onUpdateState: () => () => {},
  onShowUpdates: () => () => {},
  onShowPanel: (callback) => { setTimeout(() => callback('${panel}'), 0); return () => {}; },
  chooseDirectory: async () => null,
  writeWorkbuddyUserAgent: async () => ({ written: [], backedUp: [] }),
  getWorkbuddyAgentIntegration: async () => ({
    state: 'not_installed',
    workbuddyDetected: true,
    workspace: null,
    packVersion: '1',
    installedPackVersion: null,
    rulesInstalled: false,
    skillsInstalled: 0,
    skillsTotal: 5,
    mcpConfigured: false,
    mcpConnected: false,
    message: '',
  }),
  installWorkbuddyAgent: async () => window.pmbrainDesktop.getWorkbuddyAgentIntegration(),
  updateWorkbuddyAgent: async () => window.pmbrainDesktop.getWorkbuddyAgentIntegration(),
  removeWorkbuddyAgent: async () => window.pmbrainDesktop.getWorkbuddyAgentIntegration(),
  inspectKnowledgeSourceDirectory: async (path) => ({
    path,
    sourceName: path.replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop() || '',
    gitEnabled: false,
  }),
  initializeKnowledgeSourceGit: async (path) => ({
    path,
    sourceName: path.replace(/[\\\\/]+$/, '').split(/[\\\\/]/).pop() || '',
    gitEnabled: true,
  }),
  getProviderModels: async (provider, touchpoint) => ({
    source: provider === 'ollama' ? 'ollama' : 'catalog',
    models: provider === 'ollama'
      ? (touchpoint === 'embedding' ? ['nomic-embed-text'] : ['qwen3:latest', 'qwen2.5:latest'])
      : touchpoint === 'embedding'
        ? (provider === 'zhipu' ? ['embedding-3', 'embedding-2'] : ['nomic-embed-text'])
        : ['mimo-v2.5-pro', 'mimo-v2-pro']
  }),
  testModelConnection: async (input) => input.touchpoint === 'embedding'
    ? { status: 'success', dimensions: 4096, durationMs: 320 }
    : { status: 'success', durationMs: 820 },
  getAdvancedModelConfig: async () => ({
    tiers: {
      utility: { override: '', resolved: 'mimo:mimo-v2.5-pro', source: 'models.default' },
      reasoning: { override: 'deepseek:deepseek-v4-flash', resolved: 'deepseek:deepseek-v4-flash', source: 'models.tier.reasoning' },
      deep: { override: '', resolved: 'mimo:mimo-v2.5-pro', source: 'models.default' },
      subagent: { override: '', resolved: 'mimo:mimo-v2.5-pro', source: 'models.default' },
    },
    phases: {
      propose_takes: { override: 'mimo:mimo-v2.5-pro', resolved: 'mimo:mimo-v2.5-pro', source: 'models.propose_takes' },
      grade_takes: { override: '', resolved: 'deepseek:deepseek-v4-flash', source: 'models.tier.reasoning（继承）' },
      calibration_profile: { override: '', resolved: 'deepseek:deepseek-v4-flash', source: 'models.tier.reasoning（继承）' },
    },
  }),
  saveAdvancedModelConfig: async () => window.pmbrainDesktop.getAdvancedModelConfig(),
  saveSetup: async () => window.pmbrainDesktop.getSetup(),
  configureIntegration: async (client, credentialKind, deep) => {
    const item = (await window.pmbrainDesktop.getSetup()).integrations.find((entry) => entry.id === client);
    return {
      client,
      credentialKind,
      configured: Boolean(item?.automatic || deep),
      path: item?.path ?? null,
      backup: item?.path ? item.path + '.backup' : null,
      snippet: '[mcp_servers.pmbrain]\\nurl = "http://127.0.0.1:3132/mcp"',
      smoke: { toolCount: 12, statsOk: true },
      connectionState: 'connected',
    };
  },
  launchIntegration: async () => {},
  copy: async () => {},
  openAdmin: async () => {},
  productConnectors: async () => ({
    cards: [
      { id: 'chatgpt', name: 'ChatGPT', connected: false, account: null, last_sync_label: '尚未同步' },
      { id: 'claude', name: 'Claude', connected: false, account: null, last_sync_label: '尚未同步' },
      { id: 'google', name: 'Google', connected: true, account: 'yunhui@example.com', last_sync_label: '今天 10:32' },
    ],
    google: { accounts: [{ account: 'yunhui@example.com' }] },
  }),
  productConnectorSync: async () => ({ ok: true }),
  productConnectorAuth: async () => ({ ok: true }),
  productConnectorLogout: async () => ({ ok: true }),
  productWaiting: async () => ({
    items: [
      { id: 1, title: '张三在等你回复', meta: '3 天前 · 来自会议《项目推进会》', origin_key: 'meeting' },
      { id: 2, title: '你答应周五发预算方案', meta: '昨天 · 来自 AI 对话', origin_key: 'conversation' },
    ],
    origins: {
      gmail: { ready: true, label: 'Gmail' },
      meeting: { ready: true, label: '会议' },
      conversation: { ready: true, label: 'AI 对话' },
    },
  }),
  productWaitingClose: async () => ({ ok: true }),
  productWaitingScan: async () => ({ opened: 0 }),
  productChronicleDay: async () => ({ events: [] }),
  productChronicleOnThisDay: async () => ({ events: [] }),
  productChronicleStatus: async () => ({ enabled: false, event_count: 0, history_count: 326 }),
  productEnableChronicle: async () => ({ ok: true }),
  productOrganizeChronicleHistory: async () => ({ ok: true }),
  productHideChronicleEvent: async () => ({ ok: true }),
  productOntology: async () => ([]),
  productEntityIdentity: async () => ([]),
  productEntityIdentityLink: async () => ({ ok: true }),
  productPeople: async () => ({
    people: [
      { source_id: 'youdao', slug: 'people/zhang-san', title: '张三', source_label: '有道' },
      { source_id: 'meetings', slug: 'people/zhang-zong', title: '张总', source_label: '会议' },
    ],
    suggestions: [],
    groups: [],
  }),
  productPeopleCard: async () => ({ entity_id: 'zhang-san', name: '张三', company: 'XX 公司', role: '产品经理', last_contact_label: '9 月 18 日', open_items: 2, recent_meetings: 3, members: [], timeline: [] }),
  productMergePeople: async () => ({ entity_id: 'zhang-san' }),
  productRejectPeople: async () => ({ ok: true }),
  productUnlinkPeople: async () => ({ ok: true }),
  googleStatus: async () => ({ status: 'connected', accounts: [{ account: 'yunhui@example.com' }] }),
  googleConnect: async () => ({ ok: true, status: 'connected', account: 'yunhui@example.com' }),
  googleSource: async () => ({ ok: true }),
  chooseFile: async () => null,
  openExternal: async () => {},
  checkUpdates: async () => null,
  installUpdate: async () => {},
  listPgliteUpgradeBackups: async () => ({ databasePath: null, backupRoot: null, keep: 2, totalBytes: 0, backups: [] }),
  prunePgliteUpgradeBackups: async () => ({ status: 'pruned', deleted: [], kept: [], listing: await window.pmbrainDesktop.listPgliteUpgradeBackups() }),
  deletePgliteUpgradeBackup: async () => ({ status: 'deleted', listing: await window.pmbrainDesktop.listPgliteUpgradeBackups() }),
  restorePgliteUpgradeBackup: async () => ({ status: 'restored', listing: await window.pmbrainDesktop.listPgliteUpgradeBackups() }),
  setPgliteUpgradeBackupRoot: async () => ({ status: 'unchanged', listing: await window.pmbrainDesktop.listPgliteUpgradeBackups() }),
  openPgliteUpgradeBackup: async () => {},
  getPgliteRecoveryStatus: async () => ({
    state: 'active', pid: 37564, ownerType: 'desktop-sidecar',
    commandLabel: 'PMBrain Desktop sidecar', acquiredAt: null,
    canTerminate: true, message: '发现另一个 PMBrain 进程。',
  }),
  terminatePgliteOwnerAndRetry: async () => {},
  retry: async () => {},
  openLogs: async () => '',
  quit: async () => {}
};
console.log('PMBrain mock injected: panel=${panel}, theme=${theme}, integrations count=9');
window.location.hash = 'settings-${panel}';
// HTML 初始状态已在 Node.js 侧修改，无需 setTimeout 切换面板
// 等 DOM 渲染后滚动到目标区域
setTimeout(() => {
  const el = document.querySelector('${scrollTarget}');
  if (el) el.scrollIntoView({ block: 'center' });
}, 200);
${integrationDialogClient ? `setTimeout(() => {
  const card = Array.from(document.querySelectorAll('.integration-card')).find((item) => item.querySelector('h3')?.textContent?.toLowerCase().includes('${integrationDialogClient}'.toLowerCase()));
  const buttons = card ? Array.from(card.querySelectorAll('button')) : [];
  const button = buttons.find((item) => ${integrationDialogDeep ? "item.textContent?.includes('深度接入')" : "!item.textContent?.includes('深度接入')"});
  if (button) button.click();
}, 450);` : ''}
</script>
`;

const tempDir = prepareOnly ? null : mkdtempSync(join(tmpdir(), 'pmbrain-renderer-preview-'));
const previewHtml = preparedHtmlArg
  ? preparedHtmlArg.slice('--html='.length)
  : prepareOnly
    ? join(root, 'out', `renderer-preview-${panel}.html`)
    : join(tempDir!, 'preview.html');
let html = readFileSync(rendererHtml, 'utf8');

// The preview HTML lives in a temporary directory, so point built assets back
// to the renderer output directory instead of resolving them beside the temp file.
const rendererAssetBase = prepareOnly
  ? './renderer/assets/'
  : pathToFileURL(join(dirname(rendererHtml), 'assets') + '\\').href;
html = html.replace(/(["'])\.\/assets\//g, `$1${rendererAssetBase}`);

// 移除 CSP 限制
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');

// 注入 mock API（插到 </head> 前），提供 JS 降级
html = html.replace('</head>', `${mockApi}\n</head>`);

// ===== 静态 HTML 修改（不依赖 JS 执行） =====

// 1. rail-item：去掉所有 active，只激活目标面板按钮
html = html.replace(/class="rail-item active"/g, 'class="rail-item"');
html = html.replace(
  new RegExp(`class="rail-item" data-target="${panel}"`),
  `class="rail-item active" data-target="${panel}"`
);

// 2. panel section：去掉所有 active，只激活目标面板
html = html.replace(/class="panel active"/g, 'class="panel"');
html = html.replace(
  new RegExp(`(class="panel)" id="panel-${panel}">`),
  `class="panel active" id="panel-${panel}">`
);

// 3. 页眉标题按面板调整
const panelTitles: Record<Panel, { eyebrow: string; title: string }> = {
  basic:       { eyebrow: 'DESKTOP SETTINGS / 01', title: '配置数据库、原始资料与主源' },
  models:      { eyebrow: 'DESKTOP SETTINGS / 02', title: '配置普通模型与向量模型' },
  integrations:{ eyebrow: 'MCP / 03',               title: '把 PMBrain 接入 AI 客户端' },
  daily:       { eyebrow: 'DAILY',                  title: '连接器、待我处理、年表和人物关联' },
  system:      { eyebrow: 'SYSTEM / 04',            title: '管理桌面连接与系统行为' },
  updates:     { eyebrow: 'UPDATES / 05',           title: '保持桌面端安全更新' },
  repair:      { eyebrow: 'REPAIR / 06',            title: '软件修复' },
  recovery:    { eyebrow: 'RECOVERY',               title: '恢复 PMBrain 本地服务' },
};
const t = panelTitles[panel];
html = html.replace(/(id="page-eyebrow">)[^<]+(<\/p>)/, `$1${t.eyebrow}$2`);
html = html.replace(/(id="page-title">)[^<]+(<\/h1>)/, `$1${t.title}$2`);

// 4. 集成面板：预生成卡片 HTML 注入到 integration-grid
interface MockIntegration {
  id: string; name: string; path: string | null; configured: boolean; automatic: boolean;
  connectionState?: 'connected' | 'saved' | 'invalid';
  launchAvailable?: boolean;
}
const mockIntegrations: MockIntegration[] = [
  { id: 'cherry', name: 'CherryStudio', path: null, configured: false, automatic: false, launchAvailable: true },
  { id: 'workbuddy', name: 'Workbuddy', path: 'C:\\Users\\zhengyunhui\\.workbuddy\\mcp.json', configured: true, automatic: true, connectionState: 'connected', launchAvailable: true },
  { id: 'cursor', name: 'Cursor', path: 'C:\\Users\\zhengyunhui\\.cursor\\mcp.json', configured: true, automatic: true, launchAvailable: true },
  { id: 'trae', name: 'Trae Work', path: 'C:\\Users\\zhengyunhui\\AppData\\Roaming\\TRAE SOLO CN\\User\\mcp.json', configured: true, automatic: true, connectionState: 'connected', launchAvailable: true },
  { id: 'qwen', name: 'Qwen Code', path: 'C:\\Users\\zhengyunhui\\.qwen\\settings.json', configured: false, automatic: true },
  { id: 'qoder', name: 'Qoder CN（通义灵码）', path: 'C:\\Users\\zhengyunhui\\.qoder-cn\\settings.json', configured: false, automatic: true },
  { id: 'zcode', name: 'ZCode（智谱）', path: 'C:\\Users\\zhengyunhui\\.zcode\\cli\\config.json', configured: false, automatic: true },
  { id: 'mimo', name: 'MiMo Code（小米）', path: 'C:\\Users\\zhengyunhui\\AppData\\Local\\mimocode\\mimocode.jsonc', configured: false, automatic: true },
  { id: 'kimi', name: 'Kimi Code（月之暗面）', path: 'C:\\Users\\zhengyunhui\\.kimi-code\\mcp.json', configured: false, automatic: true },
  { id: 'qwenpaw', name: 'QwenPaw', path: 'C:\\Users\\zhengyunhui\\.qwenpaw\\workspaces\\default\\drivers\\mcp\\pmbrain.yaml', configured: true, automatic: true, connectionState: 'connected', launchAvailable: true },
  { id: 'codex', name: 'Codex', path: 'C:\\Users\\zhengyunhui\\.codex\\config.toml', configured: true, automatic: true, connectionState: 'connected', launchAvailable: true },
  { id: 'claude', name: 'Claude', path: 'C:\Users\zhengyunhui\.claude.json', configured: true, automatic: false, connectionState: 'invalid' },
  { id: 'grok', name: 'Grok Build', path: 'C:\\Users\\zhengyunhui\\.grok\\config.toml', configured: true, automatic: true, connectionState: 'connected', launchAvailable: true },
  { id: 'hermes', name: 'Hermes', path: null, configured: false, automatic: false },
  { id: 'openclaw', name: 'OpenClaw', path: null, configured: false, automatic: false },
  { id: 'codebuddy', name: 'CodeBuddy', path: 'C:\\Users\\zhengyunhui\\.codebuddy\\mcp.json', configured: true, automatic: true },
];
const cardsHtml = mockIntegrations.map((item) => {
  const badgeClass = item.configured ? 'configured badge' : 'badge';
  const badgeText = item.connectionState === 'connected'
    ? '接入可用'
    : item.connectionState === 'invalid'
      ? '接入失效'
      : item.configured ? '待验证' : '未配置';
  const pathText = item.path ?? (item.id === 'claude' ? '通过 Claude CLI / GUI 接入' : '通过客户端 MCP 配置接入');
  const noteText = item.id === 'qwenpaw'
    ? '通过本机 API 写入 Bearer 并验证，不使用 OAuth'
    : item.automatic
      ? '自动备份并合并现有配置；连接状态在后台验证。'
      : item.id === 'claude' ? '生成可复制的接入命令' : '生成可复制的接入配置';
  const btnText = item.automatic
    ? item.configured ? '更新连接' : '接入'
    : item.id === 'claude' ? '生成接入命令' : '生成接入配置';
  const workbuddyDeep = item.id === 'workbuddy' && item.configured ? '<button type="button">深度接入</button>' : '';
  const deep = ['claude', 'codex', 'grok'].includes(item.id) ? '<button type="button">深度接入</button>' : '';
  const launch = item.launchAvailable ? '<button type="button" class="integration-launch"><i class="integration-launch-icon"></i><span>启动</span></button>' : '';
  const help = ['claude', 'codex', 'grok'].includes(item.id) ? '<small class="integration-action-help">更新连接只更新 MCP；深度接入还会安装自动记忆规则。</small>' : '';
  const actions = `<div class="integration-actions"><button class="solid">${btnText}</button>${workbuddyDeep}${deep}${launch}</div>`;
  return `<article class="integration-card"><span class="${badgeClass}">${badgeText}</span><h3>${item.name}</h3><p>${pathText}</p><small>${noteText}</small>${actions}${help}</article>`;
}).join('\n          ');
html = html.replace(
  '<div class="integration-grid" id="integration-grid"></div>',
  `<div class="integration-grid" id="integration-grid">\n          ${cardsHtml}\n        </div>`
);

// 5. 服务状态（左侧栏底部）
html = html.replace(
  /(<i id="service-dot"><\/i>\s*<div>)\s*<b id="service-label">[^<]*<\/b>\s*<small id="service-detail">[^<]*<\/small>\s*<\/div>/,
  `$1<b id="service-label">服务已就绪</b><small id="service-detail">127.0.0.1:3132</small></div>`
);
html = html.replace('id="service-dot"', 'id="service-dot" class="ready"');

// 6. 已存在配置标记
html = html.replace(
  /(<div class="existing-config" id="existing-config") hidden/,
  '$1'
);

// 7. 配置路径
html = html.replace(
  /(<p id="config-path"><\/p>)/,
  '<p id="config-path">配置写入：C:\\Users\\zhengyunhui\\.pmbrain\\config.json</p>'
);

// 8. 当前模型显示
html = html.replace(
  /(<small id="chat-model-effective">)[^<]*(<\/small>)/,
  '$1当前生效：mimo:mimo-v2.5-pro$2'
);
html = html.replace(
  /(<small id="embedding-model-effective">)[^<]*(<\/small>)/,
  '$1当前生效：zhipu:embedding-3$2'
);

// 9. "进入管理台"按钮启用
html = html.replace('id="open-admin" disabled', 'id="open-admin"');
html = html.replace('id="finish-open-admin"', 'id="finish-open-admin" disabled');

if (memorySetupHint) {
  html = html.replace('id="memory-setup-hint" role="alert" hidden', 'id="memory-setup-hint" role="alert"');
}

writeFileSync(previewHtml, html, 'utf8');

if (prepareOnly) {
  console.log(`[${new Date().toISOString()}] Prepared browser-use preview: panel=${panel}, theme=${theme}, html=${previewHtml}`);
  process.exit(0);
}

const fileUrl = `file:///${previewHtml.replace(/\\/g, '/')}`;
const result = spawnSync(browser!, [
  '--headless=new',
  '--disable-gpu',
  '--allow-file-access-from-files',
  '--window-size=1440,3000',
  '--virtual-time-budget=2500',
  `--screenshot=${output}`,
  fileUrl,
], { stdio: 'inherit' });

if (result.status !== 0) {
  throw new Error(`Browser screenshot failed with exit code ${result.status ?? 'unknown'}`);
}

const size = statSync(output).size;
console.log(`[${new Date().toISOString()}] Preview: panel=${panel}, theme=${theme}, output=${output}, mock integrations count=${mockIntegrations.length}`);
