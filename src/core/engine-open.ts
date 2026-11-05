/**
 * Experimental: open an engine from a settings value (`gbrain/engine-open`). Off by default; see
 * docs/ENGINES.md "Opening an engine from settings".
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';
import { opError } from './ops/contract.ts';
import { constructEngine } from './engine-construct.ts';
import { makeEngineChatUsageSink, registerEngineChatUsageSink } from './ai/chat-usage.ts';
import { connectionUrlProblem, markEmbeddedEngine, releaseEmbeddedEngine, type EngineAISettings, type EngineSettings, type EngineStorageSettings } from './embedded-engine.ts';
import { assertLocalWriterValue, setEngineHostId } from './persistence/identity.ts';
import { engineProviderProblem, recipeKeyEnv, releaseEngineGatewayState, sharedProviderEnvConflict } from './ai/engine-gateway.ts';
import { getRecipe } from './ai/recipes/index.ts';

export type { EngineAISettings, EngineSettings, EngineStorageSettings, EmbeddedSettingsView } from './embedded-engine.ts';
export { embeddedSettings, isEmbeddedEngine, processHasEmbeddedEngines } from './embedded-engine.ts';
export { withEngineScope, withLocalScope } from './engine-scope.ts';
export { hostIdFor } from './persistence/identity.ts';

/** Connections a Postgres engine opened from settings may open when `pool.max` is not given. */
export const DEFAULT_EMBEDDED_POOL_MAX = 4;

const closedError = () => opError('engine_closed', 'This engine was disconnected and cannot connect again.',
  'disconnect() on an engine opened from settings closes it for good and drops the settings it held, so nothing was reopened. Call openEngine again with the settings.');
const invalid = (setting: string, why: string) => opError('engine_settings_invalid', `The ${setting} setting is invalid.`, `${why} Nothing was opened.`);
const text = (value: unknown) => typeof value === 'string' && value.length > 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AI_MODELS = ['chat', 'expansion', 'reranker'];

const STORAGE_NEEDS: Record<string, readonly (keyof EngineStorageSettings)[]> = {
  local: ['localPath'], s3: ['bucket', 'endpoint', 'accessKeyId', 'secretAccessKey'],
};
const STORAGE_FIELDS = new Set(['backend', 'bucket', 'localPath', 'region', 'endpoint', 'accessKeyId', 'secretAccessKey', 'prefix']);
const PREFIX = /^[a-z0-9][a-z0-9_-]*$/i;

/** Every value the backend needs is given, so no backend falls back to a default path or reads an endpoint or credentials from the environment. */
function checkStorage(storage: EngineStorageSettings): void {
  const needs = storage && typeof storage === 'object' ? STORAGE_NEEDS[storage.backend] : undefined;
  if (!needs) throw invalid('storage.backend', "storage is { backend: 'local' | 's3', ... }.");
  const extra = Object.keys(storage).find(field => !STORAGE_FIELDS.has(field));
  if (extra) throw invalid(`storage.${extra}`, `storage takes ${[...STORAGE_FIELDS].join(', ')}.`);
  const missing = needs.find(field => !text(storage[field]));
  if (missing) throw invalid(`storage.${missing}`, `A ${storage.backend} store needs ${needs.join(', ')}.`);
  if (storage.prefix !== undefined && !PREFIX.test(storage.prefix)) throw invalid('storage.prefix', 'prefix is one segment of letters, digits, - and _.');
}

/** Names the setting that is wrong, never a key: a key's value is never part of a refusal. */
function checkAI(ai: EngineAISettings): void {
  if (!ai || typeof ai !== 'object' || !ai.providers || typeof ai.providers !== 'object') {
    throw invalid('ai', 'ai is { providers: { <provider id>: { apiKey?, baseUrl? } }, models?: { chat?, expansion?, reranker? } }.');
  }
  for (const [id, provider] of Object.entries(ai.providers)) {
    const problem = engineProviderProblem(id);
    if (problem) throw invalid(`ai.providers.${id}`, problem);
    const fields = provider && typeof provider === 'object' ? Object.keys(provider) : null;
    const extra = fields?.find(field => field !== 'apiKey' && field !== 'baseUrl');
    if (!fields || extra) throw invalid(`ai.providers.${id}${extra ? `.${extra}` : ''}`, 'Each provider is { apiKey?, baseUrl? }.');
    if (provider.apiKey !== undefined && !text(provider.apiKey)) throw invalid(`ai.providers.${id}.apiKey`, 'apiKey is a non-empty string when given.');
    if (provider.apiKey !== undefined && !recipeKeyEnv(getRecipe(id)!)) throw invalid(`ai.providers.${id}.apiKey`, `${id} takes no API key.`);
    if (provider.apiKey === undefined && provider.baseUrl === undefined && getRecipe(id)!.auth_env?.required.length) {
      throw invalid(`ai.providers.${id}.apiKey`, `${id} needs an apiKey, or a baseUrl for a server that takes none.`);
    }
    if (provider.baseUrl !== undefined && !(text(provider.baseUrl) && /^https?:\/\/[^\s/]+/i.test(provider.baseUrl))) {
      throw invalid(`ai.providers.${id}.baseUrl`, 'baseUrl is an http or https URL when given.');
    }
  }
  const conflict = sharedProviderEnvConflict(ai.providers);
  if (conflict) throw invalid('ai.providers', conflict);
  for (const [name, model] of Object.entries(ai.models ?? {})) {
    if (!AI_MODELS.includes(name)) throw invalid(`ai.models.${name}`, 'ai.models takes chat, expansion and reranker; the embedding model is settings.embedding.');
    if (!text(model) || !model.includes(':')) throw invalid(`ai.models.${name}`, 'Each model is a provider:model string.');
  }
}

