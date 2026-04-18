import type { BrainEngine } from './engine.ts';
import { clearConnectionOwner, registerConnectionOwner } from './db.ts';
import { PostgresEngine } from './postgres-engine.ts';
import { SQLiteEngine } from './sqlite-engine.ts';
import { MBrainError, type EngineConfig } from './types.ts';
import type {
  MBrainConfig,
} from './config.ts';
import { toEngineConfig, validateResolvedConfig } from './config.ts';
import { getEngineCapabilities } from './engine-capabilities.ts';

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
  options?: { poolSize?: number },
): Promise<BrainEngine> {
  validateResolvedConfig(config);
  const engineConfig = toEngineConfig(config, options);
  const engine = config.engine === 'pglite'
    ? await createEngine(engineConfig)
    : createEngineFromConfig(config);
  await engine.connect(engineConfig);
  if (config.engine === 'postgres' && !options?.poolSize && engine instanceof PostgresEngine) {
    registerConnectionOwner(engine);
  } else if (!options?.poolSize) {
    clearConnectionOwner();
  }
  return engine;
}

export function supportsParallelWorkers(config: MBrainConfig): boolean {
  return getEngineCapabilities(config).parallelWorkers;
}

export function supportsRawPostgresAccess(config: MBrainConfig): boolean {
  return getEngineCapabilities(config).rawPostgresAccess;
}
