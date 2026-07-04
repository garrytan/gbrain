import type { BrainEngine } from './engine.ts';
import { closeConnectionOwners, registerConnectionOwner } from './db.ts';
import { PostgresEngine } from './postgres-engine.ts';
import { SQLiteEngine } from './sqlite-engine.ts';
import { MBrainError, type EngineConfig } from './types.ts';
import type {
  MBrainConfig,
} from './config.ts';
import { toEngineConfig, validateResolvedConfig } from './config.ts';
import { getEngineCapabilities } from './engine-capabilities.ts';
import { resolvePostgresRuntimeProfile } from './postgres-runtime/connection-profile.ts';

export { resolveConfig, toEngineConfig } from './config.ts';

export const DEFAULT_RUNTIME_CONFIG: MBrainConfig = {
  engine: 'postgres',
  offline: false,
  embedding_provider: 'none',
  query_rewrite_provider: 'none',
};

export function createEngineFromConfig(config: MBrainConfig): BrainEngine {
  validateResolvedConfig(config);

  switch (config.engine) {
    case 'postgres':
      return new PostgresEngine();
    case 'sqlite':
      return new SQLiteEngine();
    case 'pglite':
      throw new MBrainError(
        'Async engine required',
        'pglite engine must be created asynchronously',
        'Use createEngine() or createConnectedEngine() for pglite configurations',
      );
  }
}

/**
 * Create an engine instance based on config.
 * Uses a dynamic import so PGLite WASM is never loaded for Postgres/SQLite users.
 */
export async function createEngine(config: EngineConfig): Promise<BrainEngine> {
  const engineType = config.engine || 'postgres';

  switch (engineType) {
    case 'postgres':
      return new PostgresEngine();
    case 'sqlite':
      return new SQLiteEngine();
    case 'pglite': {
      const { PGLiteEngine } = await import('./pglite-engine.ts');
      return new PGLiteEngine();
    }
    default:
      throw new Error(
        `Unknown engine type: "${engineType}". Supported engines: postgres, sqlite, pglite.`,
      );
  }
}

export async function createConnectedEngine(
  config: MBrainConfig,
  options?: { poolSize?: number; schemaLogger?: (message: string) => void },
): Promise<BrainEngine> {
  validateResolvedConfig(config);
  const runtimePoolSize = config.engine === 'postgres'
    ? resolvePostgresRuntimeProfile(config).pool.max
    : undefined;
  const engineConfig = toEngineConfig(config, {
    ...options,
    poolSize: options?.poolSize ?? runtimePoolSize,
  });

  if (config.engine !== 'postgres' && !options?.poolSize) {
    await closeConnectionOwners();
  }

  const engine = config.engine === 'pglite'
    ? await createEngine(engineConfig)
    : createEngineFromConfig(config);
  await engine.connect(engineConfig);
  if (config.engine === 'postgres' && !options?.poolSize && engine instanceof PostgresEngine) {
    registerConnectionOwner(engine);
  }
  return engine;
}

export async function createMigratedLocalEngine(
  config: MBrainConfig,
  options?: { poolSize?: number; schemaLogger?: (message: string) => void },
): Promise<BrainEngine> {
  const shouldAutoMigrate = shouldAutoMigrateOnConnect(config);
  const engine = await createConnectedEngine(config, {
    ...options,
    schemaLogger: shouldAutoMigrate
      ? (options?.schemaLogger ?? ((message: string) => console.error(message)))
      : options?.schemaLogger,
  });
  if (!shouldAutoMigrate) return engine;

  try {
    await engine.initSchema();
  } catch (error) {
    await engine.disconnect().catch(() => undefined);
    throw error;
  }
  return engine;
}

export function shouldAutoMigrateOnConnect(config: MBrainConfig): boolean {
  if (config.engine === 'sqlite' || config.engine === 'pglite') return true;
  if (config.engine !== 'postgres') return false;
  if (process.env.MBRAIN_AUTO_MIGRATE_ON_CONNECT === '1') return true;
  return isLoopbackPostgresUrl(config.database_url);
}

function isLoopbackPostgresUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '::1'
      || hostname === '[::1]';
  } catch {
    return rawUrl.includes('host=/') || rawUrl.includes('host=%2F');
  }
}

export function supportsParallelWorkers(config: MBrainConfig): boolean {
  return getEngineCapabilities(config).parallelWorkers;
}

export function supportsRawPostgresAccess(config: MBrainConfig): boolean {
  return getEngineCapabilities(config).rawPostgresAccess;
}
