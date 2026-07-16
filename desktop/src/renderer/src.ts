import './style.css';
import type {
  AdvancedModelConfig,
  AdvancedModelTier,
  CredentialKind,
  DesktopCustomProvider,
  DesktopSystemSettingsPayload,
  DesktopSystemSettingsState,
  DesktopSetupState,
  DesktopTheme,
  DesktopThemeState,
  IntegrationClient,
  IntegrationInfo,
  PMBrainDesktopApi,
  SharedAccessContext,
  SharedIntegrationPayload,
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
let latestSystemSettings: DesktopSystemSettingsState | null = null;
let lastResult = '';
let advancedModelsLoaded = false;
let advancedOverrides: Partial<Record<AdvancedModelTier, string>> = {};
let loadedKnowledgeDirectory = '';
let loadedKnowledgeSourceId = '';
let customProviderDraft: DesktopCustomProvider | null = null;
let customProviderTarget: ModelKind | null = null;
const providerModels: Record<'chat' | 'embedding', string[]> = { chat: [], embedding: [] };
const previousProviderSelection: Record<'chat' | 'embedding', string> = { chat: '', embedding: '' };
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

function clearNotices(): void {
  setNotice('error');
  setNotice('success');
}

type Panel = 'basic' | 'models' | 'integrations' | 'system' | 'updates' | 'recovery';

const PANEL_COPY: Record<Panel, { eyebrow: string; title: string }> = {
  basic: { eyebrow: 'DESKTOP SETTINGS / 01', title: '配置数据库、原始资料与主源' },
  models: { eyebrow: 'DESKTOP SETTINGS / 02', title: '配置普通模型与向量模型' },
  integrations: { eyebrow: 'MCP / 03', title: '把 PMBrain 接入 AI 客户端' },
  system: { eyebrow: 'SYSTEM / 04', title: '管理桌面连接与系统行为' },
  updates: { eyebrow: 'UPDATES / 05', title: '保持桌面端安全更新' },
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
  ($<HTMLSelectElement>('#system-theme-select')).value = theme.source;
}

function renderStartupProgress(progress: StartupProgress): void {
  const stages = { database: '数据库准备', migration: '数据库迁移', sidecar: '本地服务启动', health: '健康检查' } as const;
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
  if (normalized === 'custom-openai') return 'customOpenai';
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
  const optional = normalizeProviderForModel(provider) === 'custom-openai';
  input.disabled = local;
  input.placeholder = local ? '本地模型无需 API Key' : optional ? '可选；本地接口通常无需 API Key' : '';
  input.value = keyId && keyId !== '__none__' ? state?.setup.current.keyValues[keyId] || '' : '';
}

function setCustomProviderError(message = ''): void {
  const error = $('#custom-provider-error');
  error.textContent = message;
  error.hidden = !message;
}

function renderCustomProvider(): void {
  document.querySelectorAll<HTMLOptionElement>('option[value="custom-openai"]').forEach(option => {
    option.textContent = customProviderDraft?.displayName || '自定义 OpenAI 接口';
  });
}

function openCustomProvider(target: ModelKind): void {
  customProviderTarget = target;
  const provider = $<HTMLSelectElement>(`#${target}-provider`).value;
  const currentModel = $<HTMLInputElement>(`#${target}-model-name`).value.trim();
  const editingModel = provider === 'custom-openai' && Boolean(currentModel);
  ($<HTMLInputElement>('#custom-provider-name')).value = customProviderDraft?.displayName || '';
  ($<HTMLInputElement>('#custom-provider-base-url')).value = customProviderDraft?.baseUrl || '';
  ($<HTMLInputElement>('#custom-provider-model-id')).value = editingModel ? currentModel : '';
  const targetLabel = target === 'chat' ? '普通模型' : '向量模型';
  $('#custom-provider-title').textContent = `${editingModel ? '编辑' : '添加'}自定义${targetLabel}`;
  $('#custom-provider-target-copy').textContent = target === 'chat'
    ? 'PMBrain 将通过该地址调用 OpenAI 兼容的对话接口。'
    : 'PMBrain 将通过该地址调用 OpenAI 兼容的向量接口。';
  setCustomProviderError();
  const dialog = $<HTMLDialogElement>('#custom-provider-dialog');
  dialog.showModal();
  setTimeout(() => $<HTMLInputElement>(customProviderDraft ? '#custom-provider-model-id' : '#custom-provider-name').focus(), 0);
}

function closeCustomProvider(): void {
  customProviderTarget = null;
  $<HTMLDialogElement>('#custom-provider-dialog').close();
}

function confirmCustomProvider(): void {
  const displayName = ($<HTMLInputElement>('#custom-provider-name')).value.trim();
  const rawBaseUrl = ($<HTMLInputElement>('#custom-provider-base-url')).value.trim();
  const modelId = ($<HTMLInputElement>('#custom-provider-model-id')).value.trim();
  if (!displayName) {
    setCustomProviderError('请填写显示名称，例如“本地 Qwen”。');
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    setCustomProviderError('Base URL 格式无效，请填写完整的 http:// 或 https:// 地址。');
    return;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    setCustomProviderError('Base URL 只能使用 http/https，且不能包含账号、查询参数或锚点。');
    return;
  }
  if (!modelId) {
    setCustomProviderError('请填写模型服务实际提供的模型 ID。');
    return;
  }
  if (!customProviderTarget) {
    setCustomProviderError('未识别要添加到哪一个模型卡片，请关闭后从“＋ 自定义模型”重新进入。');
    return;
  }
  customProviderDraft = {
    id: 'custom-openai',
    displayName,
    baseUrl: rawBaseUrl.replace(/\/+$/, ''),
  };
  const target = customProviderTarget;
  customProviderTarget = null;
  renderCustomProvider();
  $<HTMLDialogElement>('#custom-provider-dialog').close();
  const select = $<HTMLSelectElement>(`#${target}-provider`);
  select.value = 'custom-openai';
  previousProviderSelection[target] = 'custom-openai';
  $<HTMLInputElement>(`#${target}-model-name`).value = modelId;
  providerModels[target] = [modelId];
  renderModelDropdown(target);
  syncProviderKeyField(target);
  void refreshProviderModels(target, false);
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
    status.hidden = true;
    return;
  }

  if (provider === 'custom-openai') {
    if (chooseDefault) input.value = '';
    providerModels[kind] = input.value.trim() ? [input.value.trim()] : [];
    status.textContent = customProviderDraft
      ? `接口：${customProviderDraft.baseUrl}。请输入该接口实际提供的模型 ID。`
      : '请先添加自定义接口并填写 Base URL。';
    status.hidden = false;
    return;
  }

  status.hidden = false;
  status.textContent = provider === 'ollama' ? '正在读取本机 Ollama 模型…' : '正在加载供应商模型…';
  try {
    const result = await window.pmbrainDesktop.getProviderModels(provider, kind);
    if (providerSelect.value !== provider) return;
    providerModels[kind] = result.models;
    if (chooseDefault) input.value = result.models[0] || '';
    if (!($<HTMLUListElement>(`#${kind}-model-dropdown`)).hidden) renderModelDropdown(kind);
    if (result.warning) {
      status.textContent = result.warning;
      status.classList.add('warning');
    } else {
      status.textContent = '';
      status.hidden = true;
    }
  } catch (error) {
    status.textContent = `模型列表加载失败：${error instanceof Error ? error.message : String(error)}`;
    status.classList.add('warning');
    status.hidden = false;
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
    status.hidden = true;
    return;
  }

  status.hidden = false;
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
      status.textContent = '';
      status.hidden = true;
    }
  } catch (error) {
    status.textContent = `模型列表加载失败：${error instanceof Error ? error.message : String(error)}`;
    status.classList.add('warning');
    status.hidden = false;
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
      status.textContent = `${ADVANCED_TIER_LABELS[tier]}需要同时选择供应商和填写模型名称，或点击“跟随普通模型”。`;
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
    } else if (item.id === 'qwenpaw' && item.connectionState === 'connected') {
      badge.textContent = '已连接';
    } else if (item.id === 'qwenpaw' && item.connectionState === 'saved') {
      badge.textContent = '已写入，等待连接';
    } else if (item.portMismatch) {
      badge.textContent = '已配置，端口号不一致';
    } else {
      badge.textContent = '已配置';
    }
    const title = document.createElement('h3'); title.textContent = item.name;
    const path = document.createElement('p'); path.textContent = item.path ?? '通过 Claude CLI / GUI 接入';
    const note = document.createElement('small');
    note.textContent = item.id === 'qwenpaw'
      ? item.connectionState === 'saved'
        ? '配置已写入；尚未连通，请让代理绕过 localhost/127.0.0.1 后重试'
        : '通过本机 API 写入 Bearer 并验证，不使用 OAuth'
      : item.automatic ? '自动备份并合并现有配置' : '生成可复制的接入命令';
    const button = document.createElement('button');
    button.className = 'solid';
    if (item.automatic) {
      button.textContent = item.id === 'qwenpaw' && item.connectionState === 'saved'
        ? '重试连接'
        : item.configured ? '更新' : '创建并写入';
    } else {
      button.textContent = '生成接入命令';
    }
    button.addEventListener('click', () => void configure(item.id, button));
    article.append(badge, title, path, note, button);
    return article;
  }));
}