/** Each setting openEngine reads, with the fields it reads inside it (null: a value, or fields another check reads: ai.providers, storage). */
const SETTINGS_FIELDS: Record<string, readonly string[] | null> = {
  embedded_core: null, engine: null, database: ['url', 'directUrl', 'path'], pool: ['max'], host: ['id'], writer: ['id', 'credential', 'lane'],
  embedding: ['model', 'dimensions'], keyword_statement_timeout_ms: null, pglite: ['shared_buffers'], ai: ['providers', 'models'], storage: null, cache_namespace: null,
};

/** A misspelled or foreign key would be silently ignored, so it refuses, naming the key and never its value. */
function checkKnownKeys(settings: EngineSettings): void {
  for (const [name, value] of Object.entries(settings)) {
    if (!Object.hasOwn(SETTINGS_FIELDS, name)) throw invalid(name, `openEngine reads ${Object.keys(SETTINGS_FIELDS).join(', ')}, so a misspelled or foreign setting would be ignored.`);
    const fields = SETTINGS_FIELDS[name];
    const extra = fields && value && typeof value === 'object' ? Object.keys(value).find(field => !fields.includes(field)) : undefined;
    if (extra) throw invalid(`${name}.${extra}`, `${name} takes ${fields!.join(', ')}.`);
  }
}

function checkSettings(settings: EngineSettings): void {
  checkKnownKeys(settings);
  if (settings.engine !== 'postgres' && settings.engine !== 'pglite') throw invalid('engine', "engine is 'postgres' or 'pglite'.");
  const database = settings.database;
  if (!database || typeof database !== 'object') throw invalid('database', 'database is an object: { url, directUrl? } for Postgres, { path? } for PGLite.');
  if (settings.engine === 'postgres') {
    if (!text(database.url)) throw invalid('database.url', 'A Postgres engine needs database.url.');
    if (database.path !== undefined) throw invalid('database.path', 'A Postgres engine takes database.url, not database.path.');
    if (database.directUrl !== undefined && !text(database.directUrl)) throw invalid('database.directUrl', 'database.directUrl is a connection URL when given.');
    for (const [setting, url] of [['database.url', database.url], ['database.directUrl', database.directUrl]] as const) {
      const problem = url === undefined ? undefined : connectionUrlProblem(url);
      if (problem) throw invalid(setting, `${setting} ${problem}.`);
    }
  } else {
    if (database.url !== undefined || database.directUrl !== undefined) throw invalid('database.url', 'A PGLite engine takes database.path (or none for an in-memory brain), not a URL.');
    if (database.path !== undefined && !text(database.path)) throw invalid('database.path', 'database.path is a data directory when given.');
  }
  const max = settings.pool?.max;
  if (max !== undefined && !(Number.isInteger(max) && max > 0 && max <= 100)) throw invalid('pool.max', 'pool.max is a whole number from 1 to 100.');
  if (!settings.host || settings.host.id === undefined || settings.host.id === '') {
    throw opError('engine_host_missing', 'openEngine was called with no host identity.',
      'An engine opened from settings claims and publishes work only under the host id its host gives, and it never reads or mints host.json under the home directory, so nothing was opened. Pass host.id as a UUID and keep the same id for the same host across restarts.');
  }
  if (typeof settings.host.id !== 'string' || !UUID.test(settings.host.id)) throw invalid('host.id', 'The persistence tables store host ids as uuid, so host.id must be a UUID.');
  if (settings.writer !== undefined) assertLocalWriterValue(settings.writer);
  const embedding = settings.embedding;
  if (embedding !== undefined && !(text(embedding.model) && Number.isInteger(embedding.dimensions) && embedding.dimensions > 0)) {
    throw invalid('embedding', 'embedding is { model, dimensions } with a model name and a positive whole width.');
  }
  if (settings.ai !== undefined) checkAI(settings.ai);
  const namespace = settings.cache_namespace;
  if (namespace !== undefined && !(text(namespace) && namespace.length <= 256)) throw invalid('cache_namespace', 'cache_namespace is an opaque string of 1 to 256 characters when given.');
  if (settings.storage !== undefined) checkStorage(settings.storage);
}

