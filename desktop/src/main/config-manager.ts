import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { getRecipe } from '../../../src/core/ai/recipes/index.js';
import { assertModelRevision, modelConfigRevision } from './models/model-config-revision.js';

const DESKTOP_RECOMMENDED_EMBEDDING_DIMENSIONS: Readonly<Record<string, number>> = {
  'zhipu:embedding-3': 1024,
  'zhipu:embedding-2': 1024,
  'zeroentropyai:zembed-1': 1280,
  'mimo:text-embedding-3-small': 1536,
  'openai:text-embedding-3-small': 1536,
  'openai:text-embedding-3-large': 1536,
  'deepseek:deepseek-embedding': 1536,
  'google:gemini-embedding-001': 768,
  'google:text-embedding-004': 768,
  'voyage:voyage-3': 1024,
  'voyage:voyage-3-lite': 512,
  'dashscope:text-embedding-v3': 1024,
  'minimax:embo-01': 1536,
  'ollama:nomic-embed-text': 768,
  'ollama:mxbai-embed-large': 1024,
  'ollama:all-minilm': 384,
};

export type DesktopTheme = 'system' | 'light' | 'dark';
export type DesktopNetworkMode = 'local' | 'shared';
export type DesktopCloseBehavior = 'tray' | 'quit';

export interface DesktopPreferences {
  networkMode: DesktopNetworkMode;
  closeBehavior: DesktopCloseBehavior;
  startMinimized: boolean;
  sharedAdapter?: string;
  sharedIp?: string;
  sharedResumeRequired: boolean;
  dockerContainerName?: string;
}

export interface DesktopDatabaseRuntimeConfig {
  engine: 'pglite' | 'postgres';
  databaseUrl?: string;
  configuredContainerName?: string;
}

export type DesktopCustomTouchpoint = 'chat' | 'embedding';

export interface DesktopCustomProvider {
  id: 'custom-openai';
  displayName: string;
  /** Legacy single-endpoint payload accepted for backward compatibility. */
  baseUrl?: string;
  baseUrls?: Partial<Record<DesktopCustomTouchpoint, string>>;
}

export interface DesktopCustomEndpoint {
  id: string;
  displayName: string;
  baseUrl: string;
  modelId: string;
  apiKey?: string;
}

export interface DesktopCustomProviderCatalog {
  chat: DesktopCustomEndpoint[];
  embedding: DesktopCustomEndpoint[];
}

export interface DesktopCustomProviderSelection {
  chat?: string;
  embedding?: string;
}

export const CUSTOM_ENDPOINT_PREFIX = 'custom-endpoint-';

export function isCustomEndpointId(value: string): boolean {
  return value === 'custom-openai' || value.startsWith(CUSTOM_ENDPOINT_PREFIX);
}

