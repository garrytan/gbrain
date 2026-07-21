import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { getRecipe } from '../../../src/core/ai/recipes/index.js';

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

export interface DesktopCustomProvider {
  id: 'custom-openai';
  displayName: string;
  /** Legacy single-endpoint payload accepted for backward compatibility. */
  baseUrl?: string;
  baseUrls?: Partial<Record<'chat' | 'embedding', string>>;
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
  theme?: DesktopTheme;
  resetAdvancedModelRouting?: boolean;
  databasePath?: string;
  databaseUrl?: string;
  knowledgeDirectory?: string;
  knowledgeSourceId?: string;
  knowledgeSourceChanged?: boolean;
  modelConfig?: {
    chatModel?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
  };
  customProvider?: DesktopCustomProvider;
  keys?: Partial<Record<
    'mimo' | 'zhipu' | 'deepseek' | 'openai' | 'anthropic' | 'zeroentropy' |
    'google' | 'voyage' | 'groq' | 'together' | 'openrouter' | 'minimax' | 'dashscope' |
    'customOpenai' | 'customOpenaiChat' | 'customOpenaiEmbedding',
    string
  >>;
}

export interface SetupInfo {
  needsSetup: boolean;
  configPath: string;
  defaults: { databasePath: string; knowledgeDirectory: string };
  current: {
    engine: 'pglite' | 'postgres';
    databasePath?: string;
    databaseConfigured: boolean;
    knowledgeDirectory?: string;
    knowledgeSourceId?: string;
    chatModel?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    customProvider?: DesktopCustomProvider;
    theme: DesktopTheme;
    keyStatus: Record<string, boolean>;
    keyValues: Record<string, string | undefined>;
    lastMigratedVersion?: string;
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
  provider_base_urls?: Record<string, string>;
  provider_touchpoint_base_urls?: Record<string, Partial<Record<'embedding' | 'expansion' | 'chat' | 'reranker', string>>>;
  provider_touchpoint_api_keys?: Record<string, Partial<Record<'embedding' | 'expansion' | 'chat' | 'reranker', string>>>;
  custom_openai_api_key?: string;
  admin_bootstrap_token?: string;
  desktop?: {
    knowledge_directory?: string;
    knowledge_source_id?: string;
    last_migrated_version?: string;
    theme?: DesktopTheme;
    network_mode?: DesktopNetworkMode;
    close_behavior?: DesktopCloseBehavior;
    shared_adapter?: string;
    shared_ip?: string;
    shared_resume_required?: boolean;
    docker_container_name?: string;
    custom_openai_display_name?: string;
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

function preferredHome(): string {
  const override = process.env.PMBRAIN_HOME?.trim();
  if (override) return join(resolve(override), '.pmbrain');
  return join(homedir(), '.pmbrain');
}

export function preferredConfigDirectory(): string {
  return preferredHome();
}

export function activeConfigDirectory(): string {
  const preferred = preferredHome();
  if (process.env.PMBRAIN_HOME?.trim()) return preferred;
  const legacy = process.env.GBRAIN_HOME?.trim()
    ? join(resolve(process.env.GBRAIN_HOME), '.gbrain')
    : join(homedir(), '.gbrain');
  if (process.env.GBRAIN_HOME?.trim()) return legacy;
  if (existsSync(join(preferred, 'config.json'))) return preferred;
  if (existsSync(join(legacy, 'config.json'))) return legacy;
  return preferred;
}

export function desktopConfigPath(): string {
  return join(activeConfigDirectory(), 'config.json');
}

export function normalizePgliteDatabasePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  return basename(trimmed).toLowerCase().endsWith('.pglite')
    ? trimmed
    : join(trimmed, 'brain.pglite');
}

function desktopWriteConfigPath(): string {
  if (process.env.GBRAIN_HOME?.trim() && !process.env.PMBRAIN_HOME?.trim()) {
    return desktopConfigPath();
  }
  return join(preferredConfigDirectory(), 'config.json');
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
  return {
    needsSetup: !config,
    configPath: path,
    defaults: {
      databasePath: join(pgliteDefaultDir, 'brain.pglite'),
      knowledgeDirectory: join(homedir(), 'Documents', 'PMBrain'),
    },
    current: {
      engine: config?.engine === 'postgres' ? 'postgres' : 'pglite',
      databasePath: config?.database_path,
      databaseConfigured: Boolean(config?.database_url || config?.database_path),
      knowledgeDirectory: desktop?.knowledge_directory,
      knowledgeSourceId: desktop?.knowledge_source_id,
      chatModel: typeof config?.chat_model === 'string' ? config.chat_model : undefined,
      embeddingModel: typeof config?.embedding_model === 'string' ? config.embedding_model : undefined,
      embeddingDimensions: typeof config?.embedding_dimensions === 'number' ? config.embedding_dimensions : undefined,
      customProvider: customChatBaseUrl || customEmbeddingBaseUrl ? {
        id: 'custom-openai',
        displayName: desktop?.custom_openai_display_name?.trim() || '自定义 OpenAI 接口',
        baseUrls: {
          ...(customChatBaseUrl ? { chat: customChatBaseUrl } : {}),
          ...(customEmbeddingBaseUrl ? { embedding: customEmbeddingBaseUrl } : {}),
        },
      } : undefined,
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

function recipeDefault(provider: string, touchpoint: 'chat' | 'expansion' | 'embedding'): string {
  const model = getRecipe(provider)?.touchpoints[touchpoint]?.models[0];
  if (!model) throw new Error(`PMBrain recipe ${provider} 没有可用的 ${touchpoint} 默认模型。`);
  return `${provider}:${model}`;
}

function selectModelDefaults(config: RawConfig): void {
  if (config.mimo_api_key) {
    config.chat_model ??= recipeDefault('mimo', 'chat');
    config.expansion_model ??= recipeDefault('mimo', 'expansion');
    config.embedding_model ??= recipeDefault('mimo', 'embedding');
    config.embedding_dimensions ??= 1536;
    delete config.embedding_disabled;
    return;
  }
  if (config.zhipu_api_key) {
    config.chat_model ??= recipeDefault('zhipu', 'chat');
    config.expansion_model ??= recipeDefault('zhipu', 'expansion');
    config.embedding_model ??= recipeDefault('zhipu', 'embedding');
    config.embedding_dimensions ??= 1024;
    delete config.embedding_disabled;
    return;
  }
  if (config.deepseek_api_key) {
    config.chat_model ??= recipeDefault('deepseek', 'chat');
    config.expansion_model ??= recipeDefault('deepseek', 'expansion');
    config.embedding_model ??= recipeDefault('deepseek', 'embedding');
    config.embedding_dimensions ??= 1536;
    delete config.embedding_disabled;
    return;
  }
  if (config.openai_api_key) {
    config.chat_model ??= recipeDefault('openai', 'chat');
    config.expansion_model ??= recipeDefault('openai', 'expansion');
    config.embedding_model ??= recipeDefault('openai', 'embedding');
    config.embedding_dimensions ??= 1536;
    delete config.embedding_disabled;
    return;
  }
  if (config.anthropic_api_key) {
    config.chat_model ??= recipeDefault('anthropic', 'chat');
    config.expansion_model ??= recipeDefault('anthropic', 'expansion');
    delete config.embedding_disabled;
    return;
  }
  if (config.google_api_key) {
    config.chat_model ??= recipeDefault('google', 'chat');
    config.expansion_model ??= recipeDefault('google', 'expansion');
    config.embedding_model ??= recipeDefault('google', 'embedding');
    config.embedding_dimensions ??= 768;
    delete config.embedding_disabled;
    return;
  }
  if (config.groq_api_key) {
    config.chat_model ??= recipeDefault('groq', 'chat');
    config.expansion_model ??= recipeDefault('groq', 'chat');
    delete config.embedding_disabled;
    return;
  }
  if (config.together_api_key) {
    config.chat_model ??= recipeDefault('together', 'chat');
    config.expansion_model ??= recipeDefault('together', 'chat');
    delete config.embedding_disabled;
    return;
  }
  if (config.openrouter_api_key) {
    config.chat_model ??= recipeDefault('openrouter', 'chat');
    config.expansion_model ??= recipeDefault('openrouter', 'chat');
    delete config.embedding_disabled;
    return;
  }
  if (config.minimax_api_key) {
    config.embedding_model ??= recipeDefault('minimax', 'embedding');
    config.embedding_dimensions ??= 1536;
    delete config.embedding_disabled;
    return;
  }
  if (config.dashscope_api_key) {
    config.embedding_model ??= recipeDefault('dashscope', 'embedding');
    config.embedding_dimensions ??= 1024;
    delete config.embedding_disabled;
    return;
  }
  if (!config.embedding_model) config.embedding_disabled = true;
}

export function saveSetup(payload: SetupPayload): {
  config: RawConfig;
  snapshot: ConfigSnapshot;
  backup: string | null;
  needsEmbeddingDimensionProbe: boolean;
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
  let embeddingModelChanged = false;
  if (embeddingModel) {
    const previousModel = typeof existing.embedding_model === 'string' ? existing.embedding_model : undefined;
    previousEmbeddingModel = previousModel;
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

  // Dimensions are internal desktop configuration. Legacy values remain
  // untouched unless the user actively selects a different model.
  if (typeof config.embedding_dimensions !== 'number'
      || !Number.isInteger(config.embedding_dimensions)
      || config.embedding_dimensions <= 0) {
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
    theme: normalizeDesktopTheme(payload.theme ?? existing.desktop?.theme),
    ...(knowledgeDirectory ? { knowledge_directory: knowledgeDirectory, knowledge_source_id: sourceId } : {}),
  };
  if (payload.customProvider) {
    const customProvider = normalizeCustomProvider(payload.customProvider);
    const existingTouchpoints = existing.provider_touchpoint_base_urls?.['custom-openai'] ?? {};
    const customTouchpoints = { ...existingTouchpoints, ...customProvider.baseUrls };
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
    config.desktop.custom_openai_display_name = customProvider.displayName;
  }

  const backup = backupFile(path, 'config');
  writeJsonConfig(path, config);
  return {
    config,
    snapshot,
    backup,
    needsEmbeddingDimensionProbe,
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