/**
 * Creates and connects an engine from `settings` alone. It reads no config file, no environment variable, no home
 * directory and no working directory for its database, pool, direct URL, host identity, writer, embedding identity or
 * AI gateway: its embed, chat and rerank calls reach only `settings.ai` (ai/engine-gateway.ts).
 * A Postgres engine always gets its own pool (never the module singleton in db.ts), and its direct pool is only
 * `database.directUrl` (or the one a known pooler URL derives); `GBRAIN_DIRECT_DATABASE_URL` is never consulted.
 *
 * A connect is not a migration: the host runs `initSchema()` (or the migrations) itself. On an existing database
 * `initSchema()` refuses `engine_embedding_mismatch` when `settings.embedding` names another model or width.
 * `disconnect()` closes it for good and drops the settings it held (its provider keys stay only to scrub a call still in
 * flight), even while a reconnect is in flight; a later `connect()` or `reconnect()` refuses `engine_closed`.
 */
export async function openEngine(settings: EngineSettings): Promise<BrainEngine> {
  if (settings?.embedded_core !== true) {
    throw opError('embedded_core_required', 'openEngine requires embedded_core: true.',
      'Opening an engine from settings is an experimental embedding surface and is off by default, so nothing was opened. Pass embedded_core: true in the settings to opt in; the CLI, gbrain serve and mounts open brains through their own connect path.');
  }
  checkSettings(settings);
  const held: EngineSettings = {
    ...settings,
    database: { ...settings.database },
    host: { id: settings.host.id },
    ...(settings.pool ? { pool: { ...settings.pool } } : {}),
    ...(settings.writer ? { writer: { ...settings.writer } } : {}),
    ...(settings.embedding ? { embedding: { ...settings.embedding } } : {}),
    ...(settings.pglite ? { pglite: { ...settings.pglite } } : {}),
    ...(settings.storage ? { storage: { ...settings.storage } } : {}),
    ...(settings.ai ? { ai: {
      providers: Object.fromEntries(Object.entries(settings.ai.providers).map(([id, provider]) => [id, { ...provider }])),
      ...(settings.ai.models ? { models: { ...settings.ai.models } } : {}),
    } } : {}),
  };
  const config: EngineConfig = {
    engine: held.engine,
    ...(held.database.url ? { database_url: held.database.url } : {}),
    ...(held.database.path ? { database_path: held.database.path } : {}),
    ...(held.keyword_statement_timeout_ms !== undefined ? { keyword_statement_timeout_ms: held.keyword_statement_timeout_ms } : {}),
    ...(held.pglite?.shared_buffers ? { pglite_shared_buffers: held.pglite.shared_buffers } : {}),
  };
  const engine = await constructEngine(config);
  markEmbeddedEngine(engine, held);
  setEngineHostId(engine, held.host.id);
  const dropUsageSink = registerEngineChatUsageSink(engine, makeEngineChatUsageSink(engine));
  let closed = false;
  const insideReconnect = new AsyncLocalStorage<true>();
  const disconnect = engine.disconnect.bind(engine);
  engine.disconnect = async (): Promise<void> => {
    if (insideReconnect.getStore()) return disconnect();
    closed = true;
    dropUsageSink();
    releaseEngineGatewayState(engine);
    releaseEmbeddedEngine(engine);
    await disconnect();
  };
  const connect = engine.connect.bind(engine);
  engine.connect = async (...args: Parameters<BrainEngine['connect']>): Promise<void> => {
    if (closed) throw closedError();
    await connect(...args);
  };
  const reconnect = engine.reconnect.bind(engine);
  engine.reconnect = async (ctx?: { error?: unknown }): Promise<void> => {
    if (closed) throw closedError();
    try { await insideReconnect.run(true, () => reconnect(ctx)); }
    finally { if (closed) await disconnect().catch(() => {}); }
  };
  try {
    if (held.engine === 'postgres') await engine.connect({ ...config, poolSize: held.pool?.max ?? DEFAULT_EMBEDDED_POOL_MAX } as EngineConfig & { poolSize: number });
    else await engine.connect(config);
  } catch (error) {
    await engine.disconnect().catch(() => {});
    throw error;
  }
  return engine;
}