export function createCustomEndpointId(kind: DesktopCustomTouchpoint): string {
  return `${CUSTOM_ENDPOINT_PREFIX}${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeDesktopTheme(value: unknown): DesktopTheme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function normalizeDesktopNetworkMode(value: unknown): DesktopNetworkMode {
  return value === 'shared' ? 'shared' : 'local';
}

export function normalizeDesktopCloseBehavior(value: unknown): DesktopCloseBehavior {
  return value === 'quit' ? 'quit' : 'tray';
}

function desktopRecommendedEmbeddingDimension(model: string): number {
  const known = DESKTOP_RECOMMENDED_EMBEDDING_DIMENSIONS[model];
  if (known) return known;
  // OpenAI-compatible custom endpoints most commonly expose 1024d models.
  // The CLI remains the advanced escape hatch for a custom fixed width.
  return 1024;
}

function hasKnownDesktopEmbeddingDimension(model: string): boolean {
  return DESKTOP_RECOMMENDED_EMBEDDING_DIMENSIONS[model] !== undefined;
}

export interface SetupPayload {
  engine: 'pglite' | 'postgres';
  expectedModelRevision?: string;
  theme?: DesktopTheme;
  resetAdvancedModelRouting?: boolean;
  confirmEmbeddingRebuild?: boolean;
  confirmLegacyEmbeddingRecovery?: boolean;
  databasePath?: string;
  databaseUrl?: string;
  knowledgeDirectory?: string;
  knowledgeSourceId?: string;
  knowledgeSourceChanged?: boolean;
  modelConfig?: {
    chatModel?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    ocrEnabled?: boolean;
    ocrModel?: string;
  };
  customProvider?: DesktopCustomProvider;
  customProviders?: DesktopCustomProviderCatalog;
  customSelection?: DesktopCustomProviderSelection;
  keys?: Partial<Record<
    'mimo' | 'zhipu' | 'deepseek' | 'openai' | 'anthropic' | 'zeroentropy' |
    'google' | 'voyage' | 'groq' | 'together' | 'openrouter' | 'minimax' | 'dashscope' |
    'customOpenai' | 'customOpenaiChat' | 'customOpenaiEmbedding',
    string
  >>;
}

export interface SetupInfo {
  needsSetup: boolean;
  modelRevision?: string;
  configPath: string;
  defaults: { databasePath: string; knowledgeDirectory: string };
  current: {
    engine: 'pglite' | 'postgres';
    databasePath?: string;
    databaseUrl?: string;
    databaseConfigured: boolean;
    knowledgeDirectory?: string;
    knowledgeSourceId?: string;
    chatModel?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    ocrEnabled?: boolean;
    ocrModel?: string;
    legacyEmbeddingRecoveryCandidate?: {
      model: string;
      dimensions: number;
    };
    /** Global generative gate; false when missing. */
    generativeEnabled?: boolean;
    customProvider?: DesktopCustomProvider;
    customProviders?: DesktopCustomProviderCatalog;
    customSelection?: DesktopCustomProviderSelection;
    theme: DesktopTheme;
    keyStatus: Record<string, boolean>;
    keyValues: Record<string, string | undefined>;
    lastMigratedVersion?: string;
    mainSourcePathRepairCompleted?: boolean;
  };
}

export interface ConfigSnapshot {
  path: string;
  existed: boolean;
  content?: string;
}

type RawConfig = Record<string, unknown> & {
  engine?: 'pglite' | 'postgres';
  database_path?: string;
  database_url?: string;
  embedding_model?: string;
  embedding_dimensions?: number;
  ocr_enabled?: boolean;
  ocr_model?: string;
  provider_base_urls?: Record<string, string>;
  provider_touchpoint_base_urls?: Record<string, Partial<Record<'embedding' | 'expansion' | 'chat' | 'reranker', string>>>;
  provider_touchpoint_api_keys?: Record<string, Partial<Record<'embedding' | 'expansion' | 'chat' | 'reranker', string>>>;
  custom_openai_api_key?: string;
  zeroentropy_api_key?: string;
  admin_bootstrap_token?: string;
  desktop?: {
    setup_completed?: boolean;
    knowledge_directory?: string;
    knowledge_source_id?: string;
    last_migrated_version?: string;
    main_source_path_repair_completed?: boolean;
    theme?: DesktopTheme;
    network_mode?: DesktopNetworkMode;
    close_behavior?: DesktopCloseBehavior;
    start_minimized?: boolean;
    shared_adapter?: string;
    shared_ip?: string;
    shared_resume_required?: boolean;
    docker_container_name?: string;
    custom_openai_display_name?: string;
    custom_endpoints?: DesktopCustomProviderCatalog;
    custom_endpoint_selection?: DesktopCustomProviderSelection;
    tray_hint_shown?: boolean;
  };
};

function normalizeCustomProvider(value: DesktopCustomProvider): DesktopCustomProvider {
  if (value.id !== 'custom-openai') throw new Error('自定义接口 ID 必须为 custom-openai。');
  const displayName = value.displayName.trim();
  if (!displayName) throw new Error('请填写自定义接口显示名称。');
  if (displayName.length > 80 || /[\r\n]/.test(displayName)) {
    throw new Error('自定义接口显示名称不能超过 80 个字符或包含换行。');
  }
  const legacyBaseUrl = value.baseUrl?.trim();
  const candidates = {
    chat: value.baseUrls?.chat?.trim() || legacyBaseUrl,
    embedding: value.baseUrls?.embedding?.trim() || legacyBaseUrl,
  };
  const baseUrls: Partial<Record<'chat' | 'embedding', string>> = {};
  for (const [touchpoint, rawBaseUrl] of Object.entries(candidates) as Array<['chat' | 'embedding', string | undefined]>) {
    if (!rawBaseUrl) continue;
    if (rawBaseUrl.length > 2048) throw new Error('请填写有效的自定义接口 Base URL。');
    let parsed: URL;
    try {
      parsed = new URL(rawBaseUrl);
    } catch {
      throw new Error('自定义接口 Base URL 格式无效，请填写完整的 http:// 或 https:// 地址。');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('自定义接口 Base URL 只能使用 http/https，且不能包含账号、查询参数或锚点。');
    }
    baseUrls[touchpoint] = rawBaseUrl.replace(/\/+$/, '');
  }
  if (!baseUrls.chat && !baseUrls.embedding) throw new Error('请填写有效的自定义接口 Base URL。');
  return {
    id: 'custom-openai',
    displayName,
    baseUrls,
  };
}

function normalizeCustomBaseUrl(rawBaseUrl: string): string {
  if (rawBaseUrl.length > 2048) throw new Error('请填写有效的自定义接口 Base URL。');
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error('自定义接口 Base URL 格式无效，请填写完整的 http:// 或 https:// 地址。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('自定义接口 Base URL 只能使用 http/https，且不能包含账号、查询参数或锚点。');
  }
  return rawBaseUrl.replace(/\/+$/, '');
}

function normalizeCustomDisplayName(value: string): string {
  const displayName = value.trim();
  if (!displayName) throw new Error('请填写自定义接口显示名称。');
  if (displayName.length > 80 || /[\r\n]/.test(displayName)) {
    throw new Error('自定义接口显示名称不能超过 80 个字符或包含换行。');
  }
  return displayName;
}

export function normalizeCustomEndpoint(
  value: DesktopCustomEndpoint,
  kind: DesktopCustomTouchpoint,
  index: number,
): DesktopCustomEndpoint {
  const displayName = normalizeCustomDisplayName(value.displayName);
  const baseUrl = normalizeCustomBaseUrl(value.baseUrl?.trim() || '');
  const modelId = value.modelId?.trim() || '';
  if (!modelId) throw new Error('请填写自定义模型名称（模型 ID）。');
  if (modelId.length > 160 || /[\r\n]/.test(modelId)) {
    throw new Error('自定义模型名称不能超过 160 个字符或包含换行。');
  }
  const rawId = value.id?.trim() || '';
  const id = rawId.startsWith(`${CUSTOM_ENDPOINT_PREFIX}${kind}-`)
    ? rawId
    : `${CUSTOM_ENDPOINT_PREFIX}${kind}-${index + 1}`;
  const apiKey = value.apiKey?.trim();
  return {
    id,
    displayName,
    baseUrl,
    modelId,
    ...(apiKey ? { apiKey } : {}),
  };
}

export function normalizeCustomProviderCatalog(value: DesktopCustomProviderCatalog): DesktopCustomProviderCatalog {
  return {
    chat: (value.chat ?? []).map((item, index) => normalizeCustomEndpoint(item, 'chat', index)),
    embedding: (value.embedding ?? []).map((item, index) => normalizeCustomEndpoint(item, 'embedding', index)),
  };
}

export function emptyCustomProviderCatalog(): DesktopCustomProviderCatalog {
  return { chat: [], embedding: [] };
}

function catalogFromLegacyProvider(
  provider: DesktopCustomProvider | undefined,
  chatModelId = '',
  embeddingModelId = '',
): DesktopCustomProviderCatalog {
  const catalog = emptyCustomProviderCatalog();
  if (!provider) return catalog;
  if (provider.baseUrls?.chat) {
    catalog.chat.push({
      id: `${CUSTOM_ENDPOINT_PREFIX}chat-legacy`,
      displayName: provider.displayName,
      baseUrl: provider.baseUrls.chat,
      modelId: chatModelId,
    });
  }
  if (provider.baseUrls?.embedding) {
    catalog.embedding.push({
      id: `${CUSTOM_ENDPOINT_PREFIX}embedding-legacy`,
      displayName: provider.displayName,
      baseUrl: provider.baseUrls.embedding,
      modelId: embeddingModelId,
    });
  }
  return catalog;
}

function modelNameAfterPrefix(model: string | undefined, prefix: string): string {
  if (!model?.startsWith(prefix)) return '';
  return model.slice(prefix.length);
}

function readStoredCustomCatalog(
  desktop: RawConfig['desktop'] | undefined,
  legacy: DesktopCustomProvider | undefined,
  chatModel?: string,
  embeddingModel?: string,
): { catalog: DesktopCustomProviderCatalog; selection: DesktopCustomProviderSelection } {
  const chatModelId = modelNameAfterPrefix(chatModel, 'custom-openai:');
  const embeddingModelId = modelNameAfterPrefix(embeddingModel, 'custom-openai:');
  if (desktop?.custom_endpoints) {
    const catalog = normalizeCustomProviderCatalog(desktop.custom_endpoints);
    const stored = desktop.custom_endpoint_selection ?? {};
    return {
      catalog,
      selection: {
        chat: catalog.chat.some(item => item.id === stored.chat)
          ? stored.chat
          : catalog.chat.find(item => item.modelId === chatModelId)?.id ?? catalog.chat[0]?.id,
        embedding: catalog.embedding.some(item => item.id === stored.embedding)
          ? stored.embedding
          : catalog.embedding.find(item => item.modelId === embeddingModelId)?.id ?? catalog.embedding[0]?.id,
      },
    };
  }
  const catalog = catalogFromLegacyProvider(legacy, chatModelId, embeddingModelId);
  return {
    catalog,
    selection: {
      chat: catalog.chat[0]?.id,
      embedding: catalog.embedding[0]?.id,
    },
  };
}

function selectedCustomEndpoint(
  catalog: DesktopCustomProviderCatalog,
  selection: DesktopCustomProviderSelection,
  kind: DesktopCustomTouchpoint,
): DesktopCustomEndpoint | undefined {
  const id = selection[kind];
  return catalog[kind].find(item => item.id === id) ?? catalog[kind][0];
}

function legacyProviderFromCatalog(
  catalog: DesktopCustomProviderCatalog,
  selection: DesktopCustomProviderSelection,
): DesktopCustomProvider | undefined {
  const chat = selectedCustomEndpoint(catalog, selection, 'chat');
  const embedding = selectedCustomEndpoint(catalog, selection, 'embedding');
  if (!chat && !embedding) return undefined;
  return {
    id: 'custom-openai',
    displayName: chat?.displayName || embedding?.displayName || '自定义 OpenAI 接口',
    baseUrls: {
      ...(chat ? { chat: chat.baseUrl } : {}),
      ...(embedding ? { embedding: embedding.baseUrl } : {}),
    },
  };
}

/**
 * Resolve the user home directory for config discovery.
 * Prefer HOME / USERPROFILE so tests and sandboxed CI runners can isolate
 * config roots without fighting os.homedir() passwd-entry caching.
 */
function resolveUserHome(): string {
  const fromEnv = (process.env.HOME || process.env.USERPROFILE || '').trim();
  if (fromEnv) return resolve(fromEnv);
  return homedir();
}

function preferredHome(): string {
  const override = process.env.PMBRAIN_HOME?.trim();
  if (override) return join(resolve(override), '.pmbrain');
  return join(resolveUserHome(), '.pmbrain');
}

export function preferredConfigDirectory(): string {
  return preferredHome();
}

export function activeConfigDirectory(): string {
  return preferredHome();
}

export function desktopConfigPath(): string {
  return join(activeConfigDirectory(), 'config.json');
}

export function ensureFreshDesktopSetup(): boolean {
  const path = desktopConfigPath();
  if (existsSync(path)) return false;
  const directory = preferredConfigDirectory();
  writeJsonConfig(path, {
    engine: 'pglite',
    database_path: join(directory, 'brain.pglite'),
    embedding_disabled: true,
    desktop: {
      setup_completed: false,
      knowledge_directory: join(homedir(), 'Documents', 'PMBrain'),
      theme: 'system',
    },
  });
  return true;
}

export function normalizePgliteDatabasePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  return basename(trimmed).toLowerCase().endsWith('.pglite')
    ? trimmed
    : join(trimmed, 'brain.pglite');
}

function desktopWriteConfigPath(): string {
  return desktopConfigPath();
}

function stripJsonBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function readConfig(path = desktopConfigPath()): RawConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(stripJsonBom(readFileSync(path, 'utf8'))) as RawConfig;
  } catch (error) {
    throw new Error(`无法读取 PMBrain 配置：${error instanceof Error ? error.message : String(error)}`);
  }
}

function preferencesFromConfig(config: RawConfig | null): DesktopPreferences {
  const desktop = config?.desktop;
  const sharedAdapter = typeof desktop?.shared_adapter === 'string' && desktop.shared_adapter.trim()
    ? desktop.shared_adapter.trim()
    : undefined;
  const sharedIp = typeof desktop?.shared_ip === 'string' && isIP(desktop.shared_ip.trim()) === 4
    ? desktop.shared_ip.trim()
    : undefined;
  const dockerContainerName = typeof desktop?.docker_container_name === 'string' && desktop.docker_container_name.trim()
    ? desktop.docker_container_name.trim()
    : undefined;
  return {
    networkMode: normalizeDesktopNetworkMode(desktop?.network_mode),
    closeBehavior: normalizeDesktopCloseBehavior(desktop?.close_behavior),
    startMinimized: desktop?.start_minimized === true,
    sharedAdapter,
    sharedIp,
    sharedResumeRequired: desktop?.shared_resume_required === true,
    dockerContainerName,
  };
}

export function getDesktopPreferences(): DesktopPreferences {
  return preferencesFromConfig(readConfig());
}

export function getDatabaseRuntimeConfig(): DesktopDatabaseRuntimeConfig {
  const config = readConfig();
  return {
    engine: config?.engine === 'postgres' ? 'postgres' : 'pglite',
    databaseUrl: typeof config?.database_url === 'string' ? config.database_url : undefined,
    configuredContainerName: preferencesFromConfig(config).dockerContainerName,
  };
}

function backupPath(kind: 'config' | 'mcp', originalPath: string, rootDirectory = activeConfigDirectory()): string {
  const directory = join(rootDirectory, 'backups', kind);
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(directory, `${basename(originalPath)}.${stamp}.bak`);
}

export function backupFile(originalPath: string, kind: 'config' | 'mcp', rootDirectory?: string): string | null {
  if (!existsSync(originalPath)) return null;
  const target = backupPath(kind, originalPath, rootDirectory);
  copyFileSync(originalPath, target);
  return target;
}

export function writeJsonConfig(path: string, value: unknown): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const temporary = `${path}.pmbrain-tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    copyFileSync(temporary, path);
  } catch (error) {
    throw new Error(`无法写入 ${path}。请关闭正在占用该配置的客户端后重试。${error instanceof Error ? ` ${error.message}` : ''}`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const LEGACY_ZEROENTROPY_DEFAULT_MODEL = 'zeroentropyai:zembed-1';

function sameDatabaseTarget(current: RawConfig, historical: RawConfig): boolean {
  const currentEngine = current.engine === 'postgres' ? 'postgres' : 'pglite';
  const historicalEngine = historical.engine === 'postgres' ? 'postgres' : 'pglite';
  if (currentEngine !== historicalEngine) return false;
  if (currentEngine === 'postgres') {
    return Boolean(current.database_url && current.database_url === historical.database_url);
  }
  const currentPath = typeof current.database_path === 'string' ? resolve(current.database_path).toLowerCase() : '';
  const historicalPath = typeof historical.database_path === 'string' ? resolve(historical.database_path).toLowerCase() : '';
  return Boolean(currentPath && currentPath === historicalPath);
}

function findLegacyEmbeddingRecoveryCandidate(config: RawConfig | null): {
  model: string;
  dimensions: number;
} | undefined {
  if (!config
      || config.embedding_model?.trim().toLowerCase() !== LEGACY_ZEROENTROPY_DEFAULT_MODEL
      || Boolean(config.zeroentropy_api_key?.trim())) {
    return undefined;
  }
  const directory = join(activeConfigDirectory(), 'backups', 'config');
  if (!existsSync(directory)) return undefined;
  const names = readdirSync(directory)
    .filter(name => name.startsWith('config.json.') && name.endsWith('.bak'))
    .sort()
    .reverse();
  for (const name of names) {
    const historical = readConfig(join(directory, name));
    if (!historical || !sameDatabaseTarget(config, historical)) continue;
    const model = historical.embedding_model?.trim();
    const dimensions = historical.embedding_dimensions;
    if (!model
        || model.toLowerCase() === LEGACY_ZEROENTROPY_DEFAULT_MODEL
        || !Number.isInteger(dimensions)
        || (dimensions ?? 0) <= 0) {
      continue;
    }
    return { model, dimensions: dimensions! };
  }
  return undefined;
}

export function getSetupInfo(): SetupInfo {
  const path = desktopConfigPath();
  const config = readConfig(path);
  const dir = activeConfigDirectory();
  const pgliteDefaultDir = config?.engine === 'pglite' && config.database_path
    ? dir
    : preferredConfigDirectory();
  const desktop = config?.desktop;
  const customBaseUrl = typeof config?.provider_base_urls?.['custom-openai'] === 'string'
    ? config.provider_base_urls['custom-openai'].trim()
    : '';
  const customTouchpointBaseUrls = config?.provider_touchpoint_base_urls?.['custom-openai'];
  const customChatBaseUrl = customTouchpointBaseUrls?.chat?.trim() || customBaseUrl;
  const customEmbeddingBaseUrl = customTouchpointBaseUrls?.embedding?.trim() || customBaseUrl;
  const sharedCustomKey = typeof config?.custom_openai_api_key === 'string' ? config.custom_openai_api_key : undefined;
  const customTouchpointApiKeys = config?.provider_touchpoint_api_keys?.['custom-openai'];
  const customChatKey = customTouchpointApiKeys?.chat?.trim() || sharedCustomKey;
  const customEmbeddingKey = customTouchpointApiKeys?.embedding?.trim() || sharedCustomKey;
  const legacyCustomProvider = customChatBaseUrl || customEmbeddingBaseUrl ? {
    id: 'custom-openai' as const,
    displayName: desktop?.custom_openai_display_name?.trim() || '自定义 OpenAI 接口',
    baseUrls: {
      ...(customChatBaseUrl ? { chat: customChatBaseUrl } : {}),
      ...(customEmbeddingBaseUrl ? { embedding: customEmbeddingBaseUrl } : {}),
    },
  } : undefined;
  const storedCustom = readStoredCustomCatalog(
    desktop,
    legacyCustomProvider,
    typeof config?.chat_model === 'string' ? config.chat_model : undefined,
    typeof config?.embedding_model === 'string' ? config.embedding_model : undefined,
  );
  return {
    needsSetup: !config || desktop?.setup_completed === false,
    modelRevision: modelConfigRevision(config ?? {}),
    configPath: path,
    defaults: {
      databasePath: join(pgliteDefaultDir, 'brain.pglite'),
      knowledgeDirectory: join(homedir(), 'Documents', 'PMBrain'),
    },
    current: {
      engine: config?.engine === 'postgres' ? 'postgres' : 'pglite',
      databasePath: config?.database_path,
      databaseUrl: typeof config?.database_url === 'string' ? config.database_url : undefined,
      databaseConfigured: Boolean(config?.database_url || config?.database_path),
      knowledgeDirectory: desktop?.knowledge_directory,
      knowledgeSourceId: desktop?.knowledge_source_id,
      chatModel: typeof config?.chat_model === 'string' ? config.chat_model : undefined,
      generativeEnabled: (config as { model_usage?: { generative_enabled?: boolean } } | null)
        ?.model_usage?.generative_enabled === true,
      embeddingModel: typeof config?.embedding_model === 'string' ? config.embedding_model : undefined,
      embeddingDimensions: typeof config?.embedding_dimensions === 'number' ? config.embedding_dimensions : undefined,
      ocrEnabled: config?.ocr_enabled === true || config?.embedding_image_ocr === true,
      ocrModel: typeof config?.ocr_model === 'string'
        ? config.ocr_model
        : typeof config?.embedding_image_ocr_model === 'string' ? config.embedding_image_ocr_model : undefined,
      legacyEmbeddingRecoveryCandidate: findLegacyEmbeddingRecoveryCandidate(config),
      customProvider: legacyProviderFromCatalog(storedCustom.catalog, storedCustom.selection) ?? legacyCustomProvider,
      customProviders: storedCustom.catalog,
      customSelection: storedCustom.selection,
      theme: normalizeDesktopTheme(desktop?.theme),
      keyStatus: {
        mimo: Boolean(config?.mimo_api_key),
        zhipu: Boolean(config?.zhipu_api_key),
        deepseek: Boolean(config?.deepseek_api_key),
        openai: Boolean(config?.openai_api_key),
        anthropic: Boolean(config?.anthropic_api_key),
        zeroentropy: Boolean(config?.zeroentropy_api_key),
        google: Boolean(config?.google_api_key),
        voyage: Boolean(config?.voyage_api_key),
        groq: Boolean(config?.groq_api_key),
        together: Boolean(config?.together_api_key),
        openrouter: Boolean(config?.openrouter_api_key),
        minimax: Boolean(config?.minimax_api_key),
        dashscope: Boolean(config?.dashscope_api_key),
        customOpenai: Boolean(sharedCustomKey),
        customOpenaiChat: Boolean(customChatKey),
        customOpenaiEmbedding: Boolean(customEmbeddingKey),
      },
      keyValues: {
        mimo: typeof config?.mimo_api_key === 'string' ? config.mimo_api_key : undefined,
        zhipu: typeof config?.zhipu_api_key === 'string' ? config.zhipu_api_key : undefined,
        deepseek: typeof config?.deepseek_api_key === 'string' ? config.deepseek_api_key : undefined,
        openai: typeof config?.openai_api_key === 'string' ? config.openai_api_key : undefined,
        anthropic: typeof config?.anthropic_api_key === 'string' ? config.anthropic_api_key : undefined,
        zeroentropy: typeof config?.zeroentropy_api_key === 'string' ? config.zeroentropy_api_key : undefined,
        google: typeof config?.google_api_key === 'string' ? config.google_api_key : undefined,
        voyage: typeof config?.voyage_api_key === 'string' ? config.voyage_api_key : undefined,
        groq: typeof config?.groq_api_key === 'string' ? config.groq_api_key : undefined,
        together: typeof config?.together_api_key === 'string' ? config.together_api_key : undefined,
        openrouter: typeof config?.openrouter_api_key === 'string' ? config.openrouter_api_key : undefined,
        minimax: typeof config?.minimax_api_key === 'string' ? config.minimax_api_key : undefined,
        dashscope: typeof config?.dashscope_api_key === 'string' ? config.dashscope_api_key : undefined,
        customOpenai: sharedCustomKey,
        customOpenaiChat: customChatKey,
        customOpenaiEmbedding: customEmbeddingKey,
      },
      lastMigratedVersion: desktop?.last_migrated_version,
      mainSourcePathRepairCompleted: desktop?.main_source_path_repair_completed === true,
    },
  };
}

export function needsDesktopMigration(version: string): boolean {
  const config = readConfig();
  return Boolean(config && config.desktop?.last_migrated_version !== version);
}

export function markDesktopMigration(version: string): string | null {
  const path = desktopConfigPath();
  const config = readConfig(path);
  if (!config) throw new Error('PMBrain 配置不存在。');
  if (config.desktop?.last_migrated_version === version) return null;
  const backup = backupFile(path, 'config');
  config.desktop = { ...config.desktop, last_migrated_version: version };
  writeJsonConfig(path, config);
  return backup;
}

/**
 * Keep the Desktop's simple ordinary-model aliases in sync without starting
 * the Core CLI. This path is used during Desktop upgrades, where opening the
 * database for a file-only chat-model update is both unnecessary and unsafe:
 * CLI startup may run migrations or embedding provenance repair before the
 * config command itself is dispatched.
 *
 * Deliberately mutate only the two ordinary-model keys. In particular,
 * embedding_model, embedding_dimensions, embedding_disabled, embedding
 * columns, provider credentials, and Desktop migration state remain exactly
 * as the user configured them.
 */
export function syncChatModelDefaultsInConfig(chatModel: string): string | null {
  const normalized = chatModel.trim();
  if (!normalized) return null;
  const path = desktopConfigPath();
  const config = readConfig(path);
  if (!config) throw new Error('PMBrain 配置不存在。');
  if (config.chat_model === normalized && config['models.default'] === normalized) return null;

  const backup = backupFile(path, 'config');
  config.chat_model = normalized;
  config['models.default'] = normalized;
  writeJsonConfig(path, config);
  return backup;
}

export function markMainSourcePathRepairCompleted(): string | null {
  const path = desktopConfigPath();
  const config = readConfig(path);
  if (!config) return null;
  if (config.desktop?.main_source_path_repair_completed === true) return null;
  const backup = backupFile(path, 'config');
  config.desktop = { ...config.desktop, main_source_path_repair_completed: true };
  writeJsonConfig(path, config);
  return backup;
}

export function isTrayHintShown(): boolean {
  return readConfig()?.desktop?.tray_hint_shown === true;
}

export function markTrayHintShown(): string | null {
  const path = desktopConfigPath();
  const config = readConfig(path);
  if (!config) return null;
  if (config.desktop?.tray_hint_shown === true) return null;
  const backup = backupFile(path, 'config');
  config.desktop = { ...config.desktop, tray_hint_shown: true };
  writeJsonConfig(path, config);
  return backup;
}

export function snapshotConfig(): ConfigSnapshot {
  const path = desktopConfigPath();
  return {
    path,
    existed: existsSync(path),
    content: existsSync(path) ? readFileSync(path, 'utf8') : undefined,
  };
}

export function restoreConfig(snapshot: ConfigSnapshot): void {
  if (snapshot.existed && snapshot.content !== undefined) {
    writeFileSync(snapshot.path, snapshot.content, { mode: 0o600 });
  } else {
    rmSync(snapshot.path, { force: true });
  }
}

export function switchToProvisionedPostgres(databaseUrl: string, containerName: string): { snapshot: ConfigSnapshot; backup: string | null } {
  const snapshot = snapshotConfig();
  const config = readConfig(snapshot.path);
  if (!config || config.engine === 'postgres' || !config.database_path) {
    throw new Error('只有已配置 PGLite 数据库的 PMBrain 才能执行一键迁移。');
  }
  const backup = backupFile(snapshot.path, 'config');
  config.engine = 'postgres';
  config.database_url = databaseUrl;
  delete config.database_path;
  config.desktop = { ...config.desktop, docker_container_name: containerName };
  writeJsonConfig(snapshot.path, config);
  return { snapshot, backup };
}

function recipeDefault(provider: string, touchpoint: 'chat' | 'expansion'): string {
  const model = getRecipe(provider)?.touchpoints[touchpoint]?.models[0];
  if (!model) throw new Error(`PMBrain recipe ${provider} 没有可用的 ${touchpoint} 默认模型。`);
  return `${provider}:${model}`;
}

function selectModelDefaults(config: RawConfig): void {
  if (config.mimo_api_key) {
    config.chat_model ??= recipeDefault('mimo', 'chat');
    config.expansion_model ??= recipeDefault('mimo', 'expansion');
  } else if (config.zhipu_api_key) {
    config.chat_model ??= recipeDefault('zhipu', 'chat');
    config.expansion_model ??= recipeDefault('zhipu', 'expansion');
  } else if (config.deepseek_api_key) {
    config.chat_model ??= recipeDefault('deepseek', 'chat');
    config.expansion_model ??= recipeDefault('deepseek', 'expansion');
  } else if (config.openai_api_key) {
    config.chat_model ??= recipeDefault('openai', 'chat');
    config.expansion_model ??= recipeDefault('openai', 'expansion');
  } else if (config.anthropic_api_key) {
    config.chat_model ??= recipeDefault('anthropic', 'chat');
    config.expansion_model ??= recipeDefault('anthropic', 'expansion');
  } else if (config.google_api_key) {
    config.chat_model ??= recipeDefault('google', 'chat');
    config.expansion_model ??= recipeDefault('google', 'expansion');
  } else if (config.groq_api_key) {
    config.chat_model ??= recipeDefault('groq', 'chat');
    config.expansion_model ??= recipeDefault('groq', 'chat');
  } else if (config.together_api_key) {
    config.chat_model ??= recipeDefault('together', 'chat');
    config.expansion_model ??= recipeDefault('together', 'chat');
  } else if (config.openrouter_api_key) {
    config.chat_model ??= recipeDefault('openrouter', 'chat');
    config.expansion_model ??= recipeDefault('openrouter', 'chat');
  }
  if (config.embedding_model?.trim()) delete config.embedding_disabled;
  else config.embedding_disabled = true;
}

export function saveSetup(payload: SetupPayload): {
  config: RawConfig;
  snapshot: ConfigSnapshot;
  backup: string | null;
  needsEmbeddingDimensionProbe: boolean;
  embeddingModelActivated: boolean;
  embeddingModelChanged: boolean;
  previousEmbeddingModel?: string;
} {
  const readPath = desktopConfigPath();
  const path = desktopWriteConfigPath();
  const snapshot: ConfigSnapshot = {
    path,
    existed: existsSync(path),
    content: existsSync(path) ? readFileSync(path, 'utf8') : undefined,
  };
  const existing = readConfig(readPath) ?? {};
  if (payload.expectedModelRevision !== undefined) assertModelRevision(existing, payload.expectedModelRevision);
  const config: RawConfig = { ...existing, engine: payload.engine };

  if (payload.engine === 'pglite') {
    const preferredDefault = join(preferredConfigDirectory(), 'brain.pglite');
    const requested = payload.databasePath?.trim();
    const databasePath = normalizePgliteDatabasePath(
      requested || (typeof existing.database_path === 'string' ? existing.database_path : preferredDefault),
    );
    if (!isAbsolute(databasePath)) throw new Error('PGLite 数据库路径必须是绝对路径。');
    config.database_path = databasePath;
    delete config.database_url;
  } else {
    const databaseUrl = payload.databaseUrl?.trim() || (existing.database_url as string | undefined);
    if (!databaseUrl || !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
      throw new Error('Docker/Postgres 模式需要有效的 postgresql:// 连接地址。');
    }
    config.database_url = databaseUrl;
    delete config.database_path;
  }

  const keyMap: Record<string, string> = {
    mimo: 'mimo_api_key', zhipu: 'zhipu_api_key', deepseek: 'deepseek_api_key',
    openai: 'openai_api_key', anthropic: 'anthropic_api_key', zeroentropy: 'zeroentropy_api_key',
    google: 'google_api_key', voyage: 'voyage_api_key', groq: 'groq_api_key',
    together: 'together_api_key', openrouter: 'openrouter_api_key',
    minimax: 'minimax_api_key', dashscope: 'dashscope_api_key',
    customOpenai: 'custom_openai_api_key',
  };
  for (const [provider, value] of Object.entries(payload.keys ?? {})) {
    const configKey = keyMap[provider];
    if (configKey && value?.trim()) config[configKey] = value.trim();
  }
  const customChatKey = payload.keys?.customOpenaiChat?.trim();
  const customEmbeddingKey = payload.keys?.customOpenaiEmbedding?.trim();
  if (customChatKey || customEmbeddingKey) {
    const existingProviderKeys = existing.provider_touchpoint_api_keys?.['custom-openai'] ?? {};
    config.provider_touchpoint_api_keys = {
      ...(existing.provider_touchpoint_api_keys ?? {}),
      'custom-openai': {
        ...existingProviderKeys,
        ...(customChatKey ? { chat: customChatKey } : {}),
        ...(customEmbeddingKey ? { embedding: customEmbeddingKey } : {}),
      },
    };
  }
  selectModelDefaults(config);
  const chatModel = payload.modelConfig?.chatModel?.trim();
  if (chatModel) {
    config.chat_model = chatModel;
    config.expansion_model = chatModel;
    config['models.default'] = chatModel;
  }
  const embeddingModel = payload.modelConfig?.embeddingModel?.trim();
  let needsEmbeddingDimensionProbe = false;
  let previousEmbeddingModel: string | undefined;
  let embeddingModelActivated = false;
  let embeddingModelChanged = false;
  if (embeddingModel) {
    const previousModel = typeof existing.embedding_model === 'string' ? existing.embedding_model : undefined;
    previousEmbeddingModel = previousModel;
    embeddingModelActivated = !previousModel;
    embeddingModelChanged = Boolean(previousModel && embeddingModel !== previousModel);
    config.embedding_model = embeddingModel;
    delete config.embedding_disabled;
    // Existing users keep their saved dimension while the model is unchanged.
    // A newly selected model gets the recipe recommendation automatically.
    if (embeddingModel !== previousModel && payload.modelConfig?.embeddingDimensions === undefined) {
      config.embedding_dimensions = desktopRecommendedEmbeddingDimension(embeddingModel);
      needsEmbeddingDimensionProbe = !hasKnownDesktopEmbeddingDimension(embeddingModel);
    }
  }
  const embeddingDimensions = payload.modelConfig?.embeddingDimensions;
  if (typeof embeddingDimensions === 'number' && Number.isInteger(embeddingDimensions) && embeddingDimensions > 0) {
    config.embedding_dimensions = embeddingDimensions;
  }
  if (typeof payload.modelConfig?.ocrEnabled === 'boolean') {
    config.ocr_enabled = payload.modelConfig.ocrEnabled;
    config.embedding_image_ocr = payload.modelConfig.ocrEnabled;
    const ocrModel = payload.modelConfig.ocrModel?.trim();
    if (ocrModel) {
      config.ocr_model = ocrModel;
      config.embedding_image_ocr_model = ocrModel;
    } else {
      delete config.ocr_model;
      delete config.embedding_image_ocr_model;
    }
  }

  // Dimensions are required only after the user explicitly selects an
  // embedding model. Ordinary chat credentials never activate embedding.
  if (config.embedding_model && (
      typeof config.embedding_dimensions !== 'number'
      || !Number.isInteger(config.embedding_dimensions)
      || config.embedding_dimensions <= 0)) {
    throw new Error('请填写有效的向量化维度。');
  }

  config.admin_bootstrap_token = typeof existing.admin_bootstrap_token === 'string'
    && /^[A-Za-z0-9_-]{32,}$/.test(existing.admin_bootstrap_token)
    ? existing.admin_bootstrap_token
    : randomBytes(36).toString('base64url');
  const knowledgeDirectory = payload.knowledgeDirectory?.trim() || existing.desktop?.knowledge_directory;
  const requestedSourceId = payload.knowledgeSourceId?.trim();
  const sourceId = requestedSourceId || (knowledgeDirectory
    ? `desktop-${createHash('sha1').update(knowledgeDirectory.toLowerCase()).digest('hex').slice(0, 8)}`
    : existing.desktop?.knowledge_source_id);
  config.desktop = {
    ...existing.desktop,
    setup_completed: true,
    theme: normalizeDesktopTheme(payload.theme ?? existing.desktop?.theme),
    ...(knowledgeDirectory ? { knowledge_directory: knowledgeDirectory, knowledge_source_id: sourceId } : {}),
  };
  const incomingCatalog = payload.customProviders
    ? normalizeCustomProviderCatalog(payload.customProviders)
    : payload.customProvider
      ? catalogFromLegacyProvider(normalizeCustomProvider(payload.customProvider),
        modelNameAfterPrefix(payload.modelConfig?.chatModel, 'custom-openai:'),
        modelNameAfterPrefix(payload.modelConfig?.embeddingModel, 'custom-openai:'))
      : undefined;
  if (incomingCatalog) {
    const selection = payload.customSelection ?? {};
    const chatEndpoint = selectedCustomEndpoint(incomingCatalog, selection, 'chat');
    const embeddingEndpoint = selectedCustomEndpoint(incomingCatalog, selection, 'embedding');
    const existingTouchpoints = existing.provider_touchpoint_base_urls?.['custom-openai'] ?? {};
    const customTouchpoints = {
      ...existingTouchpoints,
      ...(chatEndpoint ? { chat: chatEndpoint.baseUrl } : payload.customProvider?.baseUrls?.chat
        ? { chat: payload.customProvider.baseUrls.chat } : {}),
      ...(embeddingEndpoint ? { embedding: embeddingEndpoint.baseUrl } : payload.customProvider?.baseUrls?.embedding
        ? { embedding: payload.customProvider.baseUrls.embedding } : {}),
    };
    if (payload.customProvider && !payload.customProviders) {
      const legacy = normalizeCustomProvider(payload.customProvider);
      if (legacy.baseUrls?.chat) customTouchpoints.chat = legacy.baseUrls.chat;
      if (legacy.baseUrls?.embedding) customTouchpoints.embedding = legacy.baseUrls.embedding;
    }
    const fallbackBaseUrl = customTouchpoints.chat
      ?? customTouchpoints.embedding
      ?? existing.provider_base_urls?.['custom-openai'];
    config.provider_base_urls = {
      ...(existing.provider_base_urls ?? {}),
      ...(fallbackBaseUrl ? { 'custom-openai': fallbackBaseUrl } : {}),
    };
    config.provider_touchpoint_base_urls = {
      ...(existing.provider_touchpoint_base_urls ?? {}),
      'custom-openai': customTouchpoints,
    };
    const existingProviderKeys = config.provider_touchpoint_api_keys?.['custom-openai']
      ?? existing.provider_touchpoint_api_keys?.['custom-openai']
      ?? {};
    const nextProviderKeys = { ...existingProviderKeys };
    if (chatEndpoint?.apiKey) nextProviderKeys.chat = chatEndpoint.apiKey;
    if (embeddingEndpoint?.apiKey) nextProviderKeys.embedding = embeddingEndpoint.apiKey;
    config.provider_touchpoint_api_keys = {
      ...(config.provider_touchpoint_api_keys ?? existing.provider_touchpoint_api_keys ?? {}),
      'custom-openai': nextProviderKeys,
    };
    config.desktop.custom_endpoints = incomingCatalog;
    config.desktop.custom_endpoint_selection = {
      ...(chatEndpoint ? { chat: chatEndpoint.id } : {}),
      ...(embeddingEndpoint ? { embedding: embeddingEndpoint.id } : {}),
    };
    config.desktop.custom_openai_display_name = chatEndpoint?.displayName
      || embeddingEndpoint?.displayName
      || payload.customProvider?.displayName
      || existing.desktop?.custom_openai_display_name;
  }

  const backup = backupFile(path, 'config');
  writeJsonConfig(path, config);
  return {
    config,
    snapshot,
    backup,
    needsEmbeddingDimensionProbe,
    embeddingModelActivated,
    embeddingModelChanged,
    previousEmbeddingModel,
  };
}

export function saveDesktopTheme(theme: DesktopTheme): string | null {
  const path = desktopConfigPath();
  const config = readConfig(path);
  if (!config) return null;
  const normalized = normalizeDesktopTheme(theme);
  if (normalizeDesktopTheme(config.desktop?.theme) === normalized) return null;
  const backup = backupFile(path, 'config');
  config.desktop = { ...config.desktop, theme: normalized };
  writeJsonConfig(path, config);
  return backup;
}

export function saveDesktopPreferences(patch: Partial<DesktopPreferences>): {
  preferences: DesktopPreferences;
  backup: string | null;
} {
  const path = desktopConfigPath();
  const config = readConfig(path);
  if (!config) throw new Error('请先完成基础配置，再保存系统设置。');
  const current = preferencesFromConfig(config);
  const preferences: DesktopPreferences = {
    networkMode: patch.networkMode === undefined
      ? current.networkMode
      : normalizeDesktopNetworkMode(patch.networkMode),
    closeBehavior: patch.closeBehavior === undefined
      ? current.closeBehavior
      : normalizeDesktopCloseBehavior(patch.closeBehavior),
    startMinimized: patch.startMinimized === undefined ? current.startMinimized : patch.startMinimized === true,
    sharedAdapter: patch.sharedAdapter === undefined ? current.sharedAdapter : patch.sharedAdapter.trim() || undefined,
    sharedIp: patch.sharedIp === undefined ? current.sharedIp : patch.sharedIp.trim() || undefined,
    sharedResumeRequired: patch.sharedResumeRequired === undefined
      ? current.sharedResumeRequired
      : patch.sharedResumeRequired === true,
    dockerContainerName: patch.dockerContainerName === undefined
      ? current.dockerContainerName
      : patch.dockerContainerName.trim() || undefined,
  };
  if (preferences.sharedIp && isIP(preferences.sharedIp) !== 4) {
    throw new Error('共享模式只能选择有效的 IPv4 地址。');
  }
  if (preferences.networkMode === 'shared' && (!preferences.sharedAdapter || !preferences.sharedIp)) {
    throw new Error('共享模式需要同时选择局域网网卡和固定 IPv4 地址。');
  }
  if (preferences.dockerContainerName && /[\r\n]/.test(preferences.dockerContainerName)) {
    throw new Error('Docker 容器名称无效。');
  }

  const desktop = { ...config.desktop };
  desktop.network_mode = preferences.networkMode;
  desktop.close_behavior = preferences.closeBehavior;
  if (preferences.startMinimized) desktop.start_minimized = true;
  else delete desktop.start_minimized;
  if (preferences.sharedAdapter) desktop.shared_adapter = preferences.sharedAdapter;
  else delete desktop.shared_adapter;
  if (preferences.sharedIp) desktop.shared_ip = preferences.sharedIp;
  else delete desktop.shared_ip;
  if (preferences.sharedResumeRequired) desktop.shared_resume_required = true;
  else delete desktop.shared_resume_required;
  if (preferences.dockerContainerName) desktop.docker_container_name = preferences.dockerContainerName;
  else delete desktop.docker_container_name;
  const changed = JSON.stringify(config.desktop ?? {}) !== JSON.stringify(desktop);
  if (!changed) return { preferences, backup: null };
  const backup = backupFile(path, 'config');
  config.desktop = desktop;
  writeJsonConfig(path, config);
  return { preferences, backup };
}

export function saveDesktopCloseBehavior(closeBehavior: DesktopCloseBehavior, filePath = desktopConfigPath(), backupRoot = activeConfigDirectory()): void {
  const config = readConfig(filePath);
  if (!config) throw new Error('请先完成基础配置，再保存系统设置。');
  const normalized = normalizeDesktopCloseBehavior(closeBehavior);
  if (normalizeDesktopCloseBehavior(config.desktop?.close_behavior) === normalized) return;
  backupFile(filePath, 'config', backupRoot);
  config.desktop = { ...(config.desktop ?? {}), close_behavior: normalized };
  writeJsonConfig(filePath, config);
}

export function saveDetectedDockerContainerName(containerName: string): string | null {
  const normalized = containerName.trim();
  if (!normalized) return null;
  return saveDesktopPreferences({ dockerContainerName: normalized }).backup;
}

export function updateSavedEmbeddingDimension(path: string, dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error('探测到的向量维度无效。');
  const config = readConfig(path);
  if (!config) throw new Error('PMBrain 配置不存在，无法保存探测到的向量维度。');
  config.embedding_dimensions = dimensions;
  writeJsonConfig(path, config);
}

export function ensureBootstrapToken(): string {
  const path = desktopConfigPath();
  const config = readConfig(path);
  if (!config) throw new Error('PMBrain 配置不存在。');
  if (typeof config.admin_bootstrap_token === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(config.admin_bootstrap_token)) {
    return config.admin_bootstrap_token;
  }
  config.admin_bootstrap_token = randomBytes(36).toString('base64url');
  backupFile(path, 'config');
  writeJsonConfig(path, config);
  return config.admin_bootstrap_token;
}
