import type { BrainEngine } from './engine.ts';
import { PostgresEngine } from './postgres-engine.ts';
import { SQLiteEngine } from './sqlite-engine.ts';
import { GBrainError, type EngineConfig } from './types.ts';
import type {
  EmbeddingProvider,
  EngineType,
  GBrainConfig,
  GBrainConfigInput,
  QueryRewriteProvider,
} from './config.ts';

export const DEFAULT_RUNTIME_CONFIG: GBrainConfig = {
  engine: 'postgres',
  offline: false,
  embedding_provider: 'none',
  query_rewrite_provider: 'none',
};

const VALID_ENGINES = new Set<EngineType>(['postgres', 'sqlite']);
const VALID_EMBEDDING_PROVIDERS = new Set<EmbeddingProvider>(['none', 'local']);
const VALID_QUERY_REWRITE_PROVIDERS = new Set<QueryRewriteProvider>(['none', 'heuristic', 'local_llm']);

export function resolveConfig(input: GBrainConfigInput): GBrainConfig {
  if (input.engine !== undefined && !VALID_ENGINES.has(input.engine)) {
    throw new GBrainError(
      'Invalid engine selection',
      `Unsupported engine: ${String(input.engine)}`,
      'Use engine="postgres" or engine="sqlite" in ~/.gbrain/config.json',
    );
  }

  const engine: EngineType = input.engine === 'sqlite' ? 'sqlite' : 'postgres';
  const resolved: GBrainConfig = {
    engine,
    database_url: input.database_url,
    database_path: input.database_path,
    offline: input.offline ?? (engine === 'sqlite'),
    embedding_provider: input.embedding_provider ?? (engine === 'sqlite' ? 'local' : 'none'),
    query_rewrite_provider: input.query_rewrite_provider ?? (engine === 'sqlite' ? 'heuristic' : 'none'),
    openai_api_key: input.openai_api_key,
    anthropic_api_key: input.anthropic_api_key,
  };

  validateResolvedConfig(resolved);
  return resolved;
}

export function validateResolvedConfig(config: GBrainConfig): void {
  if (!VALID_EMBEDDING_PROVIDERS.has(config.embedding_provider)) {
    throw new GBrainError(
      'Invalid embedding provider',
      `Unsupported embedding_provider: ${String(config.embedding_provider)}`,
      'Use embedding_provider="none" or embedding_provider="local"',
    );
  }

  if (!VALID_QUERY_REWRITE_PROVIDERS.has(config.query_rewrite_provider)) {
    throw new GBrainError(
      'Invalid query rewrite provider',
      `Unsupported query_rewrite_provider: ${String(config.query_rewrite_provider)}`,
      'Use query_rewrite_provider="none", "heuristic", or "local_llm"',
    );
  }

  if (config.engine === 'postgres') {
    if (!config.database_url) {
      throw new GBrainError(
        'No database URL',
        'database_url is missing from config',
        'Run gbrain init --url <connection_string> or set GBRAIN_DATABASE_URL / DATABASE_URL',
      );
    }
    if (config.database_path) {
      throw new GBrainError(
        'Invalid Postgres config',
        'database_path is only supported when engine="sqlite"',
        'Remove database_path or switch engine to sqlite',
      );
    }
    if (config.offline) {
      throw new GBrainError(
        'Invalid Postgres config',
        'offline=true requires engine="sqlite"',
        'Disable offline mode or switch engine to sqlite',
      );
    }
    if (config.embedding_provider === 'local') {
      throw new GBrainError(
        'Invalid engine/provider combination',
        'embedding_provider="local" requires sqlite engine',
        'Set embedding_provider="none" or switch engine to sqlite',
      );
    }
  }

  if (config.engine === 'sqlite') {
    if (!config.database_path) {
      throw new GBrainError(
        'No database path',
        'database_path is missing from config',
        'Set database_path in ~/.gbrain/config.json before using engine="sqlite"',
      );
    }
    if (config.database_url) {
      throw new GBrainError(
        'Invalid SQLite config',
        'database_url is only supported when engine="postgres"',
        'Remove database_url or switch engine to postgres',
      );
    }
  }
}

export function toEngineConfig(
  config: GBrainConfig,
  options?: { poolSize?: number },
): EngineConfig & { poolSize?: number } {
  return {
    engine: config.engine,
    database_url: config.database_url,
    database_path: config.database_path,
    ...(options?.poolSize ? { poolSize: options.poolSize } : {}),
  };
}

export function createEngineFromConfig(config: GBrainConfig): BrainEngine {
  validateResolvedConfig(config);

  switch (config.engine) {
    case 'postgres':
      return new PostgresEngine();
    case 'sqlite':
      return new SQLiteEngine();
  }
}

export async function createConnectedEngine(
  config: GBrainConfig,
  options?: { poolSize?: number },
): Promise<BrainEngine> {
  const engine = createEngineFromConfig(config);
  await engine.connect(toEngineConfig(config, options));
  return engine;
}

export function supportsParallelWorkers(config: GBrainConfig): boolean {
  return config.engine === 'postgres';
}

export function supportsRawPostgresAccess(config: GBrainConfig): boolean {
  return config.engine === 'postgres';
}