function selectedNetworkMode(): 'local' | 'shared' {
  return (document.querySelector<HTMLInputElement>('input[name="network-mode"]:checked')?.value ?? 'local') as 'local' | 'shared';
}

function selectedNetworkAddress(): { adapterName?: string; address?: string } {
  const option = $<HTMLSelectElement>('#shared-address').selectedOptions[0];
  return {
    adapterName: option?.dataset.adapter || undefined,
    address: option?.dataset.address || undefined,
  };
}

function renderSelectedAddressNote(): void {
  const option = $<HTMLSelectElement>('#shared-address').selectedOptions[0];
  const note = $('#shared-address-note');
  if (!option?.dataset.address) {
    note.textContent = '请选择真实的 Wi-Fi 或有线网卡。虚拟、VPN 和隧道网卡会明确标记。';
    note.classList.remove('warning');
    return;
  }
  note.textContent = option.dataset.warning
    || '该地址当前可用。PMBrain 会锁定此网卡与 IPv4，不会自动切换。';
  note.classList.toggle('warning', option.dataset.recommended !== 'true');
}

function renderNetworkMode(): void {
  const shared = selectedNetworkMode() === 'shared';
  $('#shared-network-fields').hidden = !shared;
  $('#shared-connection-spine').hidden = !shared;
  $('#network-mode-local-card').classList.toggle('selected', !shared);
  $('#network-mode-shared-card').classList.toggle('selected', shared);
}

