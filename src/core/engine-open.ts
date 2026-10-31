import type { BrainEngine } from './engine.ts';
import { GBrainError, type EngineConfig } from './types.ts';
import { createEngine } from './engine-factory.ts';
import { setEngineHostId } from './persistence/identity.ts';

/**
 * Everything an engine needs, as a value. Nothing here is read from a file,
 * the environment or the home directory: a host that has those reads them
 * once and builds this object (the CLI does that in `connectEngineForServe`);
 * a host that has several brains in one process builds one per brain.
 */
export interface EngineSettings {
  engine: 'postgres' | 'pglite';
  /** Postgres: the connection URL. PGLite: the data directory, or none for an in-memory engine. */
  database: { url?: string; path?: string };
  /** Postgres only: connections this engine's own pool may open (default 4). The engine never shares the module pool. */
  pool?: { max?: number };
  /**
   * The persistence host identity this engine publishes under (a UUID). Without it the engine uses this
   * process's `host.json` under the home directory, minting one when there is none.
   */
  host?: { id: string };
  /** PGLite `shared_buffers` for this open; unset keeps the data directory's setting. */
  pglite?: { shared_buffers?: string };
  /** `search.keyword_statement_timeout_ms`, read by the Postgres engine at connect. */
  keyword_statement_timeout_ms?: number;
}

/** Connections an engine opened from settings may use when `pool.max` is not given: enough for a search's parallel arms. */
export const DEFAULT_SETTINGS_POOL_MAX = 4;

/**
 * Opens an engine from settings alone: creates it, connects it and records its host identity. The caller
 * runs `initSchema()` or the migrations itself (a connect is not a migration) and `disconnect()`s when done.
 *
 * Two engines opened this way in one process share no pool, no URL and no host identity. A Postgres engine
 * always gets an instance pool (`connect({ poolSize })`), never the process-wide singleton in `db.ts`, so a
 * second URL does not silently reuse the first.
 */
export async function openEngine(settings: EngineSettings): Promise<BrainEngine> {
  const config: EngineConfig = {
    engine: settings.engine,
    ...(settings.database.url ? { database_url: settings.database.url } : {}),
    ...(settings.database.path ? { database_path: settings.database.path } : {}),
    ...(settings.keyword_statement_timeout_ms !== undefined ? { keyword_statement_timeout_ms: settings.keyword_statement_timeout_ms } : {}),
    ...(settings.pglite?.shared_buffers ? { pglite_shared_buffers: settings.pglite.shared_buffers } : {}),
  };
  if (settings.engine === 'postgres' && !config.database_url) {
    throw new GBrainError('No database URL', 'settings.database.url is missing for a Postgres engine', 'Pass database: { url }');
  }
  if (settings.engine === 'pglite' && config.database_url) {
    throw new GBrainError('Wrong database setting', 'a PGLite engine takes database.path, not database.url', 'Pass database: { path } or no path for an in-memory engine');
  }
  const engine = await createEngine(config);
  if (settings.host) setEngineHostId(engine, settings.host.id);
  if (settings.engine === 'postgres') {
    // `poolSize` puts the Postgres engine on its instance-pool path (postgres-engine.ts connect), never the module singleton.
    await engine.connect({ ...config, poolSize: settings.pool?.max ?? DEFAULT_SETTINGS_POOL_MAX } as EngineConfig & { poolSize: number });
  } else {
    await engine.connect(config);
  }
  return engine;
}
