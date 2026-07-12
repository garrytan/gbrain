import './style.css';
import type {
  AdvancedModelConfig,
  AdvancedModelTier,
  CredentialKind,
  DesktopSetupState,
  DesktopTheme,
  DesktopThemeState,
  IntegrationClient,
  IntegrationInfo,
  PMBrainDesktopApi,
  SetupPayload,
  SidecarState,
  StartupProgress,
  UpdateState,
} from '../preload/index.js';

declare global {
  interface Window { pmbrainDesktop: PMBrainDesktopApi }
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let state: DesktopSetupState | null = null;
let lastResult = '';
let advancedModelsLoaded = false;
let advancedOverrides: Partial<Record<AdvancedModelTier, string>> = {};
const providerModels: Record<'chat' | 'embedding', string[]> = { chat: [], embedding: [] };
const advancedProviderModels: Record<AdvancedModelTier, string[]> = {
  utility: [],
  reasoning: [],
  deep: [],
  subagent: [],
};

function setNotice(kind: 'error' | 'success', message = ''): void {
  const element = $<HTMLElement>(`#global-${kind}`);
  element.textContent = message;
  element.hidden = !message;
  if (message) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setBusy(button: HTMLButtonElement, busy: boolean, text?: string): void {
  button.disabled = busy;
  button.classList.toggle('busy', busy);
  const span = button.querySelector('span');
  if (span && text) span.textContent = text;
}

function saveButtonText(): string {
  return state?.setup.needsSetup === false ? '保存修改并重启' : '保存配置并启动';
}

function setSetupWait(visible: boolean, title = '', message = '', stage = '正在处理'): void {
  const overlay = $('#setup-wait');
  overlay.hidden = !visible;
  $('#setup-wait-stage').textContent = stage;
  if (title) $('#setup-wait-title').textContent = title;
  if (message) $('#setup-wait-message').textContent = message;
}

type Panel = 'basic' | 'models' | 'integrations' | 'updates' | 'recovery';

const PANEL_COPY: Record<Panel, { eyebrow: string; title: string }> = {
  basic: { eyebrow: 'DESKTOP SETTINGS / 01', title: '配置数据库、原始资料与主源' },
  models: { eyebrow: 'DESKTOP SETTINGS / 02', title: '配置普通模型与向量模型' },
  integrations: { eyebrow: 'MCP / 03', title: '把 PMBrain 接入 AI 客户端' },
  updates: { eyebrow: 'UPDATES / 04', title: '保持桌面端安全更新' },
  recovery: { eyebrow: 'RECOVERY', title: '恢复 PMBrain 本地服务' },
};

function switchPanel(target: Panel): void {
  document.querySelectorAll('.rail-item').forEach((item) => item.classList.toggle('active', (item as HTMLElement).dataset.target === target));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${target}`));
  const copy = PANEL_COPY[target];
  $('#page-eyebrow').textContent = state?.setup.needsSetup && target === 'basic' ? 'FIRST RUN / 01' : copy.eyebrow;
  $('#page-title').textContent = state?.setup.needsSetup && target === 'basic'
    ? '把 PMBrain 安顿在这台电脑上'
    : copy.title;
}

function renderTheme(theme: DesktopThemeState): void {
  document.documentElement.dataset.theme = theme.resolved;
  ($<HTMLSelectElement>('#theme-select')).value = theme.source;
}

function renderStartupProgress(progress: StartupProgress): void {
  const stages = { migration: '数据库迁移', sidecar: '本地服务启动', health: '健康检查' } as const;
  setSetupWait(progress.visible, progress.title, progress.message, stages[progress.stage]);
}

function selectedEngine(): 'pglite' | 'postgres' {
  return (document.querySelector<HTMLInputElement>('input[name="engine"]:checked')?.value ?? 'pglite') as 'pglite' | 'postgres';
}

function renderEngine(): void {
  const engine = selectedEngine();
  $('#pglite-fields').hidden = engine !== 'pglite';
  $('#postgres-fields').hidden = engine !== 'postgres';
  $('#mode-pglite-card').classList.toggle('selected', engine === 'pglite');
  $('#mode-postgres-card').classList.toggle('selected', engine === 'postgres');
}

function normalizePglitePathForDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\\/]?brain\.pglite$/i.test(trimmed)) return trimmed;
  const separator = trimmed.endsWith('\\') || trimmed.endsWith('/') ? '' : '\\';
  return `${trimmed}${separator}brain.pglite`;
}

function splitModelId(value?: string): { provider: string; model: string } {
  if (!value) return { provider: '', model: '' };
  const index = value.indexOf(':');
  if (index <= 0) return { provider: '', model: value };
  return { provider: value.slice(0, index), model: value.slice(index + 1) };
}

function normalizeProviderForModel(provider: string): string {
  const trimmed = provider.trim();
  return trimmed === 'zeroentropy' ? 'zeroentropyai' : trimmed;
}

function providerKeyId(provider: string): string | null {
  const normalized = normalizeProviderForModel(provider);
  // 本地 provider，不需要 API Key
  if (['ollama', 'llama-server', 'litellm', 'llama-server-reranker'].includes(normalized)) {
    return '__none__';
  }
  if (normalized === 'zeroentropyai') return 'zeroentropy';
  if (['mimo', 'zhipu', 'deepseek', 'openai', 'anthropic',
    'google', 'voyage', 'groq', 'together', 'openrouter',
    'minimax', 'dashscope',
  ].includes(normalized)) {
    return normalized;
  }
  return null;
}

function composeModelId(provider: string, model: string): string {
  const normalizedProvider = normalizeProviderForModel(provider);
  const trimmedModel = model.trim();
  if (!normalizedProvider || !trimmedModel) return '';
  return `${normalizedProvider}:${trimmedModel}`;
}

type ModelKind = 'chat' | 'embedding';
const ADVANCED_TIERS = ['utility', 'reasoning', 'deep', 'subagent'] as const satisfies readonly AdvancedModelTier[];
const ADVANCED_TIER_LABELS: Record<AdvancedModelTier, string> = {
  utility: '轻量任务',
  reasoning: '推理任务',
  deep: '深度任务',
  subagent: '子代理任务',
};

function syncProviderKeyField(kind: ModelKind): void {
  const provider = ($<HTMLSelectElement>(`#${kind}-provider`)).value;
  const input = $<HTMLInputElement>(`#${kind}-api-key`);
  const keyId = providerKeyId(provider);
  const local = keyId === '__none__';
  input.disabled = local;
  input.placeholder = local ? '本地模型无需 API Key' : '';
  input.value = keyId && keyId !== '__none__' ? state?.setup.current.keyValues[keyId] || '' : '';
}

function renderModelDropdown(kind: 'chat' | 'embedding'): void {
  const ul = $<HTMLUListElement>(`#${kind}-model-dropdown`);
  const input = $<HTMLInputElement>(`#${kind}-model-name`);
  const currentValue = input.value.trim();
  const models = providerModels[kind];
  ul.replaceChildren(...models.map(model => {
    const li = document.createElement('li');
    li.textContent = model;
    if (model === currentValue) li.classList.add('selected');
    li.addEventListener('click', () => {
      input.value = model;
      ul.hidden = true;
    });
    return li;
  }));
}

async function refreshProviderModels(kind: ModelKind, chooseDefault: boolean): Promise<void> {
  const providerSelect = $<HTMLSelectElement>(`#${kind}-provider`);
  const provider = providerSelect.value;
  const input = $<HTMLInputElement>(`#${kind}-model-name`);
  const status = $<HTMLElement>(`#${kind}-model-load-status`);
  status.classList.remove('warning');
  if (!provider) {
    providerModels[kind] = [];
    status.textContent = '';
    return;
  }

  status.textContent = provider === 'ollama' ? '正在读取本机 Ollama 模型…' : '正在加载厂商模型…';
  try {
    const result = await window.pmbrainDesktop.getProviderModels(provider, kind);
    if (providerSelect.value !== provider) return;
    providerModels[kind] = result.models;
    if (chooseDefault) input.value = result.models[0] || '';
    if (!($<HTMLUListElement>(`#${kind}-model-dropdown`)).hidden) renderModelDropdown(kind);
    if (result.warning) {
      status.textContent = result.warning;
      status.classList.add('warning');
    } else if (provider === 'ollama') {
      status.textContent = `已读取 ${result.models.length} 个本机/常用 Ollama 向量模型。`;
    } else {
      status.textContent = result.models.length > 0
        ? `可选择 ${result.models.length} 个已支持模型，也可以直接输入自定义模型名。`
        : '该厂商使用自定义模型名，请直接输入。';
    }
  } catch (error) {
    status.textContent = `模型列表加载失败：${error instanceof Error ? error.message : String(error)}`;
    status.classList.add('warning');
  }
}

function renderAdvancedModelDropdown(tier: AdvancedModelTier): void {
  const ul = $<HTMLUListElement>(`#advanced-${tier}-model-dropdown`);
  const input = $<HTMLInputElement>(`#advanced-${tier}-model-name`);
  const currentValue = input.value.trim();
  ul.replaceChildren(...advancedProviderModels[tier].map(model => {
    const li = document.createElement('li');
    li.textContent = model;
    if (model === currentValue) li.classList.add('selected');
    li.addEventListener('click', () => {
      input.value = model;
      ul.hidden = true;
    });
    return li;
  }));
}

async function refreshAdvancedProviderModels(tier: AdvancedModelTier, chooseDefault: boolean): Promise<void> {
  const providerSelect = $<HTMLSelectElement>(`#advanced-${tier}-provider`);
  const provider = providerSelect.value;
  const input = $<HTMLInputElement>(`#advanced-${tier}-model-name`);
  const status = $<HTMLElement>(`#advanced-${tier}-model-status`);
  input.disabled = !provider;
  status.classList.remove('warning');
  if (!provider) {
    advancedProviderModels[tier] = [];
    status.textContent = '';
    return;
  }

  status.textContent = '正在加载模型列表…';
  try {
    const result = await window.pmbrainDesktop.getProviderModels(provider, 'chat');
    if (providerSelect.value !== provider) return;
    advancedProviderModels[tier] = result.models;
    if (chooseDefault) input.value = result.models[0] || '';
    if (!($<HTMLUListElement>(`#advanced-${tier}-model-dropdown`)).hidden) renderAdvancedModelDropdown(tier);
    if (result.warning) {
      status.textContent = result.warning;
      status.classList.add('warning');
    } else {
      status.textContent = result.models.length > 0
        ? `可选择 ${result.models.length} 个已支持模型，也可以直接输入自定义模型名。`
        : '该厂商使用自定义模型名，请直接输入。';
    }
  } catch (error) {
    status.textContent = `模型列表加载失败：${error instanceof Error ? error.message : String(error)}`;
    status.classList.add('warning');
  }
}

function renderAdvancedModelConfig(config: AdvancedModelConfig): void {
  for (const tier of ADVANCED_TIERS) {
    const entry = config.tiers[tier];
    const override = splitModelId(entry.override);
    ($<HTMLSelectElement>(`#advanced-${tier}-provider`)).value = override.provider;
    const input = $<HTMLInputElement>(`#advanced-${tier}-model-name`);
    input.value = override.model;
    input.disabled = !override.provider;
    advancedOverrides[tier] = entry.override;
    $(`#advanced-${tier}-effective`).textContent = entry.resolved
      ? `当前解析：${entry.resolved}${entry.source ? ` · 来源 ${entry.source}` : ''}`
      : '当前没有可用路由';
  }
}

async function loadAdvancedModels(force = false): Promise<void> {
  const button = $<HTMLButtonElement>('#save-advanced-models');
  const status = $('#advanced-model-status');
  if (advancedModelsLoaded && !force) return;
  if (state?.setup.needsSetup) {
    status.textContent = '请先保存基础配置，再读取和设置任务层级路由。';
    button.disabled = true;
    return;
  }
  status.textContent = '正在读取当前高级路由并安全检查本地服务…';
  button.disabled = true;
  try {
    const config = await window.pmbrainDesktop.getAdvancedModelConfig();
    renderAdvancedModelConfig(config);
    await Promise.all(ADVANCED_TIERS.map(tier => refreshAdvancedProviderModels(tier, false)));
    advancedModelsLoaded = true;
    status.textContent = '只保存你在这里明确填写的覆盖；基础配置不会清空高级路由。';
    button.disabled = false;
  } catch (error) {
    status.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function saveAdvancedModels(): Promise<void> {
  const button = $<HTMLButtonElement>('#save-advanced-models');
  const status = $('#advanced-model-status');
  const values: Partial<Record<AdvancedModelTier, string>> = {};
  for (const tier of ADVANCED_TIERS) {
    const provider = ($<HTMLSelectElement>(`#advanced-${tier}-provider`)).value;
    const model = ($<HTMLInputElement>(`#advanced-${tier}-model-name`)).value.trim();
    if ((provider && !model) || (!provider && model)) {
      status.textContent = `${ADVANCED_TIER_LABELS[tier]}需要同时选择厂商和填写模型名称，或点击“跟随普通模型”。`;
      return;
    }
    const next = composeModelId(provider, model);
    if (next !== (advancedOverrides[tier] ?? '')) values[tier] = next;
  }
  if (Object.keys(values).length === 0) {
    status.textContent = '高级路由没有修改。';
    return;
  }
  setBusy(button, true, '正在保存…');
  status.textContent = '正在保存高级路由；如 PGLite 正在使用，桌面端会安全重启本地服务。';
  try {
    renderAdvancedModelConfig(await window.pmbrainDesktop.saveAdvancedModelConfig(values));
    advancedModelsLoaded = true;
    status.textContent = '高级路由已保存，未提交的层级不会被清空。';
  } catch (error) {
    status.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    setBusy(button, false, '保存高级路由');
  }
}

function renderService(service: SidecarState | null, port?: number): void {
  const dot = $('#service-dot');
  dot.className = service?.phase ?? (port ? 'ready' : '');
  const ready = service?.phase === 'ready' || (!service && Boolean(port));
  $('#service-label').textContent = ready ? '服务已就绪'
    : service?.phase === 'starting' ? '正在启动'
      : service?.phase === 'failed' ? '启动失败' : '等待配置';
  $('#service-detail').textContent = service?.port ? `127.0.0.1:${service.port}` : port ? `127.0.0.1:${port}` : 'LOCAL';
  ($<HTMLButtonElement>('#open-admin')).disabled = !ready;
  if (service?.phase === 'starting') {
    setSetupWait(
      true,
      '正在等待本地服务健康检查',
      'PMBrain 已启动 sidecar，正在确认数据库与 HTTP 服务可用；首次启动最长可能需要约 45 秒。',
      '健康检查',
    );
  } else if (service?.phase === 'ready' || service?.phase === 'failed') {
    setSetupWait(false);
  }
  if (service?.phase === 'failed' && state && !state.setup.needsSetup) {
    $('#recovery-message').textContent = service.message || 'PMBrain 服务启动失败，请重试或查看日志。';
    switchPanel('recovery');
  }
}

function renderIntegrations(integrations: IntegrationInfo[]): void {
  const grid = $('#integration-grid');
  grid.replaceChildren(...integrations.map((item) => {
    const article = document.createElement('article');
    article.className = 'integration-card';
    const badge = document.createElement('span');
    badge.className = item.configured ? 'configured badge' : 'badge';
    if (!item.configured) {
      badge.textContent = '未配置';
    } else if (item.portMismatch) {
      badge.textContent = '已配置，端口号不一致';
    } else {
      badge.textContent = '已配置';
    }
    const title = document.createElement('h3'); title.textContent = item.name;
    const path = document.createElement('p'); path.textContent = item.path ?? '通过 Claude CLI / GUI 接入';
    const note = document.createElement('small');
    note.textContent = item.automatic ? '自动备份并合并现有配置' : '生成可复制的接入命令';
    const button = document.createElement('button');
    button.className = 'solid';
    if (item.automatic) {
      button.textContent = item.configured ? '更新' : '创建并写入';
    } else {
      button.textContent = '生成接入命令';
    }
    button.addEventListener('click', () => void configure(item.id, button));
    article.append(badge, title, path, note, button);
    return article;
  }));
}

function populate(next: DesktopSetupState): void {
  state = next;
  const { setup } = next;
  const activePanel = (document.querySelector<HTMLElement>('.panel.active')?.id.replace('panel-', '') || 'basic') as Panel;
  switchPanel(activePanel);
  $('#existing-config').hidden = setup.needsSetup;
  ($<HTMLSelectElement>('#theme-select')).value = setup.current.theme;
  const radio = document.querySelector<HTMLInputElement>(`input[name="engine"][value="${setup.current.engine}"]`);
  if (radio) radio.checked = true;
  ($<HTMLInputElement>('#database-path')).value = setup.current.databasePath || setup.defaults.databasePath;
  ($<HTMLInputElement>('#knowledge-directory')).value = setup.current.knowledgeDirectory || setup.defaults.knowledgeDirectory;
  ($<HTMLInputElement>('#knowledge-source-id')).value = setup.current.knowledgeSourceId || '';
  $('#knowledge-source-hint').textContent = setup.current.knowledgeSourceId
    ? `当前主源 ID：${setup.current.knowledgeSourceId}。只有 CLI/MCP 路由或多源管理需要识别这个值。`
    : '主源 ID 用于 CLI 和 MCP 路由。普通用户保持自动生成即可。';
  $('#main-source-copy').textContent = setup.current.knowledgeSourceId
    ? `当前主源为 ${setup.current.knowledgeSourceId}；导入默认写入该源，MCP 默认读取该源。`
    : '保存后，原始资料目录会注册为主源；导入默认写入该源，MCP 默认读取该源。';
  const chat = splitModelId(setup.current.chatModel);
  const embedding = splitModelId(setup.current.embeddingModel);
  ($<HTMLSelectElement>('#chat-provider')).value = chat.provider;
  ($<HTMLInputElement>('#chat-model-name')).value = chat.model;
  ($<HTMLSelectElement>('#embedding-provider')).value = embedding.provider === 'zeroentropyai' ? 'zeroentropy' : embedding.provider;
  ($<HTMLInputElement>('#embedding-model-name')).value = embedding.model;
  const chatKey = providerKeyId(chat.provider);
  const embeddingKey = providerKeyId(embedding.provider);
  if (chatKey && chatKey !== '__none__') {
    ($<HTMLInputElement>('#chat-api-key')).value = setup.current.keyValues[chatKey] || '';
  } else {
    ($<HTMLInputElement>('#chat-api-key')).value = '';
  }
  ($<HTMLInputElement>('#chat-api-key')).type = 'password';
  if (embeddingKey && embeddingKey !== '__none__') {
    ($<HTMLInputElement>('#embedding-api-key')).value = setup.current.keyValues[embeddingKey] || '';
  } else {
    ($<HTMLInputElement>('#embedding-api-key')).value = '';
  }
  ($<HTMLInputElement>('#embedding-api-key')).type = 'password';
  syncProviderKeyField('chat');
  syncProviderKeyField('embedding');
  void refreshProviderModels('chat', false);
  void refreshProviderModels('embedding', false);
  $('#chat-model-effective').textContent = setup.current.chatModel ? `当前生效：${setup.current.chatModel}` : '当前未配置';
  $('#embedding-model-effective').textContent = setup.current.embeddingModel ? `当前生效：${setup.current.embeddingModel}` : '当前未配置';
  $('#config-path').textContent = `配置写入：${setup.configPath}`;
  $('#postgres-status').textContent = setup.current.engine === 'postgres' && setup.current.databaseConfigured
    ? '已读取本机 Postgres 连接；留空会继续使用现有地址。'
    : '桌面端只连接数据库，不会自动安装或启动 Docker。';
  renderEngine();
  renderIntegrations(next.integrations);
  renderService(null, next.port);
  $('#save-setup').querySelector('span')!.textContent = saveButtonText();
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function renderUpdate(update: UpdateState | null): void {
  if (!update) return;
  $('#update-current').textContent = `v${update.currentVersion}`;
  $('#update-title').textContent = update.availableVersion ? `PMBrain v${update.availableVersion}` : 'PMBrain Desktop';
  $('#update-message').textContent = update.message;
  $('#previous-version').textContent = update.previousVersion ? `v${update.previousVersion}` : '暂无记录';
  $('#previous-version-note').textContent = update.previousVersion
    ? '点击后打开上一版本的官方 Release 下载页。安装旧版前请先备份数据库；数据库结构不会自动降级。'
    : '升级一次后，桌面端会在这里保留上一版本号。';
  ($<HTMLButtonElement>('#previous-version-action')).disabled = !update.previousVersion;
  const metrics = $('#update-metrics');
  const details = [
    update.fileName ? `文件：${update.fileName}` : '',
    update.transferred !== undefined && update.total !== undefined
      ? `已下载 ${formatBytes(update.transferred)} / ${formatBytes(update.total)}`
      : update.total !== undefined ? `大小：${formatBytes(update.total)}` : '',
    update.bytesPerSecond !== undefined && update.phase === 'downloading'
      ? `速度：${formatBytes(update.bytesPerSecond)}/s`
      : '',
  ].filter(Boolean);
  metrics.textContent = details.join(' · ');
  metrics.hidden = details.length === 0;
  const progress = $('#update-progress');
  progress.hidden = update.phase !== 'downloading' && update.phase !== 'downloaded';
  progress.querySelector<HTMLElement>('i')!.style.width = `${update.percent ?? 0}%`;
  progress.setAttribute('aria-valuenow', String(update.percent ?? 0));
  progress.setAttribute('aria-valuetext', update.message);
  const button = $<HTMLButtonElement>('#update-action');
  const busy = update.phase === 'checking' || update.phase === 'downloading' || update.phase === 'installing';
  button.disabled = busy;
  button.classList.toggle('busy', busy);
  button.dataset.action = update.phase === 'downloaded' ? 'install' : 'check';
  button.querySelector('span')!.textContent = update.phase === 'downloaded' ? '立即安装'
    : update.phase === 'downloading' ? `下载中 ${update.percent ?? 0}%`
      : update.phase === 'checking' ? '正在检查…'
        : update.phase === 'installing' ? '正在安装…' : '检查更新';
}

async function save(): Promise<void> {
  const button = $<HTMLButtonElement>('#save-setup');
  setNotice('error'); setNotice('success');

  // 校验：Chat 厂商不能为空
  const chatProvider = ($<HTMLSelectElement>('#chat-provider')).value;
  if (!chatProvider) {
    setNotice('error', '请选择普通模型厂商');
    return;
  }
  // 校验：Embedding 厂商不能为空
  const embeddingProvider = ($<HTMLSelectElement>('#embedding-provider')).value;
  if (!embeddingProvider) {
    setNotice('error', '请选择向量化模型厂商');
    return;
  }

  // 校验：模型名不能为空
  const chatModelName = ($<HTMLInputElement>('#chat-model-name')).value.trim();
  if (!chatModelName) {
    setNotice('error', '请填写普通模型名称');
    return;
  }
  const embeddingModelName = ($<HTMLInputElement>('#embedding-model-name')).value.trim();
  if (!embeddingModelName) {
    setNotice('error', '请填写向量化模型名称');
    return;
  }

  // 检测向量化模型是否变更（非首次配置）
  if (!state?.setup?.needsSetup && state?.setup?.current?.embeddingModel) {
    const newEmbeddingModel = composeModelId(embeddingProvider, embeddingModelName);
    const oldEmbeddingModel = state.setup.current.embeddingModel;
    if (newEmbeddingModel && oldEmbeddingModel && newEmbeddingModel !== oldEmbeddingModel) {
      if (!confirm(
        `⚠️ 向量化模型已从 "${oldEmbeddingModel}" 改为 "${newEmbeddingModel}"。\n\n` +
        `切换后会清除旧的文本向量并重新向量化，可能耗时并产生 API 费用。\n` +
        `原始文档、页面和分块数据会保留，不会删除知识库内容。\n\n` +
        `确认更改？`
      )) {
        return;
      }
    }
  }

  const keys: SetupPayload['keys'] = {};
  const chatModel = composeModelId(chatProvider, chatModelName);
  const embeddingModel = composeModelId(embeddingProvider, embeddingModelName);
  const chatKey = providerKeyId(chatProvider);
  const embeddingKey = providerKeyId(embeddingProvider);
  // 需要 Key 的厂商才保存 Key
  if (chatKey && chatKey !== '__none__') {
    const chatKeyValue = ($<HTMLInputElement>('#chat-api-key')).value.trim();
    if (!chatKeyValue) {
      setNotice('error', `厂商 ${chatProvider} 需要填写 API Key`);
      return;
    }
    (keys as Record<string, string>)[chatKey] = chatKeyValue;
  }
  if (embeddingKey && embeddingKey !== '__none__') {
    const embeddingKeyValue = ($<HTMLInputElement>('#embedding-api-key')).value.trim();
    if (!embeddingKeyValue) {
      setNotice('error', `厂商 ${embeddingProvider} 需要填写 API Key`);
      return;
    }
    (keys as Record<string, string>)[embeddingKey] = embeddingKeyValue;
  }
  const payload: SetupPayload = {
    engine: selectedEngine(),
    theme: ($<HTMLSelectElement>('#theme-select')).value as DesktopTheme,
    resetAdvancedModelRouting: false,
    databasePath: ($<HTMLInputElement>('#database-path')).value,
    databaseUrl: ($<HTMLInputElement>('#database-url')).value,
    knowledgeDirectory: ($<HTMLInputElement>('#knowledge-directory')).value,
    knowledgeSourceId: ($<HTMLInputElement>('#knowledge-source-id')).value,
    modelConfig: {
      chatModel,
      embeddingModel,
    },
    keys,
  };
  const firstSetup = state?.setup.needsSetup ?? true;
  setSetupWait(
    true,
    firstSetup ? '正在完成首次配置' : '正在保存并重启服务',
    firstSetup
      ? '第一次配置需要初始化数据库、执行迁移并启动服务，可能会比较慢，请耐心等待。请不要关闭窗口或重复点击按钮。'
      : '正在保存配置、执行必要检查并重启 PMBrain，请耐心等待。',
    firstSetup ? '数据库初始化' : '配置保存',
  );
  setBusy(button, true, firstSetup ? '正在首次配置…' : '正在保存并重启…');
  try {
    const next = await window.pmbrainDesktop.saveSetup(payload);
    advancedModelsLoaded = false;
    populate(next);
    setNotice('success', `配置完成，PMBrain 已在 127.0.0.1:${next.port} 启动。`);
    switchPanel('integrations');
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setSetupWait(false);
    setBusy(button, false, saveButtonText());
  }
}

function selectedCredential(): CredentialKind {
  return (document.querySelector<HTMLInputElement>('input[name="credential"]:checked')?.value ?? 'api_key') as CredentialKind;
}

async function configure(client: IntegrationClient, button: HTMLButtonElement): Promise<void> {
  setNotice('error'); setNotice('success');
  button.disabled = true; button.textContent = '正在验证…';
  try {
    const result = await window.pmbrainDesktop.configureIntegration(client, selectedCredential());
    lastResult = result.snippet;
    $('#result-title').textContent = `${client} 配置结果`;
    $('#result-content').textContent = result.snippet;
    const smoke = result.smoke ? `MCP smoke：${result.smoke.toolCount} 个工具，get_stats ${result.smoke.statsOk ? '正常' : '失败'}` : 'OAuth 凭证已创建';
    $('#result-meta').textContent = [
      result.configured && result.path ? `已写入 ${result.path}` : '未自动写入，请复制上方内容',
      result.backup ? `备份：${result.backup}` : '',
      smoke,
    ].filter(Boolean).join(' · ');
    $('#result-console').hidden = false;
    state = await window.pmbrainDesktop.getSetup();
    renderIntegrations(state.integrations);
    setNotice('success', result.configured ? `${client} 已接入 PMBrain。重启客户端后生效。` : `${client} 凭证已生成。`);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    if (client === 'claude') {
      button.textContent = '生成接入命令';
    } else {
      button.textContent = '更新';
    }
  }
}

document.querySelectorAll<HTMLInputElement>('input[name="engine"]').forEach((input) => input.addEventListener('change', renderEngine));
$('#theme-select').addEventListener('change', async () => {
  const theme = ($<HTMLSelectElement>('#theme-select')).value as DesktopTheme;
  try {
    renderTheme(await window.pmbrainDesktop.setTheme(theme));
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  }
});
(['chat', 'embedding'] as const).forEach(kind => {
  $<HTMLSelectElement>(`#${kind}-provider`).addEventListener('change', () => {
    syncProviderKeyField(kind);
    void refreshProviderModels(kind, true);
  });
});
ADVANCED_TIERS.forEach(tier => {
  $<HTMLSelectElement>(`#advanced-${tier}-provider`).addEventListener('change', () => {
    void refreshAdvancedProviderModels(tier, true);
  });
});
document.querySelectorAll<HTMLButtonElement>('.model-picker-trigger').forEach(button => button.addEventListener('click', () => {
  const kind = (button.dataset.modelInput ?? '').startsWith('chat') ? 'chat' : 'embedding';
  const ul = $<HTMLUListElement>(`#${kind}-model-dropdown`);
  if (ul.hidden) {
    renderModelDropdown(kind);
    ul.hidden = false;
  } else {
    ul.hidden = true;
  }
}));
document.querySelectorAll<HTMLButtonElement>('.advanced-model-picker-trigger').forEach(button => button.addEventListener('click', () => {
  const tier = button.dataset.advancedTier as AdvancedModelTier;
  const ul = $<HTMLUListElement>(`#advanced-${tier}-model-dropdown`);
  if (ul.hidden) {
    renderAdvancedModelDropdown(tier);
    ul.hidden = false;
  } else {
    ul.hidden = true;
  }
}));
document.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  if (!target.closest('.model-picker') && !target.closest('.model-dropdown')) {
    document.querySelectorAll<HTMLUListElement>('.model-dropdown').forEach(dropdown => { dropdown.hidden = true; });
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll<HTMLUListElement>('.model-dropdown').forEach(dropdown => { dropdown.hidden = true; });
  }
});
document.querySelectorAll<HTMLButtonElement>('.rail-item').forEach((button) => button.addEventListener('click', () => {
  const target = button.dataset.target as Panel;
  switchPanel(target);
  if (target === 'models' && ($<HTMLDetailsElement>('#advanced-model-settings')).open) {
    void loadAdvancedModels(true);
  }
}));
$('#next-models').addEventListener('click', () => switchPanel('models'));
$('#advanced-model-settings').addEventListener('toggle', () => {
  if (($<HTMLDetailsElement>('#advanced-model-settings')).open) void loadAdvancedModels();
});
document.querySelectorAll<HTMLButtonElement>('.advanced-inherit').forEach(button => button.addEventListener('click', () => {
  const tier = button.dataset.advancedTier as AdvancedModelTier;
  ($<HTMLSelectElement>(`#advanced-${tier}-provider`)).value = '';
  const input = $<HTMLInputElement>(`#advanced-${tier}-model-name`);
  input.value = '';
  input.disabled = true;
  $<HTMLElement>(`#advanced-${tier}-model-status`).textContent = '已恢复跟随当前解析结果。';
}));
$('#save-advanced-models').addEventListener('click', () => void saveAdvancedModels());
document.querySelectorAll<HTMLButtonElement>('.choose').forEach((button) => button.addEventListener('click', async () => {
  const input = $<HTMLInputElement>(`#${button.dataset.input}`);
  const selected = await window.pmbrainDesktop.chooseDirectory(input.value);
  if (selected) input.value = button.dataset.input === 'database-path'
    ? normalizePglitePathForDisplay(selected)
    : selected;
}));
document.querySelectorAll<HTMLButtonElement>('.secret-toggle').forEach((button) => button.addEventListener('click', () => {
  const input = $<HTMLInputElement>(`#${button.dataset.secret}`);
  const shouldShow = input.type === 'password';
  input.type = shouldShow ? 'text' : 'password';
  button.classList.toggle('active', shouldShow);
  button.setAttribute('aria-label', shouldShow ? '隐藏 API Key' : '显示 API Key');
}));
$('#save-setup').addEventListener('click', () => void save());
$('#open-logs').addEventListener('click', () => void window.pmbrainDesktop.openLogs());
$('#open-admin').addEventListener('click', () => void window.pmbrainDesktop.openAdmin());
$('#finish-open-admin').addEventListener('click', () => void window.pmbrainDesktop.openAdmin());
$('#copy-result').addEventListener('click', () => void window.pmbrainDesktop.copy(lastResult));
$('#recovery-retry').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#recovery-retry');
  setBusy(button, true, '正在重启…');
  try { await window.pmbrainDesktop.retry(); } finally { setBusy(button, false, '重新启动服务'); }
});
$('#recovery-logs').addEventListener('click', () => void window.pmbrainDesktop.openLogs());
$('#recovery-settings').addEventListener('click', () => {
  if (state) populate(state);
  switchPanel('basic');
});
const dockerHelp = $<HTMLDialogElement>('#docker-help');
$('#docker-help-open').addEventListener('click', () => dockerHelp.showModal());
$('#docker-help-close').addEventListener('click', () => dockerHelp.close());
$('#docker-help-done').addEventListener('click', () => dockerHelp.close());
$('#docker-copy-command').addEventListener('click', () => void window.pmbrainDesktop.copy($('#docker-command').textContent || ''));
$('#update-action').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#update-action');
  try {
    if (button.dataset.action === 'install') await window.pmbrainDesktop.installUpdate();
    else renderUpdate(await window.pmbrainDesktop.checkUpdates());
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  }
});
$('#previous-version-action').addEventListener('click', () => void window.pmbrainDesktop.openPreviousRelease());

void window.pmbrainDesktop.getTheme().then(renderTheme).catch(() => undefined);
window.pmbrainDesktop.onThemeState(renderTheme);
void window.pmbrainDesktop.getStartupProgress().then(renderStartupProgress).catch(() => undefined);
window.pmbrainDesktop.onStartupProgress(renderStartupProgress);
void window.pmbrainDesktop.getSetup().then(async (next) => {
  populate(next);
  renderService(await window.pmbrainDesktop.getState(), next.port);
}).catch((error) => setNotice('error', String(error)));
window.pmbrainDesktop.onState((service) => renderService(service, service.port));
void window.pmbrainDesktop.getUpdateState().then(renderUpdate);
window.pmbrainDesktop.onUpdateState(renderUpdate);
window.pmbrainDesktop.onShowUpdates(() => switchPanel('updates'));
window.pmbrainDesktop.onShowPanel((panel) => {
  switchPanel(panel);
  if (panel === 'models' && ($<HTMLDetailsElement>('#advanced-model-settings')).open) {
    void loadAdvancedModels(true);
  }
});
