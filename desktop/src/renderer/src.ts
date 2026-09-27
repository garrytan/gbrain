import './style.css';
import type {
  AdvancedModelConfig,
  AdvancedModelPhase,
  AdvancedModelTier,
  AdvancedModelWriteInput,
  CredentialKind,
  DesktopCustomEndpoint,
  DesktopCustomProviderCatalog,
  DesktopCustomProviderSelection,
  DesktopModelConnectionTestInput,
  DesktopModelConnectionTestResult,
  DesktopKnowledgeSourceStatus,
  DesktopSystemSettingsPayload,
  DesktopSystemSettingsState,
  DesktopSetupState,
  DesktopTheme,
  DesktopThemeState,
  IntegrationClient,
  IntegrationInfo,
  IntegrationResult,
  ManagedPostgresDatabase,
  PMBrainDesktopApi,
  DesktopPgliteUpgradeBackupMutation,
  DesktopPgliteUpgradeBackups,
  DesktopToastDiagnoseResult,
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
let advancedPhaseOverrides: Partial<Record<AdvancedModelPhase, string>> = {};
let loadedKnowledgeDirectory = '';
let loadedKnowledgeSourceId = '';
let knowledgeSourceStatusRequest = 0;
let recoveryStatusRequest = 0;
let integrationRefreshRequest = 0;
let integrationChecksComplete = false;
let integrationProbeSidecarReady = false;
let latestIntegrations: IntegrationInfo[] = [];
const INTEGRATION_VERIFICATION_KEY = 'pmbrain.desktop.integration-verification.v1';
type IntegrationVerificationReceipt = { path: string | null; configuredPort?: number };
let integrationVerificationCache = readIntegrationVerificationCache();
let recoveryOwnerPid: number | null = null;
let toastStagingPath: string | null = null;
const CUSTOM_ENDPOINT_PREFIX = 'custom-endpoint-';
let customCatalog: DesktopCustomProviderCatalog = { chat: [], embedding: [] };
let customSelection: DesktopCustomProviderSelection = {};
let customProviderTarget: ModelKind | null = null;
const providerModels: Record<'chat' | 'embedding', string[]> = { chat: [], embedding: [] };
const previousProviderSelection: Record<'chat' | 'embedding', string> = { chat: '', embedding: '' };
const advancedProviderModels: Record<AdvancedModelTier, string[]> = {
  utility: [],
  reasoning: [],
  deep: [],
  subagent: [],
};
const advancedPhaseProviderModels: Record<AdvancedModelPhase, string[]> = {
  synthesize: [],
  synthesize_verdict: [],
  patterns: [],
  extract_atoms: [],
  synthesize_concepts: [],
  consolidate: [],
  conversation_facts_backfill: [],
  propose_takes: [],
  grade_takes: [],
  calibration_profile: [],
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

function setSetupWait(
  visible: boolean,
  title = '',
  message = '',
  stage = '正在处理',
  canDeferEmbeddingRebuild = false,
): void {
  const overlay = $('#setup-wait');
  overlay.hidden = !visible;
  $('#setup-wait-stage').textContent = stage;
  if (title) $('#setup-wait-title').textContent = title;
  if (message) $('#setup-wait-message').textContent = message;
  $('#setup-wait-actions').hidden = !visible || !canDeferEmbeddingRebuild;
}

function clearNotices(): void {
  setNotice('error');
  setNotice('success');
}

type Panel = 'basic' | 'models' | 'integrations' | 'system' | 'updates' | 'repair' | 'recovery';

const PANEL_COPY: Record<Panel, { eyebrow: string; title: string }> = {
  basic: { eyebrow: 'DESKTOP SETTINGS / 01', title: '配置数据库、原始资料与主源' },
  models: { eyebrow: 'DESKTOP SETTINGS / 02', title: '配置普通模型与向量模型' },
  integrations: { eyebrow: 'MCP / 03', title: '把 PMBrain 接入 AI 客户端' },
  system: { eyebrow: 'SYSTEM / 04', title: '管理桌面连接与系统行为' },
  updates: { eyebrow: 'UPDATES / 05', title: '保持桌面端安全更新' },
  repair: { eyebrow: 'REPAIR / 06', title: '软件修复' },
  recovery: { eyebrow: 'RECOVERY', title: '恢复 PMBrain 本地服务' },
};

export function switchPanel(target: Panel, notify = true): void {
  if (notify) window.dispatchEvent(new CustomEvent('pmbrain:settings-panel', { detail: target }));
  document.querySelectorAll('.rail-item').forEach((item) => item.classList.toggle('active', (item as HTMLElement).dataset.target === target));
  document.querySelectorAll('.desktop-settings .panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${target}`));
  const copy = PANEL_COPY[target];
  $('#page-eyebrow').textContent = state?.setup.needsSetup && target === 'basic' ? 'FIRST RUN / 01' : copy.eyebrow;
  $('#page-title').textContent = state?.setup.needsSetup && target === 'basic'
    ? '把 PMBrain 安顿在这台电脑上'
    : copy.title;
}

export function activateSettingsPanel(target: Panel, notify = false): void {
  switchPanel(target, notify);
  if (target === 'models' && ($<HTMLDetailsElement>('#advanced-model-settings')).open) void loadAdvancedModels(true);
  if (target === 'integrations') refreshIntegrationPanel();
  if (target === 'repair') void loadPgliteUpgradeBackups();
}

function renderTheme(theme: DesktopThemeState): void {
  document.documentElement.dataset.theme = theme.resolved;
  ($<HTMLSelectElement>('#system-theme-select')).value = theme.source;
}

function renderStartupProgress(progress: StartupProgress): void {
  const stages = { database: '数据库准备', migration: '数据库迁移', sidecar: '本地服务启动', health: '健康检查' } as const;
  setSetupWait(
    progress.visible,
    progress.title,
    progress.message,
    stages[progress.stage],
    progress.canDeferEmbeddingRebuild === true,
  );
}

function selectedEngine(): 'pglite' | 'postgres' {
  return (document.querySelector<HTMLInputElement>('input[name="engine"]:checked')?.value ?? 'pglite') as 'pglite' | 'postgres';
}

/** Configured engine currently in use (saved), not only the radio draft. */
function configuredEngine(): 'pglite' | 'postgres' {
  return state?.setup.current.engine === 'postgres' ? 'postgres' : 'pglite';
}

function renderDatabaseEngineHint(): void {
  const engine = selectedEngine();
  const hint = $('#database-engine-hint');
  const text = $('#database-engine-hint-text');
  const title = hint.querySelector('b');
  if (engine === 'pglite') {
    hint.classList.remove('ready');
    hint.classList.add('warning');
    if (title) title.textContent = 'PGLite 限制';
    text.textContent =
      'PGLite 是嵌入式单写者数据库：不支持多进程并发写入，也不适合多人同时通过局域网/MCP 使用。' +
      '单机自己用最省事；若有多用户或共享模式需求，请改选 Docker Postgres。';
  } else {
    hint.classList.remove('warning');
    hint.classList.add('ready');
    if (title) title.textContent = '多用户更合适';
    text.textContent =
      'Docker Postgres 支持多连接并发，适合局域网共享、多人 MCP 接入和更大规模知识库。' +
      '请确保本机已有带 pgvector 的 Postgres 容器，并填写正确连接地址。';
  }
}

function renderPgliteSharedWarning(): void {
  const warning = $('#pglite-shared-warning');
  const shared = selectedNetworkMode() === 'shared';
  // Use saved/running engine so the warning matches the actual database, not an unsaved radio draft.
  const show = shared && configuredEngine() === 'pglite';
  warning.hidden = !show;
}

function renderEngine(): void {
  const engine = selectedEngine();
  $('#pglite-fields').hidden = engine !== 'pglite';
  $('#postgres-fields').hidden = engine !== 'postgres';
  $('#mode-pglite-card').classList.toggle('selected', engine === 'pglite');
  $('#mode-postgres-card').classList.toggle('selected', engine === 'postgres');
  renderDatabaseEngineHint();
  renderPgliteSharedWarning();
}

function normalizePglitePathForDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\\/]?brain\.pglite$/i.test(trimmed)) return trimmed;
  const separator = trimmed.endsWith('\\') || trimmed.endsWith('/') ? '' : '\\';
  return `${trimmed}${separator}brain.pglite`;
}

function renderKnowledgeSourceStatus(status: DesktopKnowledgeSourceStatus | null): void {
  const card = $('#knowledge-source-status');
  card.hidden = !status;
  if (!status) return;

  $('#knowledge-source-title').textContent = `主源：${status.sourceName}`;
  $('#knowledge-source-path').textContent = status.path;
  const gitStatus = $('#knowledge-source-git-status');
  gitStatus.textContent = status.gitEnabled
    ? '✓ Git 已启用 · 快速维护会自动同步此目录'
    : '⚠ 未启用 Git，快速维护暂时无法自动同步';
  gitStatus.classList.toggle('ready', status.gitEnabled);
  gitStatus.classList.toggle('warning', !status.gitEnabled);
  $('#enable-knowledge-source-git').hidden = status.gitEnabled;
}

async function refreshKnowledgeSourceStatus(
  inputPath: string,
  reportError = true,
): Promise<void> {
  const path = inputPath.trim();
  const request = ++knowledgeSourceStatusRequest;
  if (!path) {
    renderKnowledgeSourceStatus(null);
    return;
  }

  try {
    const status = await window.pmbrainDesktop.inspectKnowledgeSourceDirectory(path);
    if (request !== knowledgeSourceStatusRequest) return;
    renderKnowledgeSourceStatus(status);
  } catch (error) {
    if (request !== knowledgeSourceStatusRequest) return;
    renderKnowledgeSourceStatus(null);
    if (reportError) setNotice('error', error instanceof Error ? error.message : String(error));
  }
}

function splitModelId(value?: string): { provider: string; model: string } {
  if (!value) return { provider: '', model: '' };
  const index = value.indexOf(':');
  if (index <= 0) return { provider: '', model: value };
  return { provider: value.slice(0, index), model: value.slice(index + 1) };
}

function isCustomEndpointId(value: string): boolean {
  return value === 'custom-openai' || value.startsWith(CUSTOM_ENDPOINT_PREFIX);
}

function recipeProvider(provider: string): string {
  return isCustomEndpointId(provider) ? 'custom-openai' : normalizeProviderForModel(provider);
}

function selectedCustomEndpoint(kind: ModelKind): DesktopCustomEndpoint | undefined {
  const id = customSelection[kind];
  return customCatalog[kind].find(item => item.id === id) ?? customCatalog[kind][0];
}

function normalizeProviderForModel(provider: string): string {
  const trimmed = provider.trim();
  if (isCustomEndpointId(trimmed)) return 'custom-openai';
  return trimmed === 'zeroentropy' ? 'zeroentropyai' : trimmed;
}

type ModelKind = 'chat' | 'embedding';

function providerKeyId(provider: string, kind?: ModelKind): string | null {
  const normalized = normalizeProviderForModel(provider);
  // 本地 provider，不需要 API Key
  if (['ollama', 'llama-server', 'litellm', 'llama-server-reranker'].includes(normalized)) {
    return '__none__';
  }
  if (normalized === 'zeroentropyai') return 'zeroentropy';
  if (normalized === 'custom-openai') {
    return kind === 'embedding' ? 'customOpenaiEmbedding'
      : kind === 'chat' ? 'customOpenaiChat'
        : 'customOpenai';
  }
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

const ADVANCED_TIERS = ['utility', 'reasoning', 'deep', 'subagent'] as const satisfies readonly AdvancedModelTier[];
const ADVANCED_TIER_LABELS: Record<AdvancedModelTier, string> = {
  utility: '轻量任务',
  reasoning: '推理任务',
  deep: '深度任务',
  subagent: '子代理任务',
};
const ADVANCED_PHASES = [
  'synthesize',
  'synthesize_verdict',
  'patterns',
  'extract_atoms',
  'synthesize_concepts',
  'consolidate',
  'conversation_facts_backfill',
  'propose_takes',
  'grade_takes',
  'calibration_profile',
] as const satisfies readonly AdvancedModelPhase[];
const ADVANCED_PHASE_LABELS: Record<AdvancedModelPhase, string> = {
  synthesize: '知识页生成',
  synthesize_verdict: '生成结果判定',
  patterns: '模式发现',
  extract_atoms: '知识原子抽取',
  synthesize_concepts: '概念合成',
  consolidate: '知识合并',
  conversation_facts_backfill: '对话事实回填',
  propose_takes: '观点提炼',
  grade_takes: '观点评价',
  calibration_profile: '校准画像',
};

function advancedPhaseId(phase: AdvancedModelPhase): string {
  return `advanced-phase-${phase}`;
}

function syncAdvancedProviderOptions(): void {
  const selects = [
    ...ADVANCED_TIERS.map(tier => $<HTMLSelectElement>(`#advanced-${tier}-provider`)),
    ...ADVANCED_PHASES.map(phase => $<HTMLSelectElement>(`#${advancedPhaseId(phase)}-provider`)),
  ];
  for (const select of selects) {
    const current = select.value;
    for (const option of Array.from(select.options)) {
      if (isCustomEndpointId(option.value)) option.remove();
    }
    for (const endpoint of customCatalog.chat) {
      const option = document.createElement('option');
      option.value = endpoint.id;
      option.textContent = endpoint.displayName;
      select.append(option);
    }
    if (current && Array.from(select.options).some(option => option.value === current)) {
      select.value = current;
    }
  }
}

function advancedCustomEndpoint(provider: string): DesktopCustomEndpoint | undefined {
  if (!isCustomEndpointId(provider)) return undefined;
  return provider === 'custom-openai'
    ? selectedCustomEndpoint('chat')
    : customCatalog.chat.find(endpoint => endpoint.id === provider);
}

function syncProviderKeyField(kind: ModelKind): void {
  const provider = ($<HTMLSelectElement>(`#${kind}-provider`)).value;
  const input = $<HTMLInputElement>(`#${kind}-api-key`);
  const keyId = providerKeyId(provider, kind);
  const local = keyId === '__none__';
  const optional = normalizeProviderForModel(provider) === 'custom-openai';
  input.disabled = local;
  input.placeholder = local ? '本地模型无需 API Key' : optional ? '可选；本地接口通常无需 API Key' : '';
  input.value = keyId && keyId !== '__none__' ? state?.setup.current.keyValues[keyId] || '' : '';
}

function setCustomProviderError(message = '', field?: HTMLInputElement): void {
  const error = $('#custom-provider-error');
  document.querySelectorAll<HTMLInputElement>('#custom-provider-form input[aria-invalid="true"]')
    .forEach(input => input.removeAttribute('aria-invalid'));
  error.textContent = message;
  error.hidden = !message;
  if (message && field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

function syncCustomProviderOptions(kind: ModelKind): void {
  const select = $<HTMLSelectElement>(`#${kind}-provider`);
  const current = select.value;
  for (const option of Array.from(select.options)) {
    if (isCustomEndpointId(option.value)) option.remove();
  }
  for (const endpoint of customCatalog[kind]) {
    const option = document.createElement('option');
    option.value = endpoint.id;
    option.textContent = endpoint.displayName;
    select.append(option);
  }
  if (current && Array.from(select.options).some(option => option.value === current)) {
    select.value = current;
  }
}

function renderProviderDropdown(kind: ModelKind): void {
  syncCustomProviderOptions(kind);
  const select = $<HTMLSelectElement>(`#${kind}-provider`);
  const ul = $<HTMLUListElement>(`#${kind}-provider-dropdown`);
  ul.replaceChildren(...Array.from(select.options).map(option => {
    const li = document.createElement('li');
    li.dataset.value = option.value;
    if (option.value === select.value) li.classList.add('selected');
    const label = document.createElement('span');
    label.textContent = option.textContent || option.value || (kind === 'chat' ? '请选择供应商' : '暂不启用向量化');
    li.append(label);
    if (option.value.startsWith(CUSTOM_ENDPOINT_PREFIX)) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'provider-delete';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `删除自定义供应商 ${option.textContent || option.value}`);
      remove.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        deleteCustomEndpoint(kind, option.value);
      });
      li.append(remove);
    }
    li.addEventListener('click', () => {
      applyProviderSelection(kind, option.value, option.value.startsWith(CUSTOM_ENDPOINT_PREFIX) ? false : true);
      ul.hidden = true;
    });
    return li;
  }));
}