function renderSystemSettings(next: DesktopSystemSettingsState): void {
  renderTheme(next.theme);
  const mode = next.preferences.networkMode;
  $<HTMLInputElement>(`#network-mode-${mode}`).checked = true;
  $<HTMLInputElement>('#launch-at-login').checked = next.launchAtLogin;
  $<HTMLSelectElement>('#close-behavior').value = next.preferences.closeBehavior;

  const select = $<HTMLSelectElement>('#shared-address');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = next.networkCandidates.length > 0 ? '请选择网卡与 IPv4' : '没有检测到可用的 IPv4 网卡';
  const options = next.networkCandidates.map((candidate, index) => {
    const option = document.createElement('option');
    option.value = `network-${index}`;
    option.dataset.adapter = candidate.adapterName;
    option.dataset.address = candidate.address;
    option.dataset.recommended = String(candidate.recommended);
    if (candidate.warning) option.dataset.warning = candidate.warning;
    option.textContent = `${candidate.adapterName} · ${candidate.address}${candidate.virtual ? ' · 虚拟/隧道' : candidate.recommended ? ' · 推荐' : ' · 不可用于共享'}`;
    option.disabled = !candidate.recommended;
    option.selected = candidate.adapterName === next.preferences.sharedAdapter && candidate.address === next.preferences.sharedIp;
    return option;
  });
  const selectedAddressIsListed = next.networkCandidates.some((candidate) => (
    candidate.adapterName === next.preferences.sharedAdapter && candidate.address === next.preferences.sharedIp
  ));
  if (!selectedAddressIsListed && next.preferences.sharedAdapter && next.preferences.sharedIp) {
    const unavailable = document.createElement('option');
    unavailable.value = 'network-unavailable';
    unavailable.dataset.adapter = next.preferences.sharedAdapter;
    unavailable.dataset.address = next.preferences.sharedIp;
    unavailable.dataset.recommended = 'false';
    unavailable.dataset.warning = '上次保存的固定网卡或 IPv4 当前不可用。该选择会保留，但共享不会自动恢复；地址恢复后请重新确认并保存。';
    unavailable.textContent = `${next.preferences.sharedAdapter} · ${next.preferences.sharedIp} · 当前不可用（已保留）`;
    unavailable.disabled = true;
    unavailable.selected = true;
    options.unshift(unavailable);
  }
  select.replaceChildren(placeholder, ...options);
  renderNetworkMode();
  renderSelectedAddressNote();
  $('#system-local-url').textContent = next.localMcpUrl || '等待本地服务';
  $('#system-shared-url').textContent = next.sharedMcpUrl || '共享模式未开启';
  const status = $('#gateway-status');
  const statusTitle = status.querySelector('b')!;
  const statusDetail = status.querySelector('small')!;
  const restartButton = $<HTMLButtonElement>('#restart-shared-gateway');
  const gatewayReady = next.preferences.networkMode === 'shared' && next.gateway?.running === true && next.selectedAddressAvailable;
  status.classList.toggle('ready', gatewayReady);
  status.classList.toggle('warning', Boolean(next.warning) || next.preferences.networkMode === 'shared' && !gatewayReady);
  if (gatewayReady) {
    statusTitle.textContent = '局域网 MCP 正在共享';
    statusDetail.textContent = next.sharedMcpUrl || next.gateway?.mcpUrl || '共享网关已启动';
  } else if (next.preferences.networkMode === 'shared') {
    statusTitle.textContent = '共享入口不可用';
    statusDetail.textContent = next.warning || next.gateway?.lastError || '选定的网卡或 IPv4 当前不可用。';
  } else {
    statusTitle.textContent = '仅本机连接';
    statusDetail.textContent = '共享网关未启动，本机 Agent 仍可正常调用。';
  }
  restartButton.hidden = next.preferences.networkMode !== 'shared' || gatewayReady || !next.selectedAddressAvailable;
  $('#system-save-note').textContent = next.warning || '';
  updateSystemSettingsAvailability();
}

