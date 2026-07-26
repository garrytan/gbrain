import { existsSync, readFileSync, writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const VALID_PANELS = ['basic', 'models', 'integrations', 'system', 'updates', 'recovery'] as const;
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
  system: '#shared-address',
  updates: '#update-current',
  recovery: '#recovery-message',
};
const scrollTarget = panelScrollTarget[panel];

const mockApi = `
<script>
window.pmbrainDesktop = {
  getSetup: async () => ({
    setup: {
      needsSetup: false,
      configPath: 'C:\\\\Users\\\\zhengyunhui\\\\.pmbrain\\\\config.json',
      defaults: {
        databasePath: 'C:\\\\Users\\\\zhengyunhui\\\\.pmbrain\\\\brain.pglite',
        knowledgeDirectory: 'C:\\\\Users\\\\zhengyunhui\\\\Documents\\\\PMBrain'
      },
      current: {
        engine: 'pglite',
        theme: 'system',
        databasePath: 'D:\\\\tmp\\\\brain.pglite',
        databaseConfigured: true,
        knowledgeDirectory: 'C:\\\\Users\\\\zhengyunhui\\\\Documents\\\\PMBrain',
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
      { id: 'codebuddy', name: 'CodeBuddy', path: 'C:\\\\Users\\\\zhengyunhui\\\\.codebuddy\\\\mcp.json', configured: true, automatic: true },
      { id: 'workbuddy', name: 'Workbuddy', path: 'C:\\\\Users\\\\zhengyunhui\\\\.workbuddy\\\\mcp.json', configured: false, automatic: true },
      { id: 'cursor', name: 'Cursor', path: 'C:\\\\Users\\\\zhengyunhui\\\\.cursor\\\\mcp.json', configured: true, automatic: true },
      { id: 'trae', name: 'Trae', path: 'C:\\\\Users\\\\zhengyunhui\\\\AppData\\\\Roaming\\\\Trae\\\\User\\\\mcp.json', configured: false, automatic: true },
      { id: 'claude', name: 'Claude', path: null, configured: false, automatic: false },
      { id: 'codex', name: 'Codex', path: 'C:\\\\Users\\\\zhengyunhui\\\\.codex\\\\config.toml', configured: false, automatic: true },
      { id: 'qwenpaw', name: 'QwenPaw', path: 'C:\\\\Users\\\\zhengyunhui\\\\.qwenpaw\\\\workspaces\\\\default\\\\drivers\\\\mcp\\\\pmbrain.yaml', configured: true, automatic: true, connectionState: 'connected' },
    ],
    port: 3132
  }),
  getState: async () => ({ phase: 'ready', port: 3132 }),
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
  getUpdateState: async () => ({ phase: 'up-to-date', currentVersion: '1.0.55', previousVersion: '1.0.54', message: '当前已经是最新版本' }),
  onState: () => () => {},
  onUpdateState: () => () => {},
  onShowUpdates: () => () => {},
  onShowPanel: (callback) => { setTimeout(() => callback('${panel}'), 0); return () => {}; },
  chooseDirectory: async () => null,
  getProviderModels: async (provider, touchpoint) => ({
    source: provider === 'ollama' ? 'ollama' : 'catalog',
    models: provider === 'ollama'
      ? (touchpoint === 'embedding' ? ['nomic-embed-text'] : ['qwen3:latest', 'qwen2.5:latest'])
      : touchpoint === 'embedding'
        ? (provider === 'zhipu' ? ['embedding-3', 'embedding-2'] : ['nomic-embed-text'])
        : ['mimo-v2.5-pro', 'mimo-v2-pro']
  }),
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
  configureIntegration: async () => ({}),
  copy: async () => {},
  openAdmin: async () => {},
  checkUpdates: async () => null,
  installUpdate: async () => {},
  openPreviousRelease: async () => {},
  retry: async () => {},
  openLogs: async () => '',
  quit: async () => {}
};
console.log('PMBrain mock injected: panel=${panel}, theme=${theme}, integrations count=6');
// HTML 初始状态已在 Node.js 侧修改，无需 setTimeout 切换面板
// 等 DOM 渲染后滚动到目标区域
setTimeout(() => {
  const el = document.querySelector('${scrollTarget}');
  if (el) el.scrollIntoView({ block: 'center' });
}, 200);
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
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]+ \/>/, '');

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
  system:      { eyebrow: 'SYSTEM / 04',            title: '管理桌面连接与系统行为' },
  updates:     { eyebrow: 'UPDATES / 05',           title: '保持桌面端安全更新' },
  recovery:    { eyebrow: 'RECOVERY',               title: '恢复 PMBrain 本地服务' },
};
const t = panelTitles[panel];
html = html.replace(/(id="page-eyebrow">)[^<]+(<\/p>)/, `$1${t.eyebrow}$2`);
html = html.replace(/(id="page-title">)[^<]+(<\/h1>)/, `$1${t.title}$2`);

// 4. 集成面板：预生成卡片 HTML 注入到 integration-grid
interface MockIntegration {
  id: string; name: string; path: string | null; configured: boolean; automatic: boolean;
  connectionState?: 'connected' | 'saved';
}
const mockIntegrations: MockIntegration[] = [
  { id: 'codebuddy', name: 'CodeBuddy', path: 'C:\\Users\\zhengyunhui\\.codebuddy\\mcp.json', configured: true, automatic: true },
  { id: 'workbuddy', name: 'Workbuddy', path: 'C:\\Users\\zhengyunhui\\.workbuddy\\mcp.json', configured: false, automatic: true },
  { id: 'cursor', name: 'Cursor', path: 'C:\\Users\\zhengyunhui\\.cursor\\mcp.json', configured: true, automatic: true },
  { id: 'trae', name: 'Trae', path: 'C:\\Users\\zhengyunhui\\AppData\\Roaming\\Trae\\User\\mcp.json', configured: false, automatic: true },
  { id: 'claude', name: 'Claude', path: null, configured: false, automatic: false },
  { id: 'codex', name: 'Codex', path: 'C:\\Users\\zhengyunhui\\.codex\\config.toml', configured: false, automatic: true },
  { id: 'qwenpaw', name: 'QwenPaw', path: 'C:\\Users\\zhengyunhui\\.qwenpaw\\workspaces\\default\\drivers\\mcp\\pmbrain.yaml', configured: true, automatic: true, connectionState: 'connected' },
];
const cardsHtml = mockIntegrations.map((item) => {
  const badgeClass = item.configured ? 'configured badge' : 'badge';
  const badgeText = item.id === 'qwenpaw' && item.connectionState === 'connected'
    ? '已连接'
    : item.configured ? '已配置' : '未配置';
  const pathText = item.path ?? '通过 Claude CLI / GUI 接入';
  const noteText = item.id === 'qwenpaw'
    ? '通过本机 API 写入 Bearer 并验证，不使用 OAuth'
    : item.automatic ? '自动备份并合并现有配置' : '生成可复制的接入命令';
  const btnText = item.automatic ? item.configured ? '更新' : '创建并写入' : '生成接入命令';
  return `<article class="integration-card"><span class="${badgeClass}">${badgeText}</span><h3>${item.name}</h3><p>${pathText}</p><small>${noteText}</small><button class="solid">${btnText}</button></article>`;
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
console.log(`[${new Date().toISOString()}] Preview: panel=${panel}, theme=${theme}, output=${output}, mock integrations count=6`);