function toggleProviderDropdown(kind: ModelKind): void {
  const ul = $<HTMLUListElement>(`#${kind}-provider-dropdown`);
  const opening = ul.hidden;
  document.querySelectorAll<HTMLUListElement>('.provider-dropdown').forEach(dropdown => { dropdown.hidden = true; });
  if (!opening) return;
  renderProviderDropdown(kind);
  ul.hidden = false;
}

function applyProviderSelection(kind: ModelKind, value: string, chooseDefault: boolean): void {
  const select = $<HTMLSelectElement>(`#${kind}-provider`);
  select.value = value;
  previousProviderSelection[kind] = value;
  if (isCustomEndpointId(value)) {
    const endpoint = customCatalog[kind].find(item => item.id === value);
    customSelection[kind] = endpoint?.id;
    if (endpoint) {
      $<HTMLInputElement>(`#${kind}-model-name`).value = endpoint.modelId;
      $<HTMLInputElement>(`#${kind}-api-key`).value = endpoint.apiKey || '';
    }
  }
  syncProviderKeyField(kind);
  void refreshProviderModels(kind, chooseDefault);
}

function deleteCustomEndpoint(kind: ModelKind, id: string): void {
  customCatalog = {
    ...customCatalog,
    [kind]: customCatalog[kind].filter(item => item.id !== id),
  };
  const select = $<HTMLSelectElement>(`#${kind}-provider`);
  if (select.value === id || customSelection[kind] === id) {
    customSelection = { ...customSelection, [kind]: undefined };
    applyProviderSelection(kind, '', false);
    $<HTMLInputElement>(`#${kind}-model-name`).value = '';
    $<HTMLInputElement>(`#${kind}-api-key`).value = '';
  }
  renderProviderDropdown(kind);
  syncAdvancedProviderOptions();
}

function snapshotSelectedCustomEndpoints(): void {
  for (const kind of ['chat', 'embedding'] as const) {
    const provider = $<HTMLSelectElement>(`#${kind}-provider`).value;
    if (!isCustomEndpointId(provider)) continue;
    const endpoint = customCatalog[kind].find(item => item.id === provider);
    if (!endpoint) continue;
    endpoint.modelId = $<HTMLInputElement>(`#${kind}-model-name`).value.trim();
    const apiKey = $<HTMLInputElement>(`#${kind}-api-key`).value.trim();
    if (apiKey) endpoint.apiKey = apiKey;
    else delete endpoint.apiKey;
    customSelection[kind] = endpoint.id;
  }
}

function openCustomProvider(target: ModelKind): void {
  customProviderTarget = target;
  ($<HTMLInputElement>('#custom-provider-name')).value = '';
  ($<HTMLInputElement>('#custom-provider-base-url')).value = '';
  ($<HTMLInputElement>('#custom-provider-model-id')).value = '';
  const targetLabel = target === 'chat' ? '普通模型' : '向量模型';
  $('#custom-provider-base-url-label').textContent = `${targetLabel} Base URL`;
  $('#custom-provider-title').textContent = `添加自定义${targetLabel}`;
  $('#custom-provider-target-copy').textContent = target === 'chat'
    ? 'PMBrain 将通过该地址调用 OpenAI 兼容的对话接口。'
    : 'PMBrain 将通过该地址调用 OpenAI 兼容的向量接口。';
  setCustomProviderError();
  const dialog = $<HTMLDialogElement>('#custom-provider-dialog');
  dialog.showModal();
  setTimeout(() => $<HTMLInputElement>('#custom-provider-name').focus(), 0);
}

function closeCustomProvider(): void {
  customProviderTarget = null;
  $<HTMLDialogElement>('#custom-provider-dialog').close();
}