function updateSystemSettingsAvailability(): void {
  const button = $<HTMLButtonElement>('#save-system-settings');
  if (state?.setup.needsSetup !== false) {
    button.disabled = true;
    $('#system-save-note').textContent = '请先在“基础配置”完成数据库与知识目录设置，再保存系统设置。';
    return;
  }
  if (!button.classList.contains('busy')) button.disabled = false;
  $('#system-save-note').textContent = latestSystemSettings?.warning || '';
}

function isSharedGatewayReady(next: DesktopSystemSettingsState | null): boolean {
  return next?.preferences.networkMode === 'shared'
    && next.gateway?.running === true
    && next.selectedAddressAvailable;
}

function setSharedControlsDisabled(disabled: boolean): void {
  const controls = document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('.shared-form input, .shared-form select, .shared-form button');
  controls.forEach((control) => {
    if (!disabled && control instanceof HTMLButtonElement && control.classList.contains('busy')) return;
    control.disabled = disabled;
  });
  if (!disabled) {
    $<HTMLSelectElement>('#shared-write-source').disabled = !$<HTMLInputElement>('#shared-can-write').checked;
  }
  document.querySelector('.shared-form')?.setAttribute('aria-disabled', String(disabled));
}

function updateSharedAccessAvailability(): void {
  const hint = $('#shared-mode-hint');
  if (state?.setup.needsSetup !== false) {
    $('#shared-access-form').hidden = true;
    hint.classList.remove('ready');
    hint.textContent = '请先完成基础配置并启动本地服务，再开启局域网共享。';
    return;
  }
  if (isSharedGatewayReady(latestSystemSettings)) {
    if (!$('#shared-access-form').hidden) setSharedControlsDisabled(false);
    return;
  }
  if (!latestSystemSettings?.preferences.sharedIp) {
    $('#shared-access-form').hidden = true;
    hint.classList.remove('ready');
    hint.textContent = '共享模式未开启。请到“系统设置”选择共享模式和固定 IPv4；开启后即可创建和管理成员凭证。';
    return;
  }
  setSharedControlsDisabled(true);
  hint.classList.remove('ready');
  const pauseReason = latestSystemSettings?.preferences.networkMode === 'shared'
    ? latestSystemSettings.warning || latestSystemSettings.gateway?.lastError || '固定网卡或 IPv4 当前不可用，共享操作已暂停；地址恢复后仍需到系统设置重新确认并保存。'
    : '共享模式未开启。请到“系统设置”选择共享模式和固定 IPv4。';
  hint.textContent = `${pauseReason} 已有成员凭证仍可查看和撤销，但不能创建新凭证。`;
}

function applySystemSettingsState(next: DesktopSystemSettingsState, refreshOnRecovery = true): void {
  const wasReady = isSharedGatewayReady(latestSystemSettings);
  latestSystemSettings = next;
  renderSystemSettings(next);
  updateSharedAccessAvailability();
  const integrationsVisible = $('#panel-integrations').classList.contains('active');
  if (refreshOnRecovery && !wasReady && isSharedGatewayReady(next) && integrationsVisible && state?.setup.needsSetup === false) {
    void loadSharedAccess();
  }
}

function sourceLabel(source: SharedAccessContext['sources'][number]): string {
  return source.name === source.id ? source.id : `${source.name} · ${source.id}`;
}

