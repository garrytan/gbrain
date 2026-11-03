/**
 * Experimental: open an engine from a settings value (`gbrain/engine-open`). Off by default; see
 * docs/ENGINES.md "Opening an engine from settings".
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';
import { opError } from './ops/contract.ts';
import { createEngine } from './engine-factory.ts';
import { markEmbeddedEngine, missingConnectionField, releaseEmbeddedEngine, type EngineSettings } from './embedded-engine.ts';
import { assertLocalWriterValue, setEngineHostId } from './persistence/identity.ts';

export type { EngineSettings, EmbeddedSettingsView } from './embedded-engine.ts';
export { embeddedSettings, isEmbeddedEngine, processHasEmbeddedEngines } from './embedded-engine.ts';
export { hostIdFor } from './persistence/identity.ts';

/** Connections a Postgres engine opened from settings may open when `pool.max` is not given. */
export const DEFAULT_EMBEDDED_POOL_MAX = 4;

const closedError = () => opError('engine_closed', 'This engine was disconnected and cannot connect again.',
  'disconnect() on an engine opened from settings closes it for good and drops the settings it held, so nothing was reopened. Call openEngine again with the settings.');
const invalid = (setting: string, why: string) => opError('engine_settings_invalid', `The ${setting} setting is invalid.`, `${why} Nothing was opened.`);
const text = (value: unknown) => typeof value === 'string' && value.length > 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkSettings(settings: EngineSettings): void {
  if (settings.engine !== 'postgres' && settings.engine !== 'pglite') throw invalid('engine', "engine is 'postgres' or 'pglite'.");
  const database = settings.database;
  if (!database || typeof database !== 'object') throw invalid('database', 'database is an object: { url, directUrl? } for Postgres, { path? } for PGLite.');
  if (settings.engine === 'postgres') {
    if (!text(database.url)) throw invalid('database.url', 'A Postgres engine needs database.url.');
    if (database.path !== undefined) throw invalid('database.path', 'A Postgres engine takes database.url, not database.path.');
    if (database.directUrl !== undefined && !text(database.directUrl)) throw invalid('database.directUrl', 'database.directUrl is a connection URL when given.');
    for (const [setting, url] of [['database.url', database.url], ['database.directUrl', database.directUrl]] as const) {
      const missing = url === undefined ? undefined : missingConnectionField(url);
      if (missing) throw invalid(setting, `${setting} names no ${missing}, and the driver would fill it from PG* environment variables.`);
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
}

/**
 * Creates and connects an engine from `settings` alone. It reads no config file, no environment variable, no home
 * directory and no working directory for its database, pool, direct URL, host identity, writer or embedding identity.
 * A Postgres engine always gets its own pool (never the module singleton in db.ts), and its direct pool is only
 * `database.directUrl` (or the one a known pooler URL derives); `GBRAIN_DIRECT_DATABASE_URL` is never consulted.
 *
 * A connect is not a migration: the host runs `initSchema()` (or the migrations) itself. On an existing database
 * `initSchema()` refuses `engine_embedding_mismatch` when `settings.embedding` names another model or width.
 * `disconnect()` closes it for good and drops the settings it held, even while a reconnect is in flight; a later
 * `connect()` or `reconnect()` refuses `engine_closed`.
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
  };
  const config: EngineConfig = {
    engine: held.engine,
    ...(held.database.url ? { database_url: held.database.url } : {}),
    ...(held.database.path ? { database_path: held.database.path } : {}),
    ...(held.keyword_statement_timeout_ms !== undefined ? { keyword_statement_timeout_ms: held.keyword_statement_timeout_ms } : {}),
    ...(held.pglite?.shared_buffers ? { pglite_shared_buffers: held.pglite.shared_buffers } : {}),
  };
  const engine = await createEngine(config);
  markEmbeddedEngine(engine, held);
  setEngineHostId(engine, held.host.id);
  let closed = false;
  const insideReconnect = new AsyncLocalStorage<true>();
  const disconnect = engine.disconnect.bind(engine);
  engine.disconnect = async (): Promise<void> => {
    if (insideReconnect.getStore()) return disconnect();
    closed = true;
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