function confirmCustomProvider(): void {
  const displayNameInput = $<HTMLInputElement>('#custom-provider-name');
  const baseUrlInput = $<HTMLInputElement>('#custom-provider-base-url');
  const modelIdInput = $<HTMLInputElement>('#custom-provider-model-id');
  const displayName = displayNameInput.value.trim();
  const rawBaseUrl = baseUrlInput.value.trim();
  const modelId = modelIdInput.value.trim();
  if (!displayName) {
    setCustomProviderError('请填写供应商名称，例如“本地 Qwen”。', displayNameInput);
    return;
  }
  if (!rawBaseUrl) {
    setCustomProviderError('请填写 Base URL。', baseUrlInput);
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    setCustomProviderError('Base URL 格式无效，请填写完整的 http:// 或 https:// 地址。', baseUrlInput);
    return;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    setCustomProviderError('Base URL 只能使用 http/https，且不能包含账号、查询参数或锚点。', baseUrlInput);
    return;
  }
  if (!modelId) {
    setCustomProviderError('请填写模型名称（模型 ID）。', modelIdInput);
    return;
  }
  if (!customProviderTarget) {
    setCustomProviderError('未识别要添加到哪一个模型卡片，请关闭后从“＋ 自定义模型”重新进入。');
    return;
  }
  const target = customProviderTarget;
  const normalizedBaseUrl = rawBaseUrl.replace(/\/+$/, '');
  const endpoint: DesktopCustomEndpoint = {
    id: `${CUSTOM_ENDPOINT_PREFIX}${target}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    displayName,
    baseUrl: normalizedBaseUrl,
    modelId,
  };
  customCatalog = {
    ...customCatalog,
    [target]: [...customCatalog[target], endpoint],
  };
  syncCustomProviderOptions(target);
  customSelection = { ...customSelection, [target]: endpoint.id };
  customProviderTarget = null;
  $<HTMLDialogElement>('#custom-provider-dialog').close();
  applyProviderSelection(target, endpoint.id, false);
  providerModels[target] = [modelId];
  renderModelDropdown(target);
  renderProviderDropdown(target);
  syncAdvancedProviderOptions();
}

function renderModelDropdown(kind: 'chat' | 'embedding'): void {
  const ul = $<HTMLUListElement>(`#${kind}-model-dropdown`);
  const input = $<HTMLInputElement>(`#${kind}-model-name`);
  const provider = $<HTMLSelectElement>(`#${kind}-provider`).value;
  const currentValue = input.value.trim();
  const models = providerModels[kind];
  ul.replaceChildren(...models.map(model => {
    const li = document.createElement('li');
    li.textContent = modelDisplayName(provider, model);
    if (model === currentValue) li.classList.add('selected');
    li.addEventListener('click', () => {
      input.value = model;
      ul.hidden = true;
    });
    return li;
  }));
}

function modelDisplayName(provider: string, model: string): string {
  if (provider === 'deepseek' && model === 'deepseek-flash') return 'DeepSeek-V4.1-Flash';
  if (provider === 'mimo' && model === 'mimo-v2.6-pro') return 'MiMo-V2.6-Pro';
  if (provider === 'mimo' && model === 'mimo-v2.6-flash') return 'MiMo-V2.6-Flash';
  return model;
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

  if (isCustomEndpointId(provider)) {
    const endpoint = customCatalog[kind].find(item => item.id === provider) ?? selectedCustomEndpoint(kind);
    if (chooseDefault) input.value = endpoint?.modelId || '';
    providerModels[kind] = input.value.trim() ? [input.value.trim()] : (endpoint?.modelId ? [endpoint.modelId] : []);
    const baseUrl = endpoint?.baseUrl;
    status.textContent = baseUrl
      ? `接口：${baseUrl}。请输入该接口实际提供的模型 ID。`
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

function expectedEmbeddingDimensions(provider: string, model: string): number | undefined {
  const configured = splitModelId(state?.setup.current.embeddingModel);
  if (!configured.provider || !configured.model || configured.model !== model) return undefined;
  if (recipeProvider(configured.provider) !== provider) return undefined;
  const dimensions = state?.setup.current.embeddingDimensions;
  return typeof dimensions === 'number' && Number.isInteger(dimensions) && dimensions > 0 ? dimensions : undefined;
}

function modelConnectionInput(kind: ModelKind): DesktopModelConnectionTestInput {
  const providerValue = ($<HTMLSelectElement>(`#${kind}-provider`)).value;
  const provider = recipeProvider(providerValue);
  const endpoint = isCustomEndpointId(providerValue)
    ? customCatalog[kind].find(item => item.id === providerValue) ?? selectedCustomEndpoint(kind)
    : undefined;
  const model = ($<HTMLInputElement>(`#${kind}-model-name`)).value.trim();
  return {
    provider,
    baseUrl: endpoint?.baseUrl,
    model,
    apiKey: ($<HTMLInputElement>(`#${kind}-api-key`)).value.trim(),
    ...(kind === 'embedding'
      ? { expectedDimensions: expectedEmbeddingDimensions(provider, model) }
      : {}),
    touchpoint: kind,
  };
}

function renderModelConnectionResult(
  kind: ModelKind | 'ocr',
  result: DesktopModelConnectionTestResult,
): void {
  const status = $<HTMLElement>(`#${kind}-model-load-status`);
  status.classList.remove('ready', 'warning', 'error');
  status.hidden = false;
  if (result.status === 'success') {
    status.classList.add('ready');
    status.textContent = kind === 'embedding'
      ? `✓ 连接成功 · ${result.dimensions} 维 · ${result.durationMs}ms`
      : `✓ 连接成功 · 耗时 ${result.durationMs}ms`;
    return;
  }
  if (result.status === 'warning') {
    status.classList.add('warning');
    status.textContent = `⚠ ${result.message} · ${result.durationMs}ms`;
    return;
  }
  status.classList.add('error');
  status.textContent = `✕ ${result.message}`;
}

async function testConfiguredModel(kind: ModelKind): Promise<void> {
  const button = $<HTMLButtonElement>(`#test-${kind}-model`);
  const status = $<HTMLElement>(`#${kind}-model-load-status`);
  status.classList.remove('ready', 'warning', 'error');
  status.hidden = false;
  const provider = normalizeProviderForModel($<HTMLSelectElement>(`#${kind}-provider`).value);
  status.textContent = provider === 'ollama' || provider === 'llama-server' || provider === 'custom-openai'
    ? '正在测试连接；本地模型首次加载可能需要 1–2 分钟…'
    : '正在测试连接…';
  button.setAttribute('aria-busy', 'true');
  setBusy(button, true);
  try {
    const result = await window.pmbrainDesktop.testModelConnection(modelConnectionInput(kind));
    renderModelConnectionResult(kind, result);
  } catch (error) {
    status.classList.add('error');
    status.textContent = `✕ ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    button.removeAttribute('aria-busy');
    setBusy(button, false);
  }
}

function renderAdvancedModelDropdown(tier: AdvancedModelTier): void {
  const ul = $<HTMLUListElement>(`#advanced-${tier}-model-dropdown`);
  const input = $<HTMLInputElement>(`#advanced-${tier}-model-name`);
  const provider = $<HTMLSelectElement>(`#advanced-${tier}-provider`).value;
  const currentValue = input.value.trim();
  ul.replaceChildren(...advancedProviderModels[tier].map(model => {
    const li = document.createElement('li');
    li.textContent = modelDisplayName(provider, model);
    if (model === currentValue) li.classList.add('selected');
    li.addEventListener('click', () => {
      input.value = model;
      ul.hidden = true;
    });
    return li;
  }));
}

function renderAdvancedPhaseModelDropdown(phase: AdvancedModelPhase): void {
  const prefix = advancedPhaseId(phase);
  const ul = $<HTMLUListElement>(`#${prefix}-model-dropdown`);
  const input = $<HTMLInputElement>(`#${prefix}-model-name`);
  const provider = $<HTMLSelectElement>(`#${prefix}-provider`).value;
  const currentValue = input.value.trim();
  ul.replaceChildren(...advancedPhaseProviderModels[phase].map(model => {
    const li = document.createElement('li');
    li.textContent = modelDisplayName(provider, model);
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

  const endpoint = advancedCustomEndpoint(provider);
  if (endpoint) {
    if (chooseDefault) input.value = endpoint.modelId;
    advancedProviderModels[tier] = endpoint.modelId ? [endpoint.modelId] : [];
    if (!($<HTMLUListElement>(`#advanced-${tier}-model-dropdown`)).hidden) renderAdvancedModelDropdown(tier);
    status.textContent = endpoint.modelId
      ? `自定义普通模型：${endpoint.modelId} · 接口：${endpoint.baseUrl}`
      : '自定义普通模型尚未填写模型 ID。';
    status.hidden = false;
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

async function refreshAdvancedPhaseProviderModels(phase: AdvancedModelPhase, chooseDefault: boolean): Promise<void> {
  const prefix = advancedPhaseId(phase);
  const providerSelect = $<HTMLSelectElement>(`#${prefix}-provider`);
  const provider = providerSelect.value;
  const input = $<HTMLInputElement>(`#${prefix}-model-name`);
  const status = $<HTMLElement>(`#${prefix}-model-status`);
  input.disabled = !provider;
  status.classList.remove('warning');
  if (!provider) {
    advancedPhaseProviderModels[phase] = [];
    status.textContent = '';
    status.hidden = true;
    return;
  }

  const endpoint = advancedCustomEndpoint(provider);
  if (endpoint) {
    if (chooseDefault) input.value = endpoint.modelId;
    advancedPhaseProviderModels[phase] = endpoint.modelId ? [endpoint.modelId] : [];
    if (!($<HTMLUListElement>(`#${prefix}-model-dropdown`)).hidden) renderAdvancedPhaseModelDropdown(phase);
    status.textContent = endpoint.modelId
      ? `自定义普通模型：${endpoint.modelId} · 接口：${endpoint.baseUrl}`
      : '自定义普通模型尚未填写模型 ID。';
    status.hidden = false;
    return;
  }

  status.hidden = false;
  status.textContent = '正在加载模型列表…';
  try {
    const result = await window.pmbrainDesktop.getProviderModels(provider, 'chat');
    if (providerSelect.value !== provider) return;
    advancedPhaseProviderModels[phase] = result.models;
    if (chooseDefault) input.value = result.models[0] || '';
    if (!($<HTMLUListElement>(`#${prefix}-model-dropdown`)).hidden) renderAdvancedPhaseModelDropdown(phase);
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
  syncAdvancedProviderOptions();
  for (const tier of ADVANCED_TIERS) {
    const entry = config.tiers[tier];
    const override = splitModelId(entry.override);
    const provider = override.provider === 'custom-openai'
      ? (customCatalog.chat.find(item => item.id === customSelection.chat)?.id
        || customCatalog.chat.find(item => item.modelId === override.model)?.id
        || customCatalog.chat[0]?.id
        || '')
      : override.provider;
    ($<HTMLSelectElement>(`#advanced-${tier}-provider`)).value = provider;
    const input = $<HTMLInputElement>(`#advanced-${tier}-model-name`);
    input.value = override.model;
    input.disabled = !provider;
    advancedOverrides[tier] = entry.override;
    $(`#advanced-${tier}-effective`).textContent = entry.resolved
      ? `当前解析：${entry.resolved}${entry.source ? ` · 来源 ${entry.source}` : ''}`
      : '当前没有可用路由';
  }
  for (const phase of ADVANCED_PHASES) {
    const entry = config.phases[phase];
    const prefix = advancedPhaseId(phase);
    const override = splitModelId(entry.override);
    const provider = override.provider === 'custom-openai'
      ? (customCatalog.chat.find(item => item.id === customSelection.chat)?.id
        || customCatalog.chat.find(item => item.modelId === override.model)?.id
        || customCatalog.chat[0]?.id
        || '')
      : override.provider;
    ($<HTMLSelectElement>(`#${prefix}-provider`)).value = provider;
    const input = $<HTMLInputElement>(`#${prefix}-model-name`);
    input.value = override.model;
    input.disabled = !provider;
    advancedPhaseOverrides[phase] = entry.override;
    $(`#${prefix}-effective`).textContent = entry.resolved
      ? `当前解析：${entry.resolved}${entry.source ? ` · 来源 ${entry.source}` : ''}`
      : '当前没有可用路由';
  }
}

async function loadAdvancedModels(force = false): Promise<void> {
  const button = $<HTMLButtonElement>('#save-advanced-models');
  const status = $('#advanced-model-status');
  if (advancedModelsLoaded && !force) return;
  if (state?.setup.needsSetup) {
    status.textContent = '请先保存基础配置，再读取和设置任务层级与 Dream 阶段路由。';
    button.disabled = true;
    return;
  }
  syncAdvancedProviderOptions();
  status.textContent = '正在读取当前高级路由…';
  button.disabled = true;
  try {
    const config = await window.pmbrainDesktop.getAdvancedModelConfig();
    renderAdvancedModelConfig(config);
    await Promise.all([
      ...ADVANCED_TIERS.map(tier => refreshAdvancedProviderModels(tier, false)),
      ...ADVANCED_PHASES.map(phase => refreshAdvancedPhaseProviderModels(phase, false)),
    ]);
    advancedModelsLoaded = true;
    status.textContent = '只保存你在这里明确修改的覆盖；保存上方基础配置不会清空高级路由。';
    button.disabled = false;
  } catch (error) {
    status.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

async function saveAdvancedModels(): Promise<void> {
  const button = $<HTMLButtonElement>('#save-advanced-models');
  const status = $('#advanced-model-status');
  const values: AdvancedModelWriteInput = { tiers: {}, phases: {} };
  for (const tier of ADVANCED_TIERS) {
    const provider = ($<HTMLSelectElement>(`#advanced-${tier}-provider`)).value;
    const model = ($<HTMLInputElement>(`#advanced-${tier}-model-name`)).value.trim();
    if ((provider && !model) || (!provider && model)) {
      status.textContent = `${ADVANCED_TIER_LABELS[tier]}需要同时选择供应商和填写模型名称，或点击“跟随普通模型”。`;
      return;
    }
    const next = composeModelId(provider, model);
    if (next !== (advancedOverrides[tier] ?? '')) values.tiers![tier] = next;
  }
  for (const phase of ADVANCED_PHASES) {
    const prefix = advancedPhaseId(phase);
    const provider = ($<HTMLSelectElement>(`#${prefix}-provider`)).value;
    const model = ($<HTMLInputElement>(`#${prefix}-model-name`)).value.trim();
    if ((provider && !model) || (!provider && model)) {
      status.textContent = `${ADVANCED_PHASE_LABELS[phase]}需要同时选择供应商和填写模型名称，或点击“跟随任务层级”。`;
      return;
    }
    const next = composeModelId(provider, model);
    if (next !== (advancedPhaseOverrides[phase] ?? '')) values.phases![phase] = next;
  }
  const tierCount = Object.keys(values.tiers ?? {}).length;
  const phaseCount = Object.keys(values.phases ?? {}).length;
  if (tierCount === 0 && phaseCount === 0) {
    status.textContent = '高级路由没有修改。';
    return;
  }
  if (tierCount === 0) delete values.tiers;
  if (phaseCount === 0) delete values.phases;
  setBusy(button, true, '正在保存…');
  status.textContent = '正在保存高级路由；如 PGLite 正在使用，桌面端会安全重启本地服务。';
  try {
    renderAdvancedModelConfig(await window.pmbrainDesktop.saveAdvancedModelConfig(values));
    await Promise.all([
      ...ADVANCED_TIERS.map(tier => refreshAdvancedProviderModels(tier, false)),
      ...ADVANCED_PHASES.map(phase => refreshAdvancedPhaseProviderModels(phase, false)),
    ]);
    advancedModelsLoaded = true;
    status.textContent = '高级路由已保存；未修改的层级与阶段不会被清空。';
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
  const sidecarReady = service?.phase === 'ready';
  if (sidecarReady && !integrationProbeSidecarReady) {
    integrationChecksComplete = false;
    refreshIntegrationPanel();
  }
  if (service && !sidecarReady) integrationProbeSidecarReady = false;
  else if (sidecarReady) integrationProbeSidecarReady = true;
  $('#service-label').textContent = ready ? '服务已就绪'
    : service?.phase === 'starting' ? '正在启动'
      : service?.phase === 'failed' ? '启动失败' : '等待配置';
  $('#service-detail').textContent = service?.port ? `127.0.0.1:${service.port}` : port ? `127.0.0.1:${port}` : 'LOCAL';
  ($<HTMLButtonElement>('#open-admin')).disabled = !ready;
  if (service?.phase === 'starting') {
    setSetupWait(
      true,
      '正在等待本地服务健康检查',
      'PMBrain 已启动 sidecar，正在打开数据库并完成升级迁移；较大知识库可能需要几分钟，请不要关闭窗口。',
      '健康检查',
    );
  } else if (service?.phase === 'ready' || service?.phase === 'failed') {
    setSetupWait(false);
  }
  if (service?.phase === 'failed' && state && !state.setup.needsSetup) {
    $('#recovery-message').textContent = service.message || 'PMBrain 服务启动失败，请重试或查看日志。';
    $('#recovery-toast').hidden = !isToastCorruptFailure(service);
    switchPanel('recovery');
    void refreshPgliteRecoveryStatus();
  } else if (service?.phase !== 'failed') {
    recoveryOwnerPid = null;
    $<HTMLButtonElement>('#recovery-terminate').hidden = true;
    $('#recovery-owner').hidden = true;
    $('#recovery-toast').hidden = true;
  }
}

function isToastCorruptFailure(service: SidecarState | null): boolean {
  if (!service || service.phase !== 'failed') return false;
  if (service.category === 'toast_corrupt') return true;
  const text = `${service.message ?? ''} ${service.categoryLabelZh ?? ''}`;
  return /大字段|toast value|pg_toast_/i.test(text);
}

function formatToastDiagnose(result: DesktopToastDiagnoseResult): string {
  const parts = [`诊断结果：${result.status}`];
  if (result.table) parts.push(`损坏位置：${result.table}${result.column ? '.' + result.column : ''}`);
  if (result.recommendedAction) parts.push(result.recommendedAction);
  if (result.error) parts.push(result.error);
  if (result.canAutoRepair) parts.push('可以在副本上修复后替换。知识页、Wiki、Facts 不会删除。');
  else parts.push('不能自动替换当前库。请使用升级备份恢复，或查看日志。');
  return parts.join('\n');
}

async function diagnoseToast(source: 'recovery' | 'repair'): Promise<void> {
  const diagnoseBtn = $<HTMLButtonElement>(source === 'recovery' ? '#recovery-toast-diagnose' : '#repair-toast-diagnose');
  const replaceBtn = $<HTMLButtonElement>(source === 'recovery' ? '#recovery-toast-replace' : '#repair-toast-replace');
  const resultEl = $(source === 'recovery' ? '#recovery-toast-result' : '#repair-toast-result');
  setBusy(diagnoseBtn, true, '正在诊断…');
  replaceBtn.hidden = true;
  try {
    const result = await window.pmbrainDesktop.diagnosePgliteToast();
    toastStagingPath = result.stagingPath || null;
    resultEl.hidden = false;
    resultEl.textContent = formatToastDiagnose(result);
    replaceBtn.hidden = !(result.canAutoRepair && toastStagingPath);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(diagnoseBtn, false, source === 'recovery' ? '在副本上诊断修复' : '在副本上诊断');
  }
}

async function replaceToast(source: 'recovery' | 'repair'): Promise<void> {
  if (!toastStagingPath) return;
  if (!confirm(
    '确认用修复副本替换当前知识库？\n\n只会去掉没有对应知识页的搜索分块。知识页、Wiki、Facts 和原始资料不会删除。\n\n当前库会先改名留底，失败会自动退回原库。',
  )) return;
  const replaceBtn = $<HTMLButtonElement>(source === 'recovery' ? '#recovery-toast-replace' : '#repair-toast-replace');
  setBusy(replaceBtn, true, '正在替换…');
  try {
    const result = await window.pmbrainDesktop.replacePgliteToastRepair(toastStagingPath);
    if (result.status !== 'replaced') {
      setNotice('error', result.error || '副本修复未完成，当前库未被替换。');
      return;
    }
    setNotice('success', `已替换当前库。Pages ${result.pages ?? '—'} / Chunks ${result.chunks ?? '—'}。原库已留底。`);
    await window.pmbrainDesktop.retry();
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(replaceBtn, false, '确认替换当前库');
  }
}

async function refreshPgliteRecoveryStatus(): Promise<void> {
  const request = ++recoveryStatusRequest;
  const button = $<HTMLButtonElement>('#recovery-terminate');
  const owner = $('#recovery-owner');
  recoveryOwnerPid = null;
  button.hidden = true;
  owner.hidden = true;
  try {
    const status = await window.pmbrainDesktop.getPgliteRecoveryStatus();
    if (request !== recoveryStatusRequest) return;
    if (status.canTerminate && status.pid) {
      recoveryOwnerPid = status.pid;
      button.hidden = false;
      owner.textContent = `已确认 ${status.commandLabel ?? 'PMBrain 占用进程'}（PID ${status.pid}）仍在占用本机数据库。`;
      owner.hidden = false;
    }
  } catch {
    // Recovery remains usable through retry and logs when owner inspection is unavailable.
  }
}

function renderIntegrations(integrations: IntegrationInfo[]): void {
  const ordered = integrations
    .map((item, index) => ({ item, index }))
    .sort((left, right) => Number(right.item.configured) - Number(left.item.configured)
      || (left.item.defaultOrder ?? left.index) - (right.item.defaultOrder ?? right.index))
    .map(({ item }) => item);
  latestIntegrations = ordered;
  const grid = $('#integration-grid');
  grid.replaceChildren(...ordered.map((item) => {
    const article = document.createElement('article');
    article.className = 'integration-card';
    const badge = document.createElement('span');
    badge.className = !item.configured
      ? 'badge'
      : item.connectionState === 'invalid'
        ? 'invalid badge'
        : item.portMismatch ? 'attention badge' : 'configured badge';
    if (!item.configured) {
      badge.textContent = '未配置';
    } else if (item.connectionState === 'invalid') {
      badge.textContent = '接入失效';
    } else if (item.portMismatch) {
      badge.textContent = '端口需更新';
    } else if (item.connectionState === 'connected') {
      badge.textContent = '接入可用';
    } else if (item.connectionState === 'saved') {
      badge.textContent = '已写入，等待连接';
    } else {
      badge.textContent = '待验证';
    }
    const title = document.createElement('h3'); title.textContent = item.name;
    const path = document.createElement('p');
    path.textContent = item.path
      ?? (item.id === 'claude' ? '通过 Claude CLI / GUI 接入' : '通过客户端 MCP 配置接入');
    const note = document.createElement('small');
    note.textContent = item.connectionState === 'invalid'
      ? '现有凭证已失效。重新生成凭证后再重启客户端。'
      : item.portMismatch
        ? '配置仍指向旧端口，请更新连接后重启客户端。'
      : item.id === 'qwenpaw'
      ? item.connectionState === 'saved'
        ? '配置已写入；尚未连通，请让代理绕过 localhost/127.0.0.1 后重试'
        : '通过本机 API 写入 Bearer 并验证，不使用 OAuth'
      : item.connectionState === 'connected'
        ? '配置文件存在，凭证已通过 PMBrain 验证。'
      : item.configured
        ? '配置文件存在，但本次连接验证尚未完成；后台确认后会显示“接入可用”或“接入失效”。'
      : item.automatic
        ? '自动备份并合并现有配置；连接状态在后台验证。'
        : item.id === 'claude' ? '生成可复制的接入命令' : '生成可复制的接入配置';
    const button = document.createElement('button');
    button.className = 'solid';
    if (item.automatic) {
      button.textContent = item.connectionState === 'invalid'
        ? '重新生成凭证'
        : item.id === 'qwenpaw' && item.connectionState === 'saved'
        ? '重试连接'
        : item.configured ? '更新连接' : '接入';
    } else {
      button.textContent = item.id === 'claude' ? '生成接入命令' : '生成接入配置';
    }
    button.addEventListener('click', () => void configure(item.id, button));
    article.append(badge, title, path, note);
    const actions = document.createElement('div');
    actions.className = 'integration-actions';
    actions.append(button);
    if (item.id === 'workbuddy' && item.configured) {
      const agentButton = document.createElement('button');
      agentButton.textContent = '深度接入';
      agentButton.addEventListener('click', () => void writeWorkbuddyUserAgent(agentButton));
      actions.append(agentButton);
    }
    if (['codex','claude','grok'].includes(item.id)) {
      const deep = document.createElement('button'); deep.type = 'button'; deep.textContent = '深度接入';
      deep.addEventListener('click', () => void configure(item.id, deep, true));
      actions.append(deep);
    }
    if (item.launchAvailable) {
      const launchButton = document.createElement('button');
      launchButton.type = 'button';
      launchButton.className = 'integration-launch';
      const launchIcon = document.createElement('i');
      launchIcon.className = 'integration-launch-icon';
      launchIcon.setAttribute('aria-hidden', 'true');
      const launchLabel = document.createElement('span');
      launchLabel.textContent = '启动';
      launchButton.append(launchIcon, launchLabel);
      launchButton.addEventListener('click', () => void launchIntegration(item.id, launchButton));
      actions.append(launchButton);
    }
    article.append(actions);
    if (['codex','claude','grok'].includes(item.id)) {
      const actionHelp = document.createElement('small');
      actionHelp.className = 'integration-action-help';
      actionHelp.textContent = '更新连接只更新 MCP；深度接入还会安装自动记忆规则。';
      article.appendChild(actionHelp);
    }
    return article;
  }));
}

function renderDockerDatabases(databases: ManagedPostgresDatabase[]): void {
  const select = $<HTMLSelectElement>('#database-instance');
  const databaseUrl = $<HTMLInputElement>('#database-url');
  select.replaceChildren();
  let selected = false;
  for (const database of databases) {
    const option = document.createElement('option');
    option.value = database.containerName;
    const status = database.status === 'stopped' ? '已停止' : '运行中';
    option.textContent = `${database.current ? '当前使用 · ' : ''}${database.containerName} · ${status} · ${database.displayAddress}`;
    option.dataset.databaseUrl = database.databaseUrl;
    option.dataset.status = database.status;
    option.dataset.displayAddress = database.displayAddress;
    option.selected = database.current;
    selected ||= database.current;
    select.append(option);
  }
  const manual = document.createElement('option');
  manual.value = '__manual__';
  manual.textContent = databases.length > 0 ? '手动填写其他 Postgres 地址' : '未发现可用 PMBrain 数据库，可手动填写地址';
  manual.selected = !selected;
  select.append(manual);
  const active = select.selectedOptions[0];
  if (active?.dataset.databaseUrl) databaseUrl.value = active.dataset.databaseUrl;
  select.disabled = false;
  const stopped = databases.filter(database => database.status === 'stopped').length;
  $('#postgres-status').textContent = databases.length > 0
    ? `发现 ${databases.length} 个 PMBrain 数据库${stopped > 0 ? `，其中 ${stopped} 个已停止，选择时会先启动并校验` : ''}；确认后点击“保存修改并重启”完成切换。`
    : 'Docker 中没有发现通过 PMBrain 核心表和连接校验的数据库；也可以手动填写地址。';
}

async function refreshDockerDatabases(): Promise<void> {
  if (selectedEngine() !== 'postgres') return;
  const select = $<HTMLSelectElement>('#database-instance');
  select.disabled = true;
  select.replaceChildren(new Option('正在检查 Docker 中可用的 PMBrain 数据库…', ''));
  $('#postgres-status').textContent = '正在检查 Docker 容器、数据库连接和 PMBrain 核心表…';
  try {
    renderDockerDatabases(await window.pmbrainDesktop.listDockerDatabases());
  } catch (error) {
    renderDockerDatabases([]);
    $('#postgres-status').textContent = error instanceof Error ? error.message : String(error);
  }
}

async function selectDockerDatabase(select: HTMLSelectElement): Promise<void> {
  const option = select.selectedOptions[0];
  if (!option?.dataset.databaseUrl) return;
  if (option.dataset.status !== 'stopped') {
    $<HTMLInputElement>('#database-url').value = option.dataset.databaseUrl;
    return;
  }

  select.disabled = true;
  $('#postgres-status').textContent = `正在启动 ${option.value}，等待 Postgres 就绪并校验 PMBrain 核心表…`;
  try {
    const database = await window.pmbrainDesktop.activateDockerDatabase(option.value);
    option.dataset.databaseUrl = database.databaseUrl;
    option.dataset.status = database.status;
    option.textContent = `${database.containerName} · 运行中 · ${database.displayAddress}`;
    $<HTMLInputElement>('#database-url').value = database.databaseUrl;
    $('#postgres-status').textContent = `${database.containerName} 已启动并通过 PMBrain 数据库校验；点击“保存修改并重启”完成切换。`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await refreshDockerDatabases();
    $('#postgres-status').textContent = message;
  } finally {
    select.disabled = false;
  }
}

function readIntegrationVerificationCache(): Partial<Record<IntegrationClient, IntegrationVerificationReceipt>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(INTEGRATION_VERIFICATION_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeIntegrationVerificationCache(): void {
  try {
    localStorage.setItem(INTEGRATION_VERIFICATION_KEY, JSON.stringify(integrationVerificationCache));
  } catch {
    integrationVerificationCache = {};
  }
}

function restoreLastVerifiedIntegrations(integrations: IntegrationInfo[]): IntegrationInfo[] {
  return integrations.map(item => {
    if (!item.configured || item.connectionState || item.portMismatch) return item;
    const receipt = integrationVerificationCache[item.id];
    return receipt && receipt.path === item.path && receipt.configuredPort === item.configuredPort
      ? { ...item, connectionState: 'connected' }
      : item;
  });
}

function recordIntegrationVerification(integrations: IntegrationInfo[]): void {
  for (const item of integrations) {
    if (item.configured && item.connectionState === 'connected') {
      integrationVerificationCache[item.id] = { path: item.path, configuredPort: item.configuredPort };
    } else {
      delete integrationVerificationCache[item.id];
    }
  }
  writeIntegrationVerificationCache();
}

async function refreshIntegrations(probe: boolean): Promise<IntegrationInfo[]> {
  const request = ++integrationRefreshRequest;
  const received = await window.pmbrainDesktop.getIntegrations(probe);
  const integrations = probe ? received : restoreLastVerifiedIntegrations(received);
  if (request !== integrationRefreshRequest) return integrations;
  if (probe) {
    const checkable = integrations.filter(item => item.configured && item.id !== 'hermes' && item.id !== 'openclaw');
    integrationChecksComplete = checkable.every(item => item.connectionState !== undefined);
    recordIntegrationVerification(integrations);
  }
  if (state) state.integrations = integrations;
  renderIntegrations(integrations);
  return integrations;
}

function refreshIntegrationPanel(): void {
  void refreshIntegrations(false)
    .then(() => refreshIntegrations(true))
    .catch(() => undefined);
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
  renderPgliteSharedWarning();
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

function applySystemSettingsState(next: DesktopSystemSettingsState): void {
  latestSystemSettings = next;
  renderSystemSettings(next);
  void refreshMemoryWriteback();
}

let loadedMemoryMode: 'off' | 'salient' | 'all' | null = null;
let memoryModeUserChanged = false;
let memoryModeChangeRequest = 0;

function selectedMemoryMode(): 'off' | 'salient' | 'all' | undefined {
  return document.querySelector<HTMLInputElement>('input[name="memory-writeback"]:checked')?.value as 'off' | 'salient' | 'all' | undefined;
}

function renderMemoryMode(): void {
  document.querySelectorAll<HTMLLabelElement>('#memory-mode-off-card, #memory-mode-salient-card, #memory-mode-all-card').forEach((card) => {
    card.classList.toggle('selected', card.querySelector('input')?.checked === true);
  });
}

function selectMemoryMode(mode: 'off' | 'salient' | 'all'): void {
  const selected = document.querySelector<HTMLInputElement>(`input[name="memory-writeback"][value="${mode}"]`);
  if (selected) selected.checked = true;
  renderMemoryMode();
}

function showMemorySetupHint(title: string, detail: string): void {
  $('#memory-setup-title').textContent = title;
  $('#memory-setup-detail').textContent = detail;
  $('#memory-setup-hint').hidden = false;
}

function hideMemorySetupHint(): void {
  $('#memory-setup-hint').hidden = true;
}

function memoryIntegrationReady(): boolean {
  return latestIntegrations.some(item => (
    ['workbuddy', 'codex', 'claude', 'grok'].includes(item.id)
    && item.configured
    && !item.portMismatch
    && item.connectionState === 'connected'
  ));
}

async function handleMemoryModeChange(input: HTMLInputElement): Promise<void> {
  const request = ++memoryModeChangeRequest;
  const mode = input.value as 'off' | 'salient' | 'all';
  memoryModeUserChanged = true;
  renderMemoryMode();
  if (mode === 'off') {
    hideMemorySetupHint();
    return;
  }
  if (!integrationChecksComplete) {
    showMemorySetupHint('正在检查 MCP 接入', '正在验证 WorkBuddy、Codex、Claude Code 和 Grok Build 的本机连接。');
    try {
      await refreshIntegrations(true);
    } catch {
      integrationChecksComplete = false;
    }
    if (request !== memoryModeChangeRequest) return;
  }
  if (!memoryIntegrationReady()) {
    memoryModeUserChanged = false;
    selectMemoryMode(loadedMemoryMode ?? 'off');
    showMemorySetupHint(
      '请先完成 MCP 接入',
      '请先到“MCP 接入”更新至少一个 AI 客户端，验证连接后再开启长期记忆。',
    );
    return;
  }
  hideMemorySetupHint();
}

function memoryModeDirty(): boolean {
  const pending = selectedMemoryMode();
  return pending !== undefined && loadedMemoryMode !== null && pending !== loadedMemoryMode;
}

async function refreshMemoryWriteback(): Promise<void> {
  const statusEl = $('#memory-agent-status');
  const sharedWarn = $('#memory-shared-warning');
  try {
    const state = await window.pmbrainDesktop.getMemoryWriteback();
    const pending = selectedMemoryMode();
    const unsaved = memoryModeUserChanged && pending !== undefined && pending !== state.mode;
    if (!unsaved) {
      loadedMemoryMode = state.mode;
      memoryModeUserChanged = false;
      selectMemoryMode(state.mode);
    } else if (loadedMemoryMode === null) {
      loadedMemoryMode = state.mode;
    }
    sharedWarn.hidden = latestSystemSettings?.preferences.networkMode !== 'shared';
    statusEl.textContent = [
      state.enabled ? 'WorkBuddy：长期记忆合同将在重新连接时下发。' : 'WorkBuddy：自动记忆合同未启用。',
      ...state.agents.map(agent => `${agent.agent === 'claude' ? 'Claude Code / Grok Build' : 'Codex'}：${agent.block === 'present' ? '托管指令已安装' : '未安装托管指令'}${agent.agent === 'claude' ? `；Stop Hook ${agent.hook === 'installed' ? '已安装' : '未安装'}` : ''}`),
      ...state.issues,
    ].join('；');
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error);
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
    const memoryMode = selectedMemoryMode();
    const saveMemory = memoryMode !== undefined && loadedMemoryMode !== null && memoryMode !== loadedMemoryMode;
    const result = await window.pmbrainDesktop.saveSystemSettings(payload);
    applySystemSettingsState(result.state);
    if (result.canceled) return;
    if (saveMemory && memoryMode) {
      await window.pmbrainDesktop.saveMemoryWriteback({ mode: memoryMode, notice_shown: true });
      await refreshMemoryWriteback();
    }
    if (!result.state.gateway?.running) throw new Error('共享入口仍未启动，请检查固定 IP 与 3131 端口。');
    setNotice('success', `局域网共享已恢复：${result.state.sharedMcpUrl || payload.sharedIp}`);
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
    const memoryMode = selectedMemoryMode();
    const saveMemory = memoryModeDirty();
    const result = await window.pmbrainDesktop.saveSystemSettings(payload);
    applySystemSettingsState(result.state);
    if (result.canceled) return;
    if (saveMemory && memoryMode) {
      await window.pmbrainDesktop.saveMemoryWriteback({ mode: memoryMode, notice_shown: true });
      await refreshMemoryWriteback();
    }
    if (result.canceled) return;
    if (mode === 'local') {
      setNotice('success', '系统设置已保存，当前仅本机连接。');
    } else if (result.state.gateway?.running) {
      const pgliteNote = configuredEngine() === 'pglite'
        ? ' 注意：当前是 PGLite，多人同时使用可能卡顿或不稳定，多用户请改用 Docker Postgres。'
        : '';
      setNotice('success', `共享入口已保存：${result.state.sharedMcpUrl || address.address}.${pgliteNote}`);
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
  const integrations = latestIntegrations.length > 0
    ? latestIntegrations
    : restoreLastVerifiedIntegrations(next.integrations);
  state = { ...next, integrations };
  const { setup } = next;
  customCatalog = {
    chat: [...(setup.current.customProviders?.chat ?? [])],
    embedding: [...(setup.current.customProviders?.embedding ?? [])],
  };
  customSelection = { ...(setup.current.customSelection ?? {}) };
  syncCustomProviderOptions('chat');
  syncCustomProviderOptions('embedding');
  renderProviderDropdown('chat');
  renderProviderDropdown('embedding');
  syncAdvancedProviderOptions();
  const activePanel = (document.querySelector<HTMLElement>('.panel.active')?.id.replace('panel-', '') || 'basic') as Panel;
  switchPanel(activePanel, false);
  $('#existing-config').hidden = setup.needsSetup;
  ($<HTMLSelectElement>('#system-theme-select')).value = setup.current.theme;
  const radio = document.querySelector<HTMLInputElement>(`input[name="engine"][value="${setup.current.engine}"]`);
  if (radio) radio.checked = true;
  ($<HTMLInputElement>('#database-path')).value = setup.current.databasePath || setup.defaults.databasePath;
  ($<HTMLInputElement>('#database-url')).value = setup.current.databaseUrl || '';
  ($<HTMLInputElement>('#knowledge-directory')).value = setup.current.knowledgeDirectory || setup.defaults.knowledgeDirectory;
  ($<HTMLInputElement>('#knowledge-source-id')).value = setup.current.knowledgeSourceId || '';
  loadedKnowledgeDirectory = ($<HTMLInputElement>('#knowledge-directory')).value.trim();
  loadedKnowledgeSourceId = ($<HTMLInputElement>('#knowledge-source-id')).value.trim();
  $('#knowledge-source-hint').textContent = setup.current.knowledgeSourceId
    ? `当前主源 ID：${setup.current.knowledgeSourceId}。只有 CLI/MCP 路由或多源管理需要识别这个值。`
    : '主源 ID 用于 CLI 和 MCP 路由。普通用户保持自动生成即可。';
  renderKnowledgeSourceStatus(null);
  void refreshKnowledgeSourceStatus(loadedKnowledgeDirectory, false);
  const chat = splitModelId(setup.current.chatModel);
  const embedding = splitModelId(setup.current.embeddingModel);
  const chatProviderValue = chat.provider === 'custom-openai'
    ? (customSelection.chat || customCatalog.chat.find(item => item.modelId === chat.model)?.id || customCatalog.chat[0]?.id || '')
    : chat.provider;
  const embeddingProviderValue = embedding.provider === 'custom-openai'
    ? (customSelection.embedding || customCatalog.embedding.find(item => item.modelId === embedding.model)?.id || customCatalog.embedding[0]?.id || '')
    : embedding.provider === 'zeroentropyai' ? 'zeroentropy' : embedding.provider;
  ($<HTMLSelectElement>('#chat-provider')).value = chatProviderValue;
  ($<HTMLInputElement>('#chat-model-name')).value = chat.model;
  ($<HTMLSelectElement>('#embedding-provider')).value = embeddingProviderValue;
  previousProviderSelection.chat = ($<HTMLSelectElement>('#chat-provider')).value;
  previousProviderSelection.embedding = ($<HTMLSelectElement>('#embedding-provider')).value;
  ($<HTMLInputElement>('#embedding-model-name')).value = embedding.model;
  const chatKey = providerKeyId(chat.provider, 'chat');
  const embeddingKey = providerKeyId(embedding.provider, 'embedding');
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
  $('#chat-model-effective').textContent = setup.current.chatModel
    ? (setup.current.generativeEnabled
      ? `当前生效：${setup.current.chatModel}`
      : `普通模型：${setup.current.chatModel} · 状态：已配置，但全局禁用`)
    : '当前未配置';
  $('#embedding-model-effective').textContent = setup.current.embeddingModel ? `当前生效：${setup.current.embeddingModel}` : '当前未配置';
  const ocr = splitModelId(setup.current.ocrModel);
  ($<HTMLSelectElement>('#ocr-provider')).value = ocr.provider;
  ($<HTMLInputElement>('#ocr-model-name')).value = ocr.model;
  syncOcrProviderKeyField();
  $('#ocr-model-effective').textContent = setup.current.ocrModel
    ? `当前生效：${setup.current.ocrModel}`
    : `自动使用普通模型：${setup.current.chatModel || '尚未配置'}`;
  $('#config-path').textContent = `配置写入：${setup.configPath}`;
  $('#postgres-status').textContent = setup.current.engine === 'postgres' && setup.current.databaseConfigured
    ? '已读取当前 Postgres 连接，正在检查 Docker 中可切换的 PMBrain 数据库。'
    : '已有数据库可填写地址；当前使用 PGLite 时可一键创建 Docker 数据库并迁移完整知识库。';
  $<HTMLButtonElement>('#migrate-to-docker').hidden = setup.needsSetup || setup.current.engine !== 'pglite';
  renderEngine();
  if (setup.current.engine === 'postgres') void refreshDockerDatabases();
  renderIntegrations(integrations);
  renderService(null, next.port);
  $('#save-setup').querySelector('span')!.textContent = saveButtonText();
  updateSystemSettingsAvailability();
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

function releaseDateLabel(value?: string): string {
  if (!value) return '发布日期未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '发布日期未知';
  return `发布于 ${date.toLocaleDateString('zh-CN')}`;
}

function cleanReleaseNoteText(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim();
}

function renderReleaseNotes(notes?: string): void {
  const body = $('#update-release-notes-body');
  body.replaceChildren();
  const lines = (notes ?? '').replace(/\r\n/g, '\n').split('\n');
  let list: HTMLUListElement | HTMLOListElement | null = null;
  let listKind: 'ul' | 'ol' | null = null;

  const finishList = () => {
    list = null;
    listKind = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      finishList();
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) {
      finishList();
      const element = document.createElement('h4');
      element.textContent = cleanReleaseNoteText(heading[1]);
      body.append(element);
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      const kind = bullet ? 'ul' : 'ol';
      if (!list || listKind !== kind) {
        list = document.createElement(kind);
        listKind = kind;
        body.append(list);
      }
      const item = document.createElement('li');
      item.textContent = cleanReleaseNoteText((bullet ?? ordered)![1]);
      list.append(item);
      continue;
    }
    finishList();
    const paragraph = document.createElement('p');
    paragraph.textContent = cleanReleaseNoteText(line);
    body.append(paragraph);
  }

  if (!body.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'update-release-notes-empty';
    empty.textContent = '本版本暂无更新记录';
    body.append(empty);
  }
}

function renderUpdate(update: UpdateState | null): void {
  if (!update) return;
  const displayVersion = update.availableVersion ?? update.currentVersion;
  $('#update-current').textContent = `v${update.currentVersion}`;
  $('#update-title').textContent = `PMBrain v${displayVersion}`;
  $('#update-message').textContent = update.message;
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
  const releaseNotes = $('#update-release-notes');
  const hasReleaseNotes = Boolean(update.releaseNotes?.trim());
  releaseNotes.hidden = !hasReleaseNotes;
  $('#update-release-date').textContent = releaseDateLabel(update.releaseDate);
  renderReleaseNotes(update.releaseNotes);
  const button = $<HTMLButtonElement>('#update-action');
  const busy = update.phase === 'checking' || update.phase === 'downloading' || update.phase === 'installing';
  button.disabled = busy;
  button.classList.toggle('busy', busy);
  button.dataset.action = update.phase === 'downloaded' ? 'install'
    : update.phase === 'available' ? 'download'
      : 'check';
  button.querySelector('span')!.textContent = update.phase === 'downloaded' ? '立即安装'
    : update.phase === 'downloading' ? `下载中 ${update.percent ?? 0}%`
      : update.phase === 'checking' ? '正在检查…'
        : update.phase === 'installing' ? '正在安装…'
          : update.phase === 'available' ? '下载更新'
            : '检查更新';
}

function formatRepairVersion(version: string): string {
  return version === 'manual' || version.startsWith('v') ? version : `v${version}`;
}

function formatRepairTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
}

function repairActionButtons(): HTMLButtonElement[] {
  return [
    $('#repair-prune-backups'),
    $('#repair-open-backup-root'),
    $('#repair-change-backup-root'),
    ...Array.from(document.querySelectorAll<HTMLButtonElement>('.repair-backup-actions button')),
  ];
}

function setRepairBusy(busy: boolean): void {
  for (const button of repairActionButtons()) {
    button.disabled = busy;
  }
}

function renderPgliteUpgradeBackups(result: DesktopPgliteUpgradeBackups): void {
  const list = $('#repair-backup-list');
  list.replaceChildren();
  $('#repair-database-path').textContent = result.databasePath
    ? `当前数据库：${result.databasePath}`
    : '当前尚未配置 PGLite 数据库';
  $('#repair-backup-root').textContent = result.backupRoot
    ? result.backupRoot
    : '完成 PGLite 配置后，这里会显示备份保存位置。';
  $('#repair-backup-count').textContent = result.backups.length > 0
    ? `${result.backups.length} 份，共占用 ${formatBytes(result.totalBytes)}`
    : '暂无已验证的升级前备份';
  $<HTMLButtonElement>('#repair-prune-backups').disabled = result.backups.length <= result.keep;
  $<HTMLButtonElement>('#repair-open-backup-root').disabled = !result.backupRoot;
  $<HTMLButtonElement>('#repair-change-backup-root').disabled = !result.databasePath;

  if (result.backups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'repair-empty';
    empty.textContent = result.databasePath
      ? '当前数据库还没有由桌面端升级流程保留的备份。升级成功后会自动创建并只保留最近 2 份。'
      : '完成基础配置后，这里会显示升级前保留的数据库备份。';
    list.append(empty);
    return;
  }

  for (const backup of result.backups) {
    const card = document.createElement('article');
    card.className = 'repair-backup-card';

    const heading = document.createElement('div');
    heading.className = 'repair-backup-heading';
    const headingCopy = document.createElement('div');
    const eyebrow = document.createElement('span');
    eyebrow.textContent = 'UPGRADE BACKUP';
    const title = document.createElement('h3');
    title.textContent = `升级至 ${formatRepairVersion(backup.targetVersion)} 前保存`;
    headingCopy.append(eyebrow, title);
    const status = document.createElement('b');
    status.className = 'repair-backup-status';
    status.textContent = '已验证';
    heading.append(headingCopy, status);

    const meta = document.createElement('div');
    meta.className = 'repair-backup-meta';
    const values = [
      ['数据库 Schema', backup.sourceSchemaVersion === null ? '未记录' : String(backup.sourceSchemaVersion)],
      ['备份时间', formatRepairTime(backup.createdAt)],
      ['占用空间', formatBytes(backup.bytes)],
    ];
    for (const [label, value] of values) {
      const item = document.createElement('span');
      const itemLabel = document.createElement('small');
      itemLabel.textContent = label;
      const itemValue = document.createElement('strong');
      itemValue.textContent = value;
      item.append(itemLabel, itemValue);
      meta.append(item);
    }

    const path = document.createElement('code');
    path.textContent = backup.backupDirectory;
    const note = document.createElement('p');
    note.textContent = '这是升级前保留的已验证副本。恢复会替换当前数据库；删除只去掉这份备份，不会改当前知识库。自动升级成功后只保留最近 2 份。';
    const actions = document.createElement('div');
    actions.className = 'repair-backup-actions';
    const restore = document.createElement('button');
    restore.className = 'solid';
    restore.type = 'button';
    restore.innerHTML = '<span>恢复此备份</span><i></i>';
    restore.addEventListener('click', () => void restorePgliteUpgradeBackup(backup.backupDirectory));
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.type = 'button';
    remove.innerHTML = '<span>删除此备份</span><i></i>';
    remove.addEventListener('click', () => void deletePgliteUpgradeBackup(backup.backupDirectory));
    const open = document.createElement('button');
    open.className = 'ghost';
    open.type = 'button';
    open.innerHTML = '<span>打开备份目录</span><i></i>';
    open.addEventListener('click', () => void openPgliteUpgradeBackup(backup.backupDirectory));
    actions.append(restore, remove, open);
    card.append(heading, meta, path, note, actions);
    list.append(card);
  }
}

async function loadPgliteUpgradeBackups(): Promise<void> {
  $('#repair-backup-count').textContent = '正在读取备份清单…';
  try {
    renderPgliteUpgradeBackups(await window.pmbrainDesktop.listPgliteUpgradeBackups());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    $('#repair-backup-count').textContent = '读取失败';
    $('#repair-database-path').textContent = '';
    $('#repair-backup-root').textContent = '无法读取备份目录';
    $<HTMLButtonElement>('#repair-prune-backups').disabled = true;
    $<HTMLButtonElement>('#repair-open-backup-root').disabled = true;
    $<HTMLButtonElement>('#repair-change-backup-root').disabled = true;
    const list = $('#repair-backup-list');
    list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'repair-empty error';
    empty.textContent = `无法读取数据库备份清单：${message}`;
    list.append(empty);
    setNotice('error', message);
  }
}

function applyBackupMutation(result: DesktopPgliteUpgradeBackupMutation, success: string): void {
  renderPgliteUpgradeBackups(result.listing);
  setNotice('success', success);
}

async function restorePgliteUpgradeBackup(backupDirectory: string): Promise<void> {
  if (!confirm(
    '确认用这份备份替换当前数据库？\n\n' +
    '本地服务会先暂停再重启。当前知识数据会回到备份时的状态，这份备份本身会保留。\n' +
    '请确认当前没有正在进行的导入、整理或搜索任务。',
  )) return;
  clearNotices();
  setRepairBusy(true);
  setSetupWait(true, '正在恢复数据库备份', '已暂停本地服务，正在校验并替换当前数据库，请不要关闭窗口。', '软件修复');
  try {
    applyBackupMutation(
      await window.pmbrainDesktop.restorePgliteUpgradeBackup(backupDirectory),
      '已用所选备份替换当前数据库，本地服务正在重新检查。',
    );
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setSetupWait(false);
    setRepairBusy(false);
    await loadPgliteUpgradeBackups();
  }
}

async function deletePgliteUpgradeBackup(backupDirectory: string): Promise<void> {
  if (!confirm('确认删除这份升级备份？删除后无法从软件修复页恢复，当前数据库不会被修改。')) return;
  clearNotices();
  setRepairBusy(true);
  try {
    applyBackupMutation(
      await window.pmbrainDesktop.deletePgliteUpgradeBackup(backupDirectory),
      '已删除所选升级备份。当前数据库未被修改。',
    );
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
    await loadPgliteUpgradeBackups();
  } finally {
    setRepairBusy(false);
  }
}

async function openPgliteUpgradeBackup(target: string): Promise<void> {
  try {
    await window.pmbrainDesktop.openPgliteUpgradeBackup(target);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  }
}

async function prunePgliteUpgradeBackups(): Promise<void> {
  if (!confirm('确认只保留最近 2 份已验证备份？更早的升级备份会被删除，当前数据库不会被修改。')) return;
  clearNotices();
  setRepairBusy(true);
  try {
    const result = await window.pmbrainDesktop.prunePgliteUpgradeBackups();
    applyBackupMutation(
      result,
      result.deleted?.length
        ? `已清理 ${result.deleted.length} 份旧备份，现保留最近 ${result.kept?.length ?? 2} 份。`
        : '当前已是最近 2 份备份，无需再清理。',
    );
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
    await loadPgliteUpgradeBackups();
  } finally {
    setRepairBusy(false);
  }
}

async function changePgliteUpgradeBackupRoot(): Promise<void> {
  const current = $('#repair-backup-root').textContent?.trim();
  const selected = await window.pmbrainDesktop.chooseDirectory(
    current && current !== '完成 PGLite 配置后，这里会显示备份保存位置。' ? current : undefined,
  );
  if (!selected) return;
  if (!confirm(
    `确认把之后的升级备份保存到：\n${selected}\n\n` +
    '现有备份不会自动搬迁。新的自动升级备份会写入这个目录。',
  )) return;
  clearNotices();
  setRepairBusy(true);
  try {
    applyBackupMutation(
      await window.pmbrainDesktop.setPgliteUpgradeBackupRoot(selected),
      `已将备份位置改为 ${selected}。现有备份不会自动搬迁。`,
    );
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
    await loadPgliteUpgradeBackups();
  } finally {
    setRepairBusy(false);
  }
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
  const embeddingProvider = ($<HTMLSelectElement>('#embedding-provider')).value;
  snapshotSelectedCustomEndpoints();
  const missingCustomTarget = isCustomEndpointId(chatProvider) && !selectedCustomEndpoint('chat')?.baseUrl
    ? 'chat' as const
    : isCustomEndpointId(embeddingProvider) && !selectedCustomEndpoint('embedding')?.baseUrl
      ? 'embedding' as const
      : null;
  if (missingCustomTarget) {
    setNotice('error', '请先添加自定义接口并填写 Base URL。');
    openCustomProvider(missingCustomTarget);
    return;
  }

  // 校验：模型名不能为空
  const chatModelName = ($<HTMLInputElement>('#chat-model-name')).value.trim();
  if (!chatModelName) {
    setNotice('error', '请填写普通模型名称');
    return;
  }
  const embeddingModelName = ($<HTMLInputElement>('#embedding-model-name')).value.trim();
  if (Boolean(embeddingProvider) !== Boolean(embeddingModelName)) {
    setNotice('error', '向量模型为可选项；如需启用，请同时填写供应商和模型名称');
    return;
  }
  const ocrProvider = ($<HTMLSelectElement>('#ocr-provider')).value;
  const ocrModelName = ($<HTMLInputElement>('#ocr-model-name')).value.trim();
  if (Boolean(ocrProvider) !== Boolean(ocrModelName)) {
    setNotice('error', '请同时填写图片/OCR模型的供应商和模型名称');
    return;
  }
  const ocrModel = composeModelId(recipeProvider(ocrProvider), ocrModelName);

  let confirmEmbeddingRebuild = false;
  let confirmLegacyEmbeddingRecovery = false;
  // 检测向量化模型是否变更（非首次配置）
  if (!state?.setup?.needsSetup && state?.setup?.current?.embeddingModel) {
    const newEmbeddingModel = composeModelId(recipeProvider(embeddingProvider), embeddingModelName);
    const oldEmbeddingModel = state.setup.current.embeddingModel;
    if (newEmbeddingModel && oldEmbeddingModel && newEmbeddingModel !== oldEmbeddingModel) {
      const recoveryCandidate = state.setup.current.legacyEmbeddingRecoveryCandidate;
      if (recoveryCandidate?.model === newEmbeddingModel) {
        if (!confirm(
          `检测到该模型与历史配置备份一致："${newEmbeddingModel}"（${recoveryCandidate.dimensions} 维）。\n\n` +
          `PMBrain 会先核对数据库实际维度和已有向量标签；只有完全匹配时才恢复配置并校正历史误标，` +
          `不会清空或重新生成已有向量。校验不通过时会自动恢复原配置。\n\n` +
          `确认安全恢复？`
        )) return;
        confirmLegacyEmbeddingRecovery = true;
      } else {
        if (!confirm(
          `⚠️ 向量化模型已从 "${oldEmbeddingModel}" 改为 "${newEmbeddingModel}"。\n\n` +
          `切换后会清除旧的文本向量并重新向量化，可能耗时并产生 API 费用。\n` +
          `原始文档、页面和分块数据会保留，不会删除知识库内容。\n\n` +
          `确认更改？`
        )) return;
        confirmEmbeddingRebuild = true;
      }
    }
  }

  const keys: SetupPayload['keys'] = {};
  const chatModel = composeModelId(recipeProvider(chatProvider), chatModelName);
  const embeddingModel = composeModelId(recipeProvider(embeddingProvider), embeddingModelName);
  const chatKey = providerKeyId(chatProvider, 'chat');
  const embeddingKey = providerKeyId(embeddingProvider, 'embedding');
  const ocrKey = providerKeyId(ocrProvider, 'chat');
  // 需要 Key 的供应商才保存 Key
  if (chatKey && chatKey !== '__none__') {
    const chatKeyValue = ($<HTMLInputElement>('#chat-api-key')).value.trim();
    if (!chatKeyValue && !isCustomEndpointId(chatProvider)) {
      setNotice('error', `供应商 ${chatProvider} 需要填写 API Key`);
      return;
    }
    if (chatKeyValue) (keys as Record<string, string>)[chatKey] = chatKeyValue;
  }
  if (embeddingProvider && embeddingKey && embeddingKey !== '__none__') {
    const embeddingKeyValue = ($<HTMLInputElement>('#embedding-api-key')).value.trim();
    if (!embeddingKeyValue && !isCustomEndpointId(embeddingProvider)) {
      setNotice('error', `供应商 ${embeddingProvider} 需要填写 API Key`);
      return;
    }
    if (embeddingKeyValue) (keys as Record<string, string>)[embeddingKey] = embeddingKeyValue;
  }
  if (ocrModel && ocrProvider && ocrKey && ocrKey !== '__none__') {
    const ocrKeyValue = ($<HTMLInputElement>('#ocr-api-key')).value.trim();
    if (!ocrKeyValue && !isCustomEndpointId(ocrProvider)) {
      setNotice('error', `供应商 ${ocrProvider} 需要填写 API Key`);
      return;
    }
    if (ocrKeyValue) (keys as Record<string, string>)[ocrKey] = ocrKeyValue;
  }
  const knowledgeDirectory = ($<HTMLInputElement>('#knowledge-directory')).value;
  const knowledgeSourceId = ($<HTMLInputElement>('#knowledge-source-id')).value;
  const payload: SetupPayload = {
    engine: selectedEngine(),
    resetAdvancedModelRouting: false,
    confirmEmbeddingRebuild,
    confirmLegacyEmbeddingRecovery,
    databasePath: ($<HTMLInputElement>('#database-path')).value,
    databaseUrl: ($<HTMLInputElement>('#database-url')).value,
    knowledgeDirectory,
    knowledgeSourceId,
    knowledgeSourceChanged: knowledgeDirectory.trim() !== loadedKnowledgeDirectory
      || knowledgeSourceId.trim() !== loadedKnowledgeSourceId,
    modelConfig: {
      chatModel,
      ...(embeddingModel ? { embeddingModel } : {}),
      ocrEnabled: true,
      ...(ocrModel ? { ocrModel } : {}),
    },
    customProviders: customCatalog,
    customSelection,
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
    refreshIntegrationPanel();
    setNotice(
      next.reembeddingWarning ? 'error' : 'success',
      next.reembeddingWarning
        ? `模型配置已保存：${next.reembeddingWarning}`
        : `配置完成，PMBrain 已在 127.0.0.1:${next.port} 启动。`,
    );
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

function integrationClientName(client: IntegrationClient): string {
  return latestIntegrations.find(item => item.id === client)?.name ?? ({
    cherry: 'CherryStudio',
    workbuddy: 'Workbuddy',
    cursor: 'Cursor',
    trae: 'Trae Work',
    qwen: 'Qwen Code',
    qoder: 'Qoder CN（通义灵码）',
    zcode: 'ZCode（智谱）',
    mimo: 'MiMo Code（小米）',
    kimi: 'Kimi Code（月之暗面）',
    qwenpaw: 'QwenPaw',
    codex: 'Codex',
    claude: 'Claude Code',
    grok: 'Grok Build',
    hermes: 'Hermes',
    openclaw: 'OpenClaw',
    codebuddy: 'CodeBuddy',
  } satisfies Record<IntegrationClient, string>)[client];
}

function openIntegrationProgress(client: IntegrationClient, deep: boolean): void {
  const clientName = integrationClientName(client);
  const dialog = $<HTMLDialogElement>('#integration-progress-dialog');
  const progress = $('#integration-progress-state');
  dialog.dataset.client = client;
  progress.className = 'integration-progress-state busy';
  $('#integration-progress-stage').textContent = deep ? '深度接入' : 'MCP 接入';
  $('#integration-progress-title').textContent = deep ? `正在深度接入 ${clientName}` : `正在更新 ${clientName} 连接`;
  $('#integration-progress-state-title').textContent = '正在创建并验证新凭证';
  $('#integration-progress-message').textContent = deep
    ? '接下来会写入 MCP 配置并安装自动记忆规则。首次设置时会先询问“重要内容 / 全部事实”，请在弹窗中选择。'
    : '接下来会备份并更新客户端 MCP 配置。本次只更新连接；长期记忆范围请到“系统设置”修改。首次设置时会先询问“重要内容 / 全部事实”。';
  $('#integration-progress-footnote').textContent = '请保持窗口打开。完成后会明确告诉你写入、验证和重启状态。';
  $('#result-console').hidden = true;
  $<HTMLButtonElement>('#copy-result').hidden = true;
  $<HTMLButtonElement>('#integration-progress-close').disabled = true;
  if (!dialog.open) dialog.showModal();
}

function finishIntegrationProgress(
  status: 'success' | 'error',
  title: string,
  message: string,
  footnote: string,
): void {
  $('#integration-progress-state').className = `integration-progress-state ${status}`;
  $('#integration-progress-title').textContent = title;
  $('#integration-progress-state-title').textContent = status === 'success' ? '处理完成' : '需要处理';
  $('#integration-progress-message').textContent = message;
  $('#integration-progress-footnote').textContent = footnote;
  $<HTMLButtonElement>('#integration-progress-close').disabled = false;
}

function integrationMemoryFootnote(deep: boolean): string {
  return deep
    ? '深度接入会安装自动记忆规则；“重要内容 / 全部事实”由“系统设置”控制，之后可以随时修改。'
    : '本次只更新 MCP 连接；长期记忆范围请到“系统设置”修改。首次设置时的选择只询问一次。';
}

function applyIntegrationResult(result: IntegrationResult): void {
  if (!result.configured) return;
  const next = latestIntegrations.map(item => item.id === result.client ? {
    ...item,
    configured: true,
    path: result.path ?? item.path,
    portMismatch: false,
    connectionState: result.connectionState
      ?? (result.smoke?.statsOk && result.smoke.toolCount > 0 ? 'connected' : item.connectionState),
  } : item);
  if (state) state.integrations = next;
  if (result.connectionState === 'connected') {
    recordIntegrationVerification(next.filter(item => item.id === result.client));
  }
  renderIntegrations(next);
}

async function writeWorkbuddyUserAgent(button: HTMLButtonElement): Promise<void> {
  clearNotices();
  setBusy(button, true, '正在写入…');
  try {
    const result = await window.pmbrainDesktop.writeWorkbuddyUserAgent();
    const extra = result.backedUp.length > 0 ? ` 已备份 ${result.backedUp.length} 个你改过的同名文件。` : '';
    setNotice('success', `已写入用户级 PMBrain 长期记忆规则、Skills、子代理和命令。请重启 WorkBuddy；普通会话会使用 remember 写入 PMBrain，@pmbrain 和 /pmbrain 也可继续使用。${extra}`);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(button, false, '深度接入');
  }
}

async function launchIntegration(client: IntegrationClient, button: HTMLButtonElement): Promise<void> {
  clearNotices();
  setBusy(button, true, '启动中…');
  try {
    await window.pmbrainDesktop.launchIntegration(client);
    setNotice('success', `${integrationClientName(client)} 已启动。`);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(button, false, '启动');
  }
}

async function configure(client: IntegrationClient, button: HTMLButtonElement, deep = false): Promise<void> {
  clearNotices();
  const originalText = button.textContent || '';
  button.disabled = true; button.textContent = '处理中…';
  openIntegrationProgress(client, deep);
  try {
    const result = await window.pmbrainDesktop.configureIntegration(
      client,
      deep || client === 'qwenpaw' ? 'api_key' : selectedCredential(),
      deep,
    );
    lastResult = result.snippet;
    const clientName = integrationClientName(client);
    $('#result-title').textContent = `${clientName} 配置结果`;
    $('#result-content').textContent = result.snippet;
    $<HTMLButtonElement>('#copy-result').hidden = false;
    applyIntegrationResult(result);
    const smoke = result.smoke ? `MCP smoke：${result.smoke.toolCount} 个工具，get_stats ${result.smoke.statsOk ? '正常' : '失败'}` : 'OAuth 凭证已创建';
    $('#result-meta').textContent = [
      result.configured && result.path ? `已写入 ${result.path}` : '未自动写入，请复制上方内容',
      result.backup ? `备份：${result.backup}` : '',
      client === 'qwenpaw' ? `QwenPaw 连接：${result.connectionState === 'connected' ? '已验证' : '等待重试'}` : smoke,
    ].filter(Boolean).join(' · ');
    $('#result-console').hidden = false;
    if (client === 'qwenpaw' && result.connectionState === 'saved') {
      finishIntegrationProgress(
        'error',
        '配置已写入，但 QwenPaw 尚未连通',
        '请让代理绕过 localhost/127.0.0.1 后点击“重试连接”；不会启动 OAuth。',
        integrationMemoryFootnote(false),
      );
    } else {
      finishIntegrationProgress(
        'success',
        result.configured
          ? deep ? `${clientName} 深度接入完成` : `${clientName} 连接配置已更新`
          : `${clientName} 接入内容已生成`,
        result.configured
          ? `新凭证已通过 PMBrain 验证并写入配置。请重启 ${clientName}，让正在运行的客户端重新加载。`
          : '凭证已通过 PMBrain 验证。请复制下方内容到客户端，并按客户端提示重新加载。',
        integrationMemoryFootnote(deep),
      );
    }
    void refreshIntegrations(true).catch(() => undefined);
  } catch (error) {
    finishIntegrationProgress(
      'error',
      `${integrationClientName(client)} 接入未完成`,
      error instanceof Error ? error.message : String(error),
      '本次流程没有全部完成；如果 MCP 配置已写入，后台复核会更新卡片，自动记忆规则仍以错误信息为准。',
    );
    void refreshIntegrations(true).catch(() => undefined);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

document.querySelectorAll<HTMLInputElement>('input[name="engine"]').forEach((input) => input.addEventListener('change', () => {
  renderEngine();
  if (selectedEngine() === 'postgres') void refreshDockerDatabases();
}));
$<HTMLSelectElement>('#database-instance').addEventListener('change', (event) => {
  void selectDockerDatabase(event.currentTarget as HTMLSelectElement);
});
$<HTMLInputElement>('#database-url').addEventListener('input', () => {
  $<HTMLSelectElement>('#database-instance').value = '__manual__';
});
document.querySelectorAll<HTMLInputElement>('input[name="network-mode"]').forEach((input) => input.addEventListener('change', renderNetworkMode));
document.querySelectorAll<HTMLInputElement>('input[name="memory-writeback"]').forEach((input) => input.addEventListener('change', () => void handleMemoryModeChange(input)));
$<HTMLSelectElement>('#shared-address').addEventListener('change', renderSelectedAddressNote);
(['chat', 'embedding'] as const).forEach(kind => {
  const select = $<HTMLSelectElement>(`#${kind}-provider`);
  select.addEventListener('mousedown', event => {
    event.preventDefault();
    toggleProviderDropdown(kind);
  });
  select.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      toggleProviderDropdown(kind);
    }
  });
  select.addEventListener('change', () => {
    applyProviderSelection(kind, select.value, !isCustomEndpointId(select.value));
  });
});
$<HTMLButtonElement>('#add-custom-chat-model').addEventListener('click', () => openCustomProvider('chat'));
$<HTMLButtonElement>('#add-custom-embedding-model').addEventListener('click', () => openCustomProvider('embedding'));
$<HTMLButtonElement>('#test-chat-model').addEventListener('click', () => void testConfiguredModel('chat'));
$<HTMLButtonElement>('#test-embedding-model').addEventListener('click', () => void testConfiguredModel('embedding'));
$<HTMLButtonElement>('#test-ocr-model').addEventListener('click', () => void testOcrModel());
$<HTMLSelectElement>('#ocr-provider').addEventListener('change', syncOcrProviderKeyField);
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
ADVANCED_PHASES.forEach(phase => {
  $<HTMLSelectElement>(`#${advancedPhaseId(phase)}-provider`).addEventListener('change', () => {
    void refreshAdvancedPhaseProviderModels(phase, true);
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
  const phase = button.dataset.advancedPhase as AdvancedModelPhase | undefined;
  if (phase) {
    const ul = $<HTMLUListElement>(`#${advancedPhaseId(phase)}-model-dropdown`);
    if (ul.hidden) {
      renderAdvancedPhaseModelDropdown(phase);
      ul.hidden = false;
    } else {
      ul.hidden = true;
    }
    return;
  }
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
  if (!target.closest('.provider-picker')) {
    document.querySelectorAll<HTMLUListElement>('.provider-dropdown').forEach(dropdown => { dropdown.hidden = true; });
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll<HTMLUListElement>('.model-dropdown').forEach(dropdown => { dropdown.hidden = true; });
    document.querySelectorAll<HTMLUListElement>('.provider-dropdown').forEach(dropdown => { dropdown.hidden = true; });
  }
});
let googleClientJsonPath = '';
let googleConsentUrl = '';
let activeDailyConnector = '';

function extractConsentUrl(message?: string): string | null {
  const match = message?.match(/https:\/\/accounts\.google\.com[^\s"'<>]+/i);
  if (!match) return null;
  try {
    const parsed = new URL(match[0].replace(/[).,]+$/, ''));
    if (parsed.protocol !== 'https:' || parsed.searchParams.has('code')) return null;
    return parsed.hostname.toLowerCase() === 'accounts.google.com' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function renderList(target: HTMLElement, lines: string[]): void {
  target.textContent = lines.length > 0 ? lines.join('\n') : '暂无';
}

function renderChronicleRows(target: HTMLElement, payload: unknown): void {
  const rows = Array.isArray(payload) ? payload : [];
  target.textContent = rows.length > 0 ? JSON.stringify(rows) : '暂无';
}

function selectDailyConnector(id: string, connected: boolean): void {
  activeDailyConnector = id;
  const details = $<HTMLDetailsElement>('#daily-connectors-advanced');
  details.open = true;
  const name = id === 'chatgpt' ? 'ChatGPT' : 'Claude';
  const host = id === 'chatgpt' ? 'chatgpt.com' : 'claude.ai';
  $('#daily-chat-secret-label').textContent = `${name} 整行 Cookie:`;
  $('#daily-chat-secret-help').textContent = `${name} 登录状态下 → F12 → Network → 随便点一条 ${host} 请求 → Headers → Request Headers → 复制整行 Cookie:。只保存在本机，不要发给任何人。`;
  const secret = $<HTMLInputElement>('#daily-chat-secret');
  secret.value = '';
  secret.placeholder = connected ? '已连接；如需更新，请粘贴新的整行 Cookie:' : '粘贴整行 Cookie:';
  $<HTMLButtonElement>('#daily-chat-sync').disabled = !connected;
  $<HTMLButtonElement>('#daily-chat-logout').disabled = !connected;
  secret.focus();
}

async function refreshDailyPanel(): Promise<void> {
  const waitingEl = $('#daily-waiting');
  const connectorsEl = $('#daily-connectors');
  const googleEl = $('#daily-google-status');
  try {
    const payload = await window.pmbrainDesktop.productConnectors() as {
      providers?: Array<{ provider: string; credential?: { present: boolean }; last_sync_at?: string | null }>;
      google?: { accounts?: Array<{ account: string }> };
      cards?: Array<{ id: string; name: string; connected: boolean; account: string | null; last_sync_label: string; auto_sync?: boolean }>;
    };
    const cards = payload.cards;
    const providers = payload.providers ?? [];
    const accounts = payload.google?.accounts ?? [];
    googleEl.textContent = accounts.length > 0 ? `Google 已连接 ${accounts.map((item) => item.account).join('、')}` : 'Google 尚未连接';
    if (accounts[0] && !$<HTMLInputElement>('#daily-google-account').value) {
      $<HTMLInputElement>('#daily-google-account').value = accounts[0].account;
    }
    connectorsEl.replaceChildren();
    const rows = cards ?? providers.map((item) => ({
      id: item.provider,
      name: item.provider === 'chatgpt' ? 'ChatGPT' : item.provider === 'claude' ? 'Claude' : item.provider,
      connected: item.credential?.present === true,
      account: null,
      last_sync_label: item.last_sync_at ? `最近同步 ${item.last_sync_at}` : '尚未同步',
      auto_sync: false,
    }));
    if (rows.length === 0) {
      connectorsEl.textContent = '没有连接器';
    } else {
    for (const item of rows) {
      const row = document.createElement('div');
      row.className = 'daily-connector-row';
      const label = document.createElement('div');
      const state = document.createElement('b');
      state.textContent = `${item.name}　${item.connected ? (item.account ? `已连接 ${item.account}` : '已连接') : '未连接'}`;
      const sync = document.createElement('small');
      sync.textContent = `最近同步：${item.last_sync_label}`;
      label.append(state, sync);
      if (item.connected) {
        const auto = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = item.auto_sync === true;
        checkbox.addEventListener('change', () => {
          void window.pmbrainDesktop.productConnectorAutoSync(item.id, checkbox.checked)
            .then(() => setNotice('success', checkbox.checked ? '已开启每日自动同步' : '已关闭自动同步'))
            .catch((error) => {
              checkbox.checked = !checkbox.checked;
              setNotice('error', error instanceof Error ? error.message : String(error));
            });
        });
        auto.append(checkbox, document.createTextNode(' 自动同步'));
        label.append(auto);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ghost';
      button.textContent = item.connected ? '管理' : '连接';
      button.addEventListener('click', () => {
        if (item.id === 'google') {
          $<HTMLDetailsElement>('#daily-connectors-advanced').open = true;
          if (!item.connected) $<HTMLButtonElement>('#daily-google-connect').click();
          return;
        }
        selectDailyConnector(item.id, item.connected);
      });
      row.append(label, button);
      connectorsEl.append(row);
    }
    }
  } catch (error) {
    connectorsEl.textContent = error instanceof Error ? error.message : String(error);
  }
  return;
  try {
    const payload = await window.pmbrainDesktop.productWaiting() as {
      items?: Array<{ title: string; meta?: string }>;
      groups?: Array<{ counterparty: string; loop_count: number; loops?: Array<{ summary: string }> }>;
      no_google_sources?: boolean;
      origins?: Record<'gmail' | 'meeting' | 'conversation', { ready: boolean; label: string }>;
    };
    const items = payload.items ?? [];
    for (const key of ['gmail', 'meeting', 'conversation'] as const) {
      const ready = payload.origins?.[key]?.ready === true;
      const input = $<HTMLInputElement>(`#daily-waiting-${key}`);
      const state = $(`#daily-waiting-${key}-state`);
      input.disabled = !ready;
      if (!ready) input.checked = false;
      state.textContent = ready ? '✅' : '未连接';
    }
    if (items.length > 0) {
      waitingEl.replaceChildren();
      for (const item of items as Array<{ id: number; title: string; meta?: string; origin_key?: string }>) {
        const input = item.origin_key ? document.querySelector<HTMLInputElement>(`#daily-waiting-${item.origin_key}`) : null;
        if (input?.checked === false) continue;
        const row = document.createElement('div');
        row.className = 'daily-waiting-row';
        const copy = document.createElement('div');
        const title = document.createElement('b');
        title.textContent = item.title;
        copy.append(title);
        if (item.meta) {
          const meta = document.createElement('small');
          meta.textContent = item.meta ?? '';
          copy.append(meta);
        }
        const actions = document.createElement('div');
        for (const [status, text] of [['done', '已完成'], ['dropped', '忽略']] as const) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = status === 'done' ? 'solid' : 'ghost';
          button.textContent = text;
          button.addEventListener('click', () => {
            void window.pmbrainDesktop.productWaitingClose({ id: item.id, status })
              .then(() => refreshDailyPanel())
              .catch((error) => setNotice('error', error instanceof Error ? error.message : String(error)));
          });
          actions.append(button);
        }
        row.append(copy, actions);
        waitingEl.append(row);
      }
    } else {
      waitingEl.textContent = payload.no_google_sources
        ? '还没有连接 Gmail。连上后可以扫描邮件里谁在等你。'
        : '暂时没有待处理事项。';
    }
  } catch (error) {
    waitingEl.textContent = String(error);
  }
  const date = $<HTMLInputElement>('#daily-chronicle-date').value;
  try {
    const status = await window.pmbrainDesktop.productChronicleStatus() as { event_count?: number; history_count?: number };
    const empty = (status.event_count ?? 0) === 0;
    $('#daily-chronicle-empty').hidden = !empty;
    $('#daily-chronicle-empty-actions').hidden = !empty;
    $('#daily-chronicle-content').hidden = empty;
    const historyCount = status.history_count ?? 0;
    const historyNote = $('#daily-chronicle-history-note');
    historyNote.hidden = !empty || historyCount === 0;
    historyNote.textContent = historyCount > 0 ? `已有 ${historyCount} 条历史知识，可补充过去的时间线。` : '';
    $<HTMLButtonElement>('#daily-chronicle-history').hidden = historyCount === 0;
    if (!empty) {
      renderChronicleRows($('#daily-chronicle-today'), await window.pmbrainDesktop.productChronicleDay(date || undefined));
      renderChronicleRows($('#daily-chronicle-memory'), await window.pmbrainDesktop.productChronicleOnThisDay(date || undefined));
    } else {
      $('#daily-chronicle-today').textContent = '还没有时间线。';
      $('#daily-chronicle-memory').textContent = '还没有时间线。';
    }
  } catch (error) {
    $('#daily-chronicle-today').textContent = String(error);
  }
  await refreshDailyPeople();
}

async function refreshDailyPeople(query = $<HTMLInputElement>('#daily-identity-query').value.trim()): Promise<void> {
  const groupsEl = $('#daily-identity-groups');
  const resultsEl = $('#daily-identity-results');
  const suggestionsEl = $('#daily-identity-suggestions');
  try {
    const payload = await window.pmbrainDesktop.productPeople(query) as {
      people?: Array<{ source_id: string; slug: string; title: string; source_label: string }>;
      suggestions?: Array<{ left: { source_id: string; slug: string; title: string; source_label: string }; right: { source_id: string; slug: string; title: string; source_label: string } }>;
      groups?: Array<{ entity_id: string; name: string; members?: Array<{ source_label: string; title: string }> }>;
    };
    suggestionsEl.replaceChildren();
    for (const item of payload.suggestions ?? []) {
      const row = document.createElement('div');
      row.textContent = `可能是同一个人：${item.left.title}（${item.left.source_label}） ↔ ${item.right.title}（${item.right.source_label}）`;
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'ghost';
      confirm.textContent = '确认关联';
      confirm.addEventListener('click', () => {
        void window.pmbrainDesktop.productMergePeople([item.left, item.right])
          .then(() => refreshDailyPanel())
          .catch((error) => setNotice('error', error instanceof Error ? error.message : String(error)));
      });
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'ghost';
      reject.textContent = '不是同一个人';
      reject.addEventListener('click', () => {
        void window.pmbrainDesktop.productRejectPeople({ left: item.left, right: item.right })
          .then(() => refreshDailyPanel())
          .catch((error) => setNotice('error', error instanceof Error ? error.message : String(error)));
      });
      row.append(confirm, reject);
      suggestionsEl.append(row);
    }
    resultsEl.replaceChildren();
    for (const person of payload.people ?? []) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.sourceId = person.source_id;
      box.dataset.slug = person.slug;
      box.dataset.title = person.title;
      label.append(box, document.createTextNode(` ${person.source_label} · ${person.title}`));
      resultsEl.append(label);
    }
    if ((payload.people ?? []).length === 0) resultsEl.textContent = '没有找到匹配的人物记录。';
    groupsEl.replaceChildren();
    for (const group of payload.groups ?? []) {
      const row = document.createElement('div');
      const copy = document.createElement('span');
      const members = (group.members ?? []).map((member) => `${member.source_label} · ${member.title}`).join('、');
      copy.textContent = `${group.name}：${members || '还没有成员'}`;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'ghost';
      open.textContent = '打开人物卡';
      open.addEventListener('click', () => void renderDailyPersonCard(group.entity_id));
      row.append(copy, open);
      groupsEl.append(row);
    }
    if ((payload.groups ?? []).length === 0) groupsEl.textContent = '还没有人物关联。';
  } catch (error) {
    groupsEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

function effectiveOcrModel(): string {
  const dedicated = composeModelId(
    recipeProvider(($<HTMLSelectElement>('#ocr-provider')).value),
    ($<HTMLInputElement>('#ocr-model-name')).value,
  );
  return dedicated || composeModelId(
    recipeProvider(($<HTMLSelectElement>('#chat-provider')).value),
    ($<HTMLInputElement>('#chat-model-name')).value,
  );
}

function syncOcrProviderKeyField(): void {
  const provider = ($<HTMLSelectElement>('#ocr-provider')).value;
  const keyId = providerKeyId(provider, 'chat');
  const input = $<HTMLInputElement>('#ocr-api-key');
  const local = keyId === '__none__';
  input.disabled = !provider || local;
  input.placeholder = !provider ? '留空时使用普通模型的凭据' : local ? '本地模型无需 API Key' : '';
  input.value = keyId && keyId !== '__none__' ? state?.setup.current.keyValues[keyId] || '' : '';
}

async function testOcrModel(): Promise<void> {
  const button = $<HTMLButtonElement>('#test-ocr-model');
  const status = $<HTMLElement>('#ocr-model-load-status');
  const modelId = effectiveOcrModel();
  const parsed = splitModelId(modelId);
  status.hidden = false;
  status.classList.remove('ready', 'warning', 'error');
  if (!parsed.provider || !parsed.model) {
    status.classList.add('error');
    status.textContent = '✕ 请先配置普通模型，或单独填写 provider:model';
    return;
  }
  const provider = recipeProvider(parsed.provider);
  const endpoint = isCustomEndpointId(parsed.provider) ? selectedCustomEndpoint('chat') : undefined;
  const hasDedicatedModel = Boolean(($<HTMLSelectElement>('#ocr-provider')).value && ($<HTMLInputElement>('#ocr-model-name')).value.trim());
  const apiKey = hasDedicatedModel
    ? ($<HTMLInputElement>('#ocr-api-key')).value.trim()
    : ($<HTMLInputElement>('#chat-api-key')).value.trim();
  status.textContent = '正在发送一张测试图片…';
  setBusy(button, true);
  try {
    const result = await window.pmbrainDesktop.testModelConnection({
      provider,
      model: parsed.model,
      baseUrl: endpoint?.baseUrl,
      apiKey,
      touchpoint: 'ocr',
    });
    renderModelConnectionResult('ocr', result);
  } catch (error) {
    status.classList.add('error');
    status.textContent = `✕ ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    setBusy(button, false);
  }
}

async function renderDailyPersonCard(entityId: string): Promise<void> {
  const target = $('#daily-person-card');
  try {
    const card = await window.pmbrainDesktop.productPeopleCard(entityId) as {
      entity_id: string;
      name: string;
      company: string | null;
      role: string | null;
      last_contact_label: string | null;
      open_items: number;
      recent_meetings: number;
      members: Array<{ source_id: string; slug: string; source_label: string; title: string }>;
      timeline: Array<{ date: string; summary: string }>;
    };
    target.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = card.name;
    const facts = document.createElement('div');
    facts.className = 'daily-person-facts';
    facts.textContent = `当前公司：${card.company || '暂无'}\n当前职位：${card.role || '暂无'}\n最近联系：${card.last_contact_label || '暂无'}\n未完成事项：${card.open_items}\n最近会议：${card.recent_meetings} 次`;
    const members = document.createElement('div');
    for (const member of card.members) {
      const row = document.createElement('div');
      row.textContent = `${member.source_label} · ${member.title}`;
      const unlink = document.createElement('button');
      unlink.type = 'button';
      unlink.className = 'ghost';
      unlink.textContent = '取消关联';
      unlink.addEventListener('click', () => {
        void window.pmbrainDesktop.productUnlinkPeople({ entity_id: card.entity_id, source_id: member.source_id, slug: member.slug })
          .then(() => refreshDailyPeople())
          .then(() => renderDailyPersonCard(card.entity_id))
          .catch((error) => setNotice('error', error instanceof Error ? error.message : String(error)));
      });
      row.append(unlink);
      members.append(row);
    }
    const timeline = document.createElement('p');
    timeline.textContent = card.timeline.length > 0
      ? `时间线：${card.timeline.map((row) => `${row.date.slice(0, 10)} ${row.summary}`).join('；')}`
      : '时间线：暂无';
    target.append(title, facts, members, timeline);
    target.hidden = false;
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  }
}

function applyGoogleEnvelope(result: { ok: boolean; status: string; next_action?: { user_message?: string; command?: string }; error?: { code: string; problem?: string; fix?: string }; account?: string }): void {
  const message = $('#daily-google-message');
  const pasteWrap = $('#daily-google-paste-wrap');
  const openConsent = $<HTMLButtonElement>('#daily-google-open-consent');
  const userMessage = result.next_action?.user_message?.replace('[SHOW USER]', '').replace('[/SHOW USER]', '').trim() ?? '';
  message.hidden = !userMessage;
  message.textContent = userMessage;
  googleConsentUrl = extractConsentUrl(userMessage) ?? '';
  openConsent.hidden = !googleConsentUrl;
  const needsPaste = result.status === 'awaiting_consent' || (result.next_action?.command ?? '').includes('--code');
  pasteWrap.hidden = !needsPaste;
  $<HTMLInputElement>('#daily-google-redirect').value = '';
  if (result.ok && result.status === 'connected') {
    setNotice('success', `Google 已连接${result.account ? `：${result.account}` : ''}`);
    void refreshDailyPanel();
    return;
  }
  if (result.status === 'needs_client_credentials') {
    setNotice('error', '还需要 Google 客户端 JSON。请选择 Desktop 应用下载的文件。');
    return;
  }
  if (needsPaste) {
    setNotice('success', '如果浏览器打不开 127.0.0.1，把地址栏完整网址粘贴回来。');
    return;
  }
  if (result.error) setNotice('error', result.error.fix || result.error.problem || result.error.code);
}

document.querySelectorAll<HTMLButtonElement>('.rail-item').forEach((button) => button.addEventListener('click', () => {
  const target = button.dataset.target as Panel;
  switchPanel(target);
  if (target === 'models' && ($<HTMLDetailsElement>('#advanced-model-settings')).open) {
    void loadAdvancedModels(true);
  }
  if (target === 'integrations') refreshIntegrationPanel();
  if (target === 'repair') void loadPgliteUpgradeBackups();
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
document.querySelectorAll<HTMLButtonElement>('.advanced-phase-inherit').forEach(button => button.addEventListener('click', () => {
  const phase = button.dataset.advancedPhase as AdvancedModelPhase;
  const prefix = advancedPhaseId(phase);
  ($<HTMLSelectElement>(`#${prefix}-provider`)).value = '';
  const input = $<HTMLInputElement>(`#${prefix}-model-name`);
  input.value = '';
  input.disabled = true;
  $<HTMLElement>(`#${prefix}-model-status`).textContent = '已恢复跟随任务层级 / 普通模型。';
}));
$('#save-advanced-models').addEventListener('click', () => void saveAdvancedModels());
document.querySelectorAll<HTMLButtonElement>('.choose').forEach((button) => button.addEventListener('click', async () => {
  const input = $<HTMLInputElement>(`#${button.dataset.input}`);
  const selected = await window.pmbrainDesktop.chooseDirectory(input.value);
  if (!selected) return;
  input.value = button.dataset.input === 'database-path'
    ? normalizePglitePathForDisplay(selected)
    : selected;
  if (button.dataset.input === 'knowledge-directory') {
    await refreshKnowledgeSourceStatus(selected);
  }
}));
$('#knowledge-directory').addEventListener('change', () => {
  void refreshKnowledgeSourceStatus(($<HTMLInputElement>('#knowledge-directory')).value);
});
$('#enable-knowledge-source-git').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#enable-knowledge-source-git');
  const path = ($<HTMLInputElement>('#knowledge-directory')).value.trim();
  if (!path) return;
  setBusy(button, true, '正在启用…');
  try {
    const status = await window.pmbrainDesktop.initializeKnowledgeSourceGit(path);
    if (($<HTMLInputElement>('#knowledge-directory')).value.trim() !== path) return;
    renderKnowledgeSourceStatus(status);
    setNotice('success', `已为主源 ${status.sourceName} 启用 Git 自动同步。`);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(button, false, '启用 Git 自动同步');
  }
});
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
$('#memory-open-integrations').addEventListener('click', () => {
  switchPanel('integrations');
  refreshIntegrationPanel();
});
$('#shared-open-admin').addEventListener('click', () => void window.pmbrainDesktop.openAdmin());
$('#open-logs').addEventListener('click', () => void window.pmbrainDesktop.openLogs());
$('#repair-prune-backups').addEventListener('click', () => void prunePgliteUpgradeBackups());
$('#repair-open-backup-root').addEventListener('click', () => {
  const root = $('#repair-backup-root').textContent?.trim();
  if (!root || root === '完成 PGLite 配置后，这里会显示备份保存位置。' || root === '无法读取备份目录') return;
  void openPgliteUpgradeBackup(root);
});
$('#repair-change-backup-root').addEventListener('click', () => void changePgliteUpgradeBackupRoot());
$('#export-diagnostic').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#export-diagnostic');
  setBusy(button, true, '正在收集…');
  try {
    const result = await window.pmbrainDesktop.exportDiagnosticBundle();
    if (result) setNotice('success', `诊断包已导出：${result.fileName}`);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(button, false, '导出诊断包');
  }
});
$('#open-admin').addEventListener('click', () => void window.pmbrainDesktop.openAdmin());
$('#finish-open-admin').addEventListener('click', () => void window.pmbrainDesktop.openAdmin());
$('#copy-result').addEventListener('click', () => void window.pmbrainDesktop.copy(lastResult));
$<HTMLButtonElement>('#integration-progress-close').addEventListener('click', () => $<HTMLDialogElement>('#integration-progress-dialog').close());
$<HTMLDialogElement>('#integration-progress-dialog').addEventListener('cancel', (event) => {
  if ($<HTMLButtonElement>('#integration-progress-close').disabled) event.preventDefault();
});
$('#recovery-toast-diagnose').addEventListener('click', () => void diagnoseToast('recovery'));
$('#recovery-toast-replace').addEventListener('click', () => void replaceToast('recovery'));
$('#repair-toast-diagnose').addEventListener('click', () => void diagnoseToast('repair'));
$('#repair-toast-replace').addEventListener('click', () => void replaceToast('repair'));
$('#recovery-retry').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#recovery-retry');
  setBusy(button, true, '正在重启…');
  try { await window.pmbrainDesktop.retry(); } finally { setBusy(button, false, '重新启动服务'); }
});
$('#recovery-terminate').addEventListener('click', async () => {
  if (!recoveryOwnerPid) return;
  if (!confirm(
    `确认结束 PID ${recoveryOwnerPid} 并重启 PMBrain？\n\n只会结束经过身份校验的 PMBrain 占用进程，不会删除数据库、知识内容或锁文件。`,
  )) return;
  const button = $<HTMLButtonElement>('#recovery-terminate');
  const retryButton = $<HTMLButtonElement>('#recovery-retry');
  const pid = recoveryOwnerPid;
  setBusy(button, true, '正在结束并重启…');
  retryButton.disabled = true;
  clearNotices();
  try {
    await window.pmbrainDesktop.terminatePgliteOwnerAndRetry(pid);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
    await refreshPgliteRecoveryStatus();
  } finally {
    setBusy(button, false, '结束占用进程并重启');
    retryButton.disabled = false;
  }
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
$('#docker-install-guide').addEventListener('click', () => void window.pmbrainDesktop.openDockerInstallGuide());
let dockerMigrationPlan: Awaited<ReturnType<typeof window.pmbrainDesktop.inspectDockerMigration>> | null = null;
$('#migrate-to-docker').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#migrate-to-docker');
  setBusy(button, true, '正在扫描旧库…');
  clearNotices();
  try {
    const plan = await window.pmbrainDesktop.inspectDockerMigration();
    dockerMigrationPlan = plan;
    const counts = { direct: 0, convert: 0, skip: 0, unknown: 0 };
    for (const table of plan.tables) counts[table.action] += 1;
    $('#docker-migration-summary').textContent = `旧库 Schema ${plan.schemaVersion ?? '未记录'}：${counts.direct} 张直接迁移、${counts.convert} 张自动转换、${counts.skip} 张跳过、${counts.unknown} 张需要决定。`;
    const details = $('#docker-migration-details');
    details.replaceChildren();
    for (const table of plan.tables.filter(item => item.action !== 'direct')) {
      const line = document.createElement('li');
      const label = table.action === 'convert' ? '自动转换' : table.action === 'skip' ? '跳过' : '未知旧表';
      line.textContent = `${label}：${table.name}（${table.rows} 条）— ${table.reason}`;
      details.append(line);
    }
    $<HTMLInputElement>('#docker-migration-skip-unknown').checked = false;
    const blocked = plan.tables.some(table => table.action === 'unknown' && table.skippable === false);
    $<HTMLElement>('#docker-migration-unknown-choice').hidden = counts.unknown === 0 || blocked;
    $<HTMLButtonElement>('#docker-migration-confirm').disabled = counts.unknown > 0;
    if (blocked) {
      const line = document.createElement('li');
      line.textContent = '正式数据存在无法安全转换的结构，本次迁移已阻止；请保留旧库并查看诊断报告。';
      details.append(line);
    }
    $<HTMLElement>('#docker-migration-plan').hidden = false;
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(button, false, '重新扫描迁移方案');
  }
});
$<HTMLInputElement>('#docker-migration-skip-unknown').addEventListener('change', () => {
  const blocked = dockerMigrationPlan?.tables.some(table => table.action === 'unknown' && table.skippable === false);
  $<HTMLButtonElement>('#docker-migration-confirm').disabled = !!blocked || !$<HTMLInputElement>('#docker-migration-skip-unknown').checked;
});
$('#docker-migration-cancel').addEventListener('click', () => {
  dockerMigrationPlan = null;
  $<HTMLElement>('#docker-migration-plan').hidden = true;
});
$('#docker-migration-confirm').addEventListener('click', async () => {
  const plan = dockerMigrationPlan;
  if (!plan) return;
  const button = $<HTMLButtonElement>('#docker-migration-confirm');
  setBusy(button, true, '正在迁移并校验…');
  clearNotices();
  try {
    const result = await window.pmbrainDesktop.migrateToDocker(plan.fingerprint, $<HTMLInputElement>('#docker-migration-skip-unknown').checked);
    dockerMigrationPlan = null;
    $<HTMLElement>('#docker-migration-plan').hidden = true;
    populate(await window.pmbrainDesktop.getSetup());
    const skipped = result.skippedTables.length > 0 ? `；跳过 ${result.skippedTables.length} 张历史或用户确认的旧表` : '';
    setNotice('success', `迁移完成：${result.tables} 张表、${result.rows} 条记录已核对${skipped}；原 PGLite 冷备：${result.backupDirectory}；报告：${result.reportPath}。`);
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(button, false, '备份并开始迁移');
  }
});
$('#update-action').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#update-action');
  try {
    if (button.dataset.action === 'install') await window.pmbrainDesktop.installUpdate();
    else if (button.dataset.action === 'download') renderUpdate(await window.pmbrainDesktop.downloadUpdate());
    else renderUpdate(await window.pmbrainDesktop.checkUpdates());
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  }
});
void window.pmbrainDesktop.getTheme().then(renderTheme).catch(() => undefined);
window.pmbrainDesktop.onThemeState(renderTheme);
void window.pmbrainDesktop.getSystemSettings().then((next) => applySystemSettingsState(next)).catch((error) => setNotice('error', String(error)));
window.pmbrainDesktop.onSystemSettingsState((next) => applySystemSettingsState(next));
$('#setup-wait-defer').addEventListener('click', () => {
  void window.pmbrainDesktop.chooseEmbeddingRebuild('defer');
});
$('#setup-wait-continue').addEventListener('click', () => {
  void window.pmbrainDesktop.chooseEmbeddingRebuild('wait');
});
void window.pmbrainDesktop.getStartupProgress().then(renderStartupProgress).catch(() => undefined);
window.pmbrainDesktop.onStartupProgress(renderStartupProgress);
refreshIntegrationPanel();
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
  if (panel === 'integrations') refreshIntegrationPanel();
  if (panel === 'repair') void loadPgliteUpgradeBackups();
});
if (!$<HTMLInputElement>('#daily-chronicle-date').value) {
  const now = new Date();
  $<HTMLInputElement>('#daily-chronicle-date').value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
$('#daily-google-client').addEventListener('click', async () => {
  const path = await window.pmbrainDesktop.chooseFile([{ name: 'JSON', extensions: ['json'] }]);
  if (!path) return;
  googleClientJsonPath = path;
  $('#daily-google-client-name').textContent = path.replace(/^.*[\\/]/, '');
});
$('#daily-google-connect').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#daily-google-connect');
  setBusy(button, true, '请在浏览器完成授权…');
  try {
    applyGoogleEnvelope(await window.pmbrainDesktop.googleConnect({
      account: $<HTMLInputElement>('#daily-google-account').value.trim() || undefined,
      clientJsonPath: googleClientJsonPath || undefined,
    }));
  } catch (error) {
    setNotice('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(button, false, '连接 Google');
  }
});
$('#daily-google-paste-mode').addEventListener('click', async () => {
  applyGoogleEnvelope(await window.pmbrainDesktop.googleConnect({
    account: $<HTMLInputElement>('#daily-google-account').value.trim() || undefined,
    clientJsonPath: googleClientJsonPath || undefined,
    paste: true,
  }));
});
$('#daily-google-finish').addEventListener('click', async () => {
  const pasted = $<HTMLInputElement>('#daily-google-redirect').value.trim();
  if (!pasted) return;
  applyGoogleEnvelope(await window.pmbrainDesktop.googleConnect({
    account: $<HTMLInputElement>('#daily-google-account').value.trim() || undefined,
    clientJsonPath: googleClientJsonPath || undefined,
    code: pasted,
  }));
});
$('#daily-google-open-consent').addEventListener('click', () => {
  if (googleConsentUrl) void window.pmbrainDesktop.openExternal(googleConsentUrl);
});
$('#daily-google-source-save').addEventListener('click', async () => {
  const account = $<HTMLInputElement>('#daily-google-account').value.trim();
  if (!account) {
    setNotice('error', '请先连接 Google 账号');
    return;
  }
  await window.pmbrainDesktop.googleSource({
    account,
    id: $<HTMLInputElement>('#daily-google-source').value.trim() || undefined,
  });
  setNotice('success', 'Google 知识源已登记');
  void refreshDailyPanel();
});
$('#daily-chat-save').addEventListener('click', async () => {
  const secret = $<HTMLInputElement>('#daily-chat-secret').value.trim();
  if (!activeDailyConnector || !secret) {
    setNotice('error', '请先选择 ChatGPT 或 Claude，并粘贴整行 Cookie:');
    return;
  }
  const result = await window.pmbrainDesktop.productConnectorAuth({ provider: activeDailyConnector, cookie: secret }) as { ok?: boolean; error?: string };
  if (result.ok === false) {
    setNotice('error', result.error || '连接失败');
    return;
  }
  $<HTMLInputElement>('#daily-chat-secret').value = '';
  setNotice('success', `${activeDailyConnector === 'chatgpt' ? 'ChatGPT' : 'Claude'} 已连接`);
  void refreshDailyPanel();
});
$('#daily-chat-sync').addEventListener('click', async () => {
  if (!activeDailyConnector) return;
  await window.pmbrainDesktop.productConnectorSync({ provider: activeDailyConnector });
  setNotice('success', '已开始同步');
  void refreshDailyPanel();
});
$('#daily-chat-logout').addEventListener('click', async () => {
  if (!activeDailyConnector) return;
  await window.pmbrainDesktop.productConnectorLogout(activeDailyConnector);
  setNotice('success', '已断开连接');
  activeDailyConnector = '';
  void refreshDailyPanel();
});
$('#daily-chronicle-date').addEventListener('change', () => void refreshDailyPanel());
$('#daily-waiting-scan').addEventListener('click', async () => {
  const lanes = (['gmail', 'meeting', 'conversation'] as const)
    .filter((key) => $<HTMLInputElement>(`#daily-waiting-${key}`).checked);
  await window.pmbrainDesktop.productWaitingScan(lanes);
  setNotice('success', '已开始扫描待办');
  void refreshDailyPanel();
});
$('#daily-chronicle-enable').addEventListener('click', async () => {
  await window.pmbrainDesktop.productEnableChronicle();
  setNotice('success', '已开启时间记忆');
  void refreshDailyPanel();
});
$('#daily-chronicle-history').addEventListener('click', async () => {
  await window.pmbrainDesktop.productOrganizeChronicleHistory();
  setNotice('success', '已开始整理历史记录');
  void refreshDailyPanel();
});
$('#daily-identity-search').addEventListener('click', () => void refreshDailyPeople());
$('#daily-identity-merge').addEventListener('click', async () => {
  const members = Array.from($('#daily-identity-results').querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
    .map((box) => ({
      source_id: box.dataset.sourceId ?? '',
      slug: box.dataset.slug ?? '',
      title: box.dataset.title,
    }))
    .filter((item) => item.source_id && item.slug);
  if (members.length < 2) {
    setNotice('error', '请至少勾选两条记录');
    return;
  }
  const result = await window.pmbrainDesktop.productMergePeople(members) as { entity_id?: string };
  setNotice('success', '已把选中的记录视为同一个人');
  await refreshDailyPanel();
  if (result.entity_id) void renderDailyPersonCard(result.entity_id);
});