function renderSharedMembers(context: SharedAccessContext): void {
  const list = $('#shared-member-list');
  const active = context.credentials.filter((credential) => credential.status === 'active');
  if (active.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = '还没有共享成员凭证。';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...active.map((credential) => {
    const article = document.createElement('article');
    article.className = 'shared-member-row';
    const copy = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = credential.name;
    const permission = document.createElement('small');
    const readScope = credential.federatedRead.length > 0 ? credential.federatedRead.join('、') : credential.sourceId || context.mainSourceId;
    permission.textContent = `${credential.scope.includes('write') ? '读写' : '只读'} · ${readScope} · ${credential.totalRequests} 次请求`;
    copy.append(title, permission);
    const revoke = document.createElement('button');
    revoke.className = 'ghost danger';
    revoke.textContent = '撤销';
    revoke.setAttribute('aria-label', `撤销 ${credential.name} 的共享凭证`);
    revoke.addEventListener('click', () => void revokeSharedMember(credential.credentialName, credential.name, revoke));
    article.append(copy, revoke);
    return article;
  }));
}

function renderSharedAccess(context: SharedAccessContext): void {
  const ready = isSharedGatewayReady(latestSystemSettings);
  $('#shared-mode-hint').textContent = ready
    ? `共享 MCP：${context.mcpUrl}。凭证只显示一次，请创建后立即复制给对应成员。`
    : `共享入口当前已停止；你仍可查看和撤销已有成员凭证，但恢复共享前不能创建新凭证。上次地址：${context.mcpUrl}`;
  $('#shared-mode-hint').classList.toggle('ready', ready);
  $('#shared-access-form').hidden = false;
  $('#shared-mcp-url').textContent = context.mcpUrl;

  const readableSources = context.sources.filter((source) => !source.archived);
  const readList = $('#shared-read-sources');
  readList.replaceChildren(...readableSources.map((source) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = source.id;
    input.checked = source.id === context.mainSourceId;
    const text = document.createElement('span');
    text.textContent = sourceLabel(source);
    label.append(input, text);
    return label;
  }));

  const writeSource = $<HTMLSelectElement>('#shared-write-source');
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '请选择单一写入知识源';
  writeSource.replaceChildren(placeholder, ...readableSources.map((source) => {
    const option = document.createElement('option');
    option.value = source.id;
    option.textContent = sourceLabel(source);
    option.selected = source.id === context.mainSourceId;
    return option;
  }));
  writeSource.disabled = !$<HTMLInputElement>('#shared-can-write').checked;
  renderSharedMembers(context);
  setSharedControlsDisabled(Boolean(latestSystemSettings) && !isSharedGatewayReady(latestSystemSettings));
}

async function loadSharedAccess(): Promise<boolean> {
  const hint = $('#shared-mode-hint');
  if (state?.setup.needsSetup !== false) {
    updateSharedAccessAvailability();
    return false;
  }
  if (!latestSystemSettings) {
    try {
      applySystemSettingsState(await window.pmbrainDesktop.getSystemSettings(), false);
    } catch (error) {
      hint.classList.remove('ready');
      hint.textContent = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
  if (!latestSystemSettings?.preferences.sharedIp) {
    $('#shared-access-form').hidden = true;
    updateSharedAccessAvailability();
    return false;
  }
  hint.classList.remove('ready');
  hint.textContent = '正在读取共享入口与成员权限…';
  try {
    renderSharedAccess(await window.pmbrainDesktop.getSharedAccess());
    return true;
  } catch (error) {
    setSharedControlsDisabled(true);
    hint.textContent = `${error instanceof Error ? error.message : String(error)} 共享列表未刷新，请先不要重复创建凭证，稍后重新打开本页重试。`;
    return false;
  }
}

async function createSharedMember(): Promise<void> {
  clearNotices();
  const button = $<HTMLButtonElement>('#create-shared-integration');
  const memberName = $<HTMLInputElement>('#shared-member-name').value.trim();
  const canWrite = $<HTMLInputElement>('#shared-can-write').checked;
  const federatedRead = Array.from(document.querySelectorAll<HTMLInputElement>('#shared-read-sources input:checked')).map((input) => input.value);
  const sourceId = $<HTMLSelectElement>('#shared-write-source').value || undefined;
  if (!memberName) {
    setNotice('error', '请填写成员名称。');
    return;
  }
  if (federatedRead.length === 0) {
    setNotice('error', '请至少选择一个允许读取的知识源。');
    return;
  }
  if (canWrite && !sourceId) {
    setNotice('error', '开启写入权限后，需要选择一个写入知识源。');
    return;
  }
  const payload: SharedIntegrationPayload = {
    memberName,
    client: $<HTMLSelectElement>('#shared-client').value as IntegrationClient,
    canWrite,
    ...(canWrite && sourceId ? { sourceId } : {}),
    federatedRead,
  };
  setBusy(button, true, '正在创建…');
  let result: Awaited<ReturnType<PMBrainDesktopApi['createSharedIntegration']>>;
  try {
    result = await window.pmbrainDesktop.createSharedIntegration(payload);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
    setBusy(button, false, '创建凭证并生成配置');
    return;
  }
  lastResult = result.snippet;
  $('#result-title').textContent = `${memberName} 的共享 MCP 配置`;
  $('#result-content').textContent = result.snippet;
  $('#result-meta').textContent = `${result.scopes.includes('write') ? '读写' : '只读'} · ${result.mcpUrl} · 凭证仅本次显示`;
  $<HTMLButtonElement>('#copy-result').hidden = false;
  $('#result-console').hidden = false;
  $<HTMLInputElement>('#shared-member-name').value = '';
  $<HTMLInputElement>('#shared-can-write').checked = false;
  $<HTMLSelectElement>('#shared-write-source').disabled = true;
  const refreshed = await loadSharedAccess();
  setNotice('success', refreshed
    ? `${memberName} 的共享凭证已创建。请立即复制配置并单独发送给该成员。`
    : `${memberName} 的共享凭证已创建，但成员列表刷新失败。请先复制本次配置，不要重复创建；稍后重新打开本页刷新。`);
  setBusy(button, false, '创建凭证并生成配置');
  if (!refreshed) setSharedControlsDisabled(true);
}

async function revokeSharedMember(credentialName: string, displayName: string, button: HTMLButtonElement): Promise<void> {
  clearNotices();
  if (!window.confirm(`确定撤销“${displayName}”的共享凭证吗？撤销后该成员会立即无法连接。`)) return;
  button.disabled = true;
  button.textContent = '撤销中…';
  try {
    renderSharedAccess(await window.pmbrainDesktop.revokeSharedIntegration(credentialName));
    lastResult = '';
    $('#result-title').textContent = `${displayName} 的共享凭证已撤销`;
    $('#result-content').textContent = '';
    $('#result-meta').textContent = '先前显示的 Bearer 凭证已失效，配置内容已从当前窗口清除。';
    $<HTMLButtonElement>('#copy-result').hidden = true;
    $('#result-console').hidden = false;
    setNotice('success', `${displayName} 的共享凭证已撤销。`);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
    button.disabled = false;
    button.textContent = '撤销';
  }
}

function currentSystemSettingsPayload(): DesktopSystemSettingsPayload {
  const mode = selectedNetworkMode();
  const address = selectedNetworkAddress();
  return {
    theme: $<HTMLSelectElement>('#system-theme-select').value as DesktopTheme,
    networkMode: mode,
    sharedAdapter: address.adapterName,
    sharedIp: address.address,
    launchAtLogin: $<HTMLInputElement>('#launch-at-login').checked,
    closeBehavior: $<HTMLSelectElement>('#close-behavior').value as 'tray' | 'quit',
  };
}

async function restartSharedGateway(): Promise<void> {
  clearNotices();
  const button = $<HTMLButtonElement>('#restart-shared-gateway');
  const payload = currentSystemSettingsPayload();
  if (payload.networkMode !== 'shared' || !payload.sharedAdapter || !payload.sharedIp) {
    setNotice('error', '请先选择可用的固定局域网地址。');
    return;
  }
  setBusy(button, true, '正在重启…');
  try {
    const result = await window.pmbrainDesktop.saveSystemSettings(payload);
    applySystemSettingsState(result.state, false);
    if (result.canceled) return;
    if (!result.state.gateway?.running) throw new Error('共享入口仍未启动，请检查固定 IP 与 3131 端口。');
    setNotice('success', `局域网共享已恢复：${result.state.sharedMcpUrl || payload.sharedIp}`);
    await loadSharedAccess();
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(button, false, '重启共享');
  }
}

async function saveSystemSettings(): Promise<void> {
  clearNotices();
  const button = $<HTMLButtonElement>('#save-system-settings');
  const payload = currentSystemSettingsPayload();
  const mode = payload.networkMode;
  const address = { adapterName: payload.sharedAdapter, address: payload.sharedIp };
  if (mode === 'shared' && (!address.adapterName || !address.address)) {
    setNotice('error', '共享模式需要选择固定的网卡和 IPv4 地址。');
    return;
  }
  setBusy(button, true, '正在保存…');
  try {
    const result = await window.pmbrainDesktop.saveSystemSettings(payload);
    applySystemSettingsState(result.state, false);
    if (result.canceled) return;
    if (mode === 'local') {
      setNotice('success', '系统设置已保存，当前仅本机连接。');
    } else if (result.state.gateway?.running) {
      setNotice('success', `共享入口已保存：${result.state.sharedMcpUrl || address.address}`);
      await loadSharedAccess();
    } else {
      setNotice('success', '系统设置已保存；局域网共享仍保持停止，请按页面提示恢复固定网卡或 IPv4 后重新确认。');
    }
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(button, false, '保存系统设置');
    updateSystemSettingsAvailability();
  }
}

function populate(next: DesktopSetupState): void {
  state = next;
  const { setup } = next;
  customProviderDraft = setup.current.customProvider ? { ...setup.current.customProvider } : null;
  renderCustomProvider();
  const activePanel = (document.querySelector<HTMLElement>('.panel.active')?.id.replace('panel-', '') || 'basic') as Panel;
  switchPanel(activePanel);
  $('#existing-config').hidden = setup.needsSetup;
  ($<HTMLSelectElement>('#system-theme-select')).value = setup.current.theme;
  const radio = document.querySelector<HTMLInputElement>(`input[name="engine"][value="${setup.current.engine}"]`);
  if (radio) radio.checked = true;
  ($<HTMLInputElement>('#database-path')).value = setup.current.databasePath || setup.defaults.databasePath;
  ($<HTMLInputElement>('#knowledge-directory')).value = setup.current.knowledgeDirectory || setup.defaults.knowledgeDirectory;
  ($<HTMLInputElement>('#knowledge-source-id')).value = setup.current.knowledgeSourceId || '';
  loadedKnowledgeDirectory = ($<HTMLInputElement>('#knowledge-directory')).value.trim();
  loadedKnowledgeSourceId = ($<HTMLInputElement>('#knowledge-source-id')).value.trim();
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
  previousProviderSelection.chat = ($<HTMLSelectElement>('#chat-provider')).value;
  previousProviderSelection.embedding = ($<HTMLSelectElement>('#embedding-provider')).value;
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
    : '不会安装或新建 Docker；会安全启动已安装的 Docker Desktop 和匹配的现有容器。';
  renderEngine();
  renderIntegrations(next.integrations);
  renderService(null, next.port);
  $('#save-setup').querySelector('span')!.textContent = saveButtonText();
  updateSystemSettingsAvailability();
  updateSharedAccessAvailability();
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

  // 校验：Chat 供应商不能为空
  const chatProvider = ($<HTMLSelectElement>('#chat-provider')).value;
  if (!chatProvider) {
    setNotice('error', '请选择普通模型供应商');
    return;
  }
  // 校验：Embedding 供应商不能为空
  const embeddingProvider = ($<HTMLSelectElement>('#embedding-provider')).value;
  if (!embeddingProvider) {
    setNotice('error', '请选择向量化模型供应商');
    return;
  }
  if ((chatProvider === 'custom-openai' || embeddingProvider === 'custom-openai') && !customProviderDraft) {
    setNotice('error', '请先添加自定义接口并填写 Base URL。');
    openCustomProvider(chatProvider === 'custom-openai' ? 'chat' : 'embedding');
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
  // 需要 Key 的供应商才保存 Key
  if (chatKey && chatKey !== '__none__') {
    const chatKeyValue = ($<HTMLInputElement>('#chat-api-key')).value.trim();
    if (!chatKeyValue && chatProvider !== 'custom-openai') {
      setNotice('error', `供应商 ${chatProvider} 需要填写 API Key`);
      return;
    }
    if (chatKeyValue) (keys as Record<string, string>)[chatKey] = chatKeyValue;
  }
  if (embeddingKey && embeddingKey !== '__none__') {
    const embeddingKeyValue = ($<HTMLInputElement>('#embedding-api-key')).value.trim();
    if (!embeddingKeyValue && embeddingProvider !== 'custom-openai') {
      setNotice('error', `供应商 ${embeddingProvider} 需要填写 API Key`);
      return;
    }
    if (embeddingKeyValue) (keys as Record<string, string>)[embeddingKey] = embeddingKeyValue;
  }
  const knowledgeDirectory = ($<HTMLInputElement>('#knowledge-directory')).value;
  const knowledgeSourceId = ($<HTMLInputElement>('#knowledge-source-id')).value;
  const payload: SetupPayload = {
    engine: selectedEngine(),
    resetAdvancedModelRouting: false,
    databasePath: ($<HTMLInputElement>('#database-path')).value,
    databaseUrl: ($<HTMLInputElement>('#database-url')).value,
    knowledgeDirectory,
    knowledgeSourceId,
    knowledgeSourceChanged: knowledgeDirectory.trim() !== loadedKnowledgeDirectory
      || knowledgeSourceId.trim() !== loadedKnowledgeSourceId,
    modelConfig: {
      chatModel,
      embeddingModel,
    },
    customProvider: customProviderDraft ?? undefined,
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
    void loadSharedAccess();
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
  const originalText = button.textContent || '';
  button.disabled = true; button.textContent = '正在验证…';
  try {
    const result = await window.pmbrainDesktop.configureIntegration(
      client,
      client === 'qwenpaw' ? 'api_key' : selectedCredential(),
    );
    lastResult = result.snippet;
    $('#result-title').textContent = `${client} 配置结果`;
    $('#result-content').textContent = result.snippet;
    $<HTMLButtonElement>('#copy-result').hidden = false;
    state = await window.pmbrainDesktop.getSetup();
    renderIntegrations(state.integrations);
    const refreshedConnection = state.integrations.find(item => item.id === client)?.connectionState
      ?? result.connectionState;
    const smoke = result.smoke ? `MCP smoke：${result.smoke.toolCount} 个工具，get_stats ${result.smoke.statsOk ? '正常' : '失败'}` : 'OAuth 凭证已创建';
    $('#result-meta').textContent = [
      result.configured && result.path ? `已写入 ${result.path}` : '未自动写入，请复制上方内容',
      result.backup ? `备份：${result.backup}` : '',
      client === 'qwenpaw' ? `QwenPaw 连接：${refreshedConnection === 'connected' ? '已验证' : '等待重试'}` : smoke,
    ].filter(Boolean).join(' · ');
    $('#result-console').hidden = false;
    if (client === 'qwenpaw' && refreshedConnection === 'saved') {
      setNotice('error', 'QwenPaw 配置已经写入，但当前尚未连通 PMBrain。请让代理绕过 localhost/127.0.0.1 后点击“重试连接”；不会启动 OAuth。');
    } else {
      setNotice(
        'success',
        result.configured
          ? client === 'qwenpaw'
            ? 'QwenPaw 已接入 PMBrain，并已验证工具列表。'
            : `${client} 已接入 PMBrain。重启客户端后生效。`
          : `${client} 凭证已生成。`,
      );
    }
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

document.querySelectorAll<HTMLInputElement>('input[name="engine"]').forEach((input) => input.addEventListener('change', renderEngine));
document.querySelectorAll<HTMLInputElement>('input[name="network-mode"]').forEach((input) => input.addEventListener('change', renderNetworkMode));
$<HTMLSelectElement>('#shared-address').addEventListener('change', renderSelectedAddressNote);
$<HTMLInputElement>('#shared-can-write').addEventListener('change', () => {
  $<HTMLSelectElement>('#shared-write-source').disabled = !$<HTMLInputElement>('#shared-can-write').checked;
});
(['chat', 'embedding'] as const).forEach(kind => {
  $<HTMLSelectElement>(`#${kind}-provider`).addEventListener('change', () => {
    const select = $<HTMLSelectElement>(`#${kind}-provider`);
    if (select.value === 'custom-openai' && !customProviderDraft) {
      select.value = previousProviderSelection[kind];
      openCustomProvider(kind);
      return;
    }
    previousProviderSelection[kind] = select.value;
    syncProviderKeyField(kind);
    void refreshProviderModels(kind, true);
  });
});
$<HTMLButtonElement>('#add-custom-chat-model').addEventListener('click', () => openCustomProvider('chat'));
$<HTMLButtonElement>('#add-custom-embedding-model').addEventListener('click', () => openCustomProvider('embedding'));
$<HTMLButtonElement>('#custom-provider-close').addEventListener('click', closeCustomProvider);
$<HTMLButtonElement>('#custom-provider-cancel').addEventListener('click', closeCustomProvider);
$<HTMLFormElement>('#custom-provider-form').addEventListener('submit', event => {
  event.preventDefault();
  confirmCustomProvider();
});
$<HTMLDialogElement>('#custom-provider-dialog').addEventListener('close', () => { customProviderTarget = null; });
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
  if (target === 'integrations') void loadSharedAccess();
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
$('#save-system-settings').addEventListener('click', () => void saveSystemSettings());
$('#restart-shared-gateway').addEventListener('click', () => void restartSharedGateway());
$('#create-shared-integration').addEventListener('click', () => void createSharedMember());
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
void window.pmbrainDesktop.getSystemSettings().then((next) => applySystemSettingsState(next)).catch((error) => setNotice('error', String(error)));
window.pmbrainDesktop.onSystemSettingsState((next) => applySystemSettingsState(next));
void window.pmbrainDesktop.getStartupProgress().then(renderStartupProgress).catch(() => undefined);
window.pmbrainDesktop.onStartupProgress(renderStartupProgress);
void window.pmbrainDesktop.getSetup().then(async (next) => {
  populate(next);
  renderService(await window.pmbrainDesktop.getState(), next.port);
  if ($('#panel-integrations').classList.contains('active')) void loadSharedAccess();
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
  if (panel === 'integrations') void loadSharedAccess();
});
