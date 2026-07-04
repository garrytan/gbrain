import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { StorageConfig } from './storage.ts';
import { MBrainError, type EngineConfig } from './types.ts';
import {
  DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  defaultEmbeddingDimensionsForModel,
} from './embedding/provider.ts';

export type EngineType = 'postgres' | 'sqlite' | 'pglite';
export type EmbeddingProvider = 'none' | 'local';
export type QueryRewriteProvider = 'none' | 'heuristic' | 'local_llm';

export interface RetrievalSourceRankRuleConfig {
  prefix: string;
  factor: number;
}

export interface MBrainConfig {
  engine: EngineType;
  database_url?: string;
  database_url_explicit?: boolean;
  database_path?: string;
  offline: boolean;
  embedding_provider: EmbeddingProvider;
  embedding_model?: string;
  query_rewrite_provider: QueryRewriteProvider;
  openai_api_key?: string;
  anthropic_api_key?: string;
  storage?: StorageConfig;
  autopilot?: Record<string, unknown>;
  maintenance?: {
    governed_recompile_enabled?: boolean;
  };
  auto_promote?: Record<string, unknown>;
  retrieval_governed_probe_hybrid?: boolean;
  retrieval_contextual_chunk_embeddings?: boolean;
  retrieval_usage_aware_ranking?: boolean;
  retrieval_eval_answer_grounding?: boolean;
  maintenance_governed_recompile_enabled?: boolean;
  retrieval_source_rank_rules?: RetrievalSourceRankRuleConfig[];
}

export interface MBrainConfigInput {
  engine?: EngineType;
  database_url?: string;
  database_url_explicit?: boolean;
  database_path?: string;
  offline?: boolean;
  embedding_provider?: EmbeddingProvider;
  embedding_model?: string;
  query_rewrite_provider?: QueryRewriteProvider;
  openai_api_key?: string;
  anthropic_api_key?: string;
  storage?: StorageConfig;
  autopilot?: Record<string, unknown>;
  maintenance?: {
    governed_recompile_enabled?: boolean;
  };
  auto_promote?: Record<string, unknown>;
  retrieval?: {
    governed_probe_hybrid?: boolean;
    contextual_chunk_embeddings?: boolean;
    usage_aware_ranking?: boolean;
    source_rank_rules?: RetrievalSourceRankRuleConfig[];
  };
  retrieval_eval?: {
    answer_grounding?: boolean;
  };
  retrieval_governed_probe_hybrid?: boolean;
  retrieval_contextual_chunk_embeddings?: boolean;
  retrieval_usage_aware_ranking?: boolean;
  retrieval_eval_answer_grounding?: boolean;
  maintenance_governed_recompile_enabled?: boolean;
  retrieval_source_rank_rules?: RetrievalSourceRankRuleConfig[];
}

const VALID_ENGINES = new Set<EngineType>(['postgres', 'sqlite', 'pglite']);
const VALID_EMBEDDING_PROVIDERS = new Set<EmbeddingProvider>(['none', 'local']);
const VALID_QUERY_REWRITE_PROVIDERS = new Set<QueryRewriteProvider>(['none', 'heuristic', 'local_llm']);

// Lazy-evaluated to avoid calling homedir() at module scope (breaks in Deno Edge Functions)
function getConfigPath() { return process.env.MBRAIN_CONFIG_PATH || join(getConfigDir(), 'config.json'); }
function getConfigDir() {
  return process.env.MBRAIN_CONFIG_DIR
    || (process.env.MBRAIN_CONFIG_PATH ? dirname(process.env.MBRAIN_CONFIG_PATH) : join(process.env.HOME || homedir(), '.mbrain'));
}

/**
 * Load config with credential precedence: env vars > config file, unless a local engine is explicitly configured.
 * Plugin config is handled by the plugin runtime injecting env vars.
 */
export function loadConfig(): MBrainConfig | null {
  let fileConfig: MBrainConfigInput | null = null;
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8');
    fileConfig = JSON.parse(raw) as MBrainConfigInput;
  } catch {
    /* no config file */
  }

  const dbUrl = process.env.MBRAIN_DATABASE_URL || process.env.DATABASE_URL;
  if (!fileConfig && !dbUrl) return null;

  const preferLocalConfig = fileConfig?.engine === 'sqlite' || fileConfig?.engine === 'pglite';
  const inferredEngine = fileConfig?.engine ?? (fileConfig?.database_path ? 'pglite' : undefined);

  const merged: MBrainConfigInput = {
    ...fileConfig,
    ...(inferredEngine ? { engine: inferredEngine } : {}),
    ...(!preferLocalConfig && dbUrl ? { database_url: dbUrl, database_url_explicit: true } : {}),
    ...(!preferLocalConfig && !dbUrl && fileConfig?.database_url ? { database_url_explicit: true } : {}),
    ...(process.env.OPENAI_API_KEY ? { openai_api_key: process.env.OPENAI_API_KEY } : {}),
  };

  return resolveConfig(merged);
}

export function saveConfig(config: MBrainConfigInput): void {
  mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(getConfigPath(), 0o600);
  } catch {
    // chmod may fail on some platforms
  }
}

export function resolveConfig(input: MBrainConfigInput): MBrainConfig {
  if (input.engine !== undefined && !VALID_ENGINES.has(input.engine)) {
    throw new MBrainError(
      'Invalid engine selection',
      `Unsupported engine: ${String(input.engine)}`,
      'Use engine="postgres", engine="sqlite", or engine="pglite" in ~/.mbrain/config.json',
    );
  }

  const engine: EngineType = input.engine ?? (input.database_path ? 'pglite' : 'postgres');
  const isSQLite = engine === 'sqlite';
  const resolved: MBrainConfig = {
    engine,
    database_url: input.database_url,
    database_url_explicit: input.database_url_explicit ?? Boolean(input.database_url),
    database_path: input.database_path,
    offline: input.offline ?? isSQLite,
    embedding_provider: input.embedding_provider ?? (isSQLite ? 'local' : 'none'),
    embedding_model: input.embedding_model,
    query_rewrite_provider: input.query_rewrite_provider ?? (isSQLite ? 'heuristic' : 'none'),
    storage: input.storage,
    openai_api_key: input.openai_api_key,
    anthropic_api_key: input.anthropic_api_key,
    autopilot: input.autopilot,
    auto_promote: input.auto_promote,
    // When enabled, the governed retrieval probe (retrieve_context / read_context
    // auto-reads / broad-synthesis) runs the full hybrid candidate search by parity
    // with the lower-authority `query` op. Default off: the keyword-only probe is the
    // documented baseline, so offline / no-provider installs stay byte-for-byte
    // unchanged (Invariant 8). Wave-2 live retrieval eval is now the regression
    // gate, so the governed probe defaults to parity with `query`; callers can
    // still opt out with retrieval.governed_probe_hybrid=false.
    retrieval_governed_probe_hybrid: input.retrieval_governed_probe_hybrid
      ?? input.retrieval?.governed_probe_hybrid
      ?? true,
    retrieval_contextual_chunk_embeddings: input.retrieval_contextual_chunk_embeddings
      ?? input.retrieval?.contextual_chunk_embeddings
      ?? false,
    retrieval_usage_aware_ranking: input.retrieval_usage_aware_ranking
      ?? input.retrieval?.usage_aware_ranking
      ?? false,
    retrieval_eval_answer_grounding: input.retrieval_eval_answer_grounding
      ?? input.retrieval_eval?.answer_grounding
      ?? false,
    maintenance_governed_recompile_enabled: input.maintenance_governed_recompile_enabled
      ?? input.maintenance?.governed_recompile_enabled
      ?? false,
    retrieval_source_rank_rules: normalizeRetrievalSourceRankRules(
      input.retrieval_source_rank_rules ?? input.retrieval?.source_rank_rules,
    ),
  };

  validateResolvedConfig(resolved);
  return resolved;
}

function normalizeRetrievalSourceRankRules(
  rules: RetrievalSourceRankRuleConfig[] | undefined,
): RetrievalSourceRankRuleConfig[] | undefined {
  if (rules === undefined) return undefined;
  if (!Array.isArray(rules)) {
    throw new MBrainError(
      'Invalid retrieval source rank rules',
      'retrieval.source_rank_rules must be an array',
      'Use entries like {"prefix":"office/personal/","factor":1.2}',
    );
  }
  return rules.map((rule, index) => {
    if (!rule || typeof rule.prefix !== 'string' || rule.prefix.trim().length === 0) {
      throw new MBrainError(
        'Invalid retrieval source rank rule',
        `retrieval.source_rank_rules[${index}].prefix must be a non-empty string`,
        'Use entries like {"prefix":"office/personal/","factor":1.2}',
      );
    }
    if (typeof rule.factor !== 'number' || !Number.isFinite(rule.factor) || rule.factor <= 0) {
      throw new MBrainError(
        'Invalid retrieval source rank rule',
        `retrieval.source_rank_rules[${index}].factor must be a positive number`,
        'Use entries like {"prefix":"office/personal/","factor":1.2}',
      );
    }
    return {
      prefix: rule.prefix.trim(),
      factor: rule.factor,
    };
  });
}

export function validateResolvedConfig(config: MBrainConfig): void {
  if (!VALID_EMBEDDING_PROVIDERS.has(config.embedding_provider)) {
    throw new MBrainError(
      'Invalid embedding provider',
      `Unsupported embedding_provider: ${String(config.embedding_provider)}`,
      'Use embedding_provider="none" or embedding_provider="local"',
    );
  }

  if (!VALID_QUERY_REWRITE_PROVIDERS.has(config.query_rewrite_provider)) {
    throw new MBrainError(
      'Invalid query rewrite provider',
      `Unsupported query_rewrite_provider: ${String(config.query_rewrite_provider)}`,
      'Use query_rewrite_provider="none", "heuristic", or "local_llm"',
    );
  }

  if (config.engine === 'postgres') {
    if (!config.database_url) {
      throw new MBrainError(
        'No database URL',
        'database_url is missing from config',
        'Run mbrain init --url <connection_string> or set MBRAIN_DATABASE_URL / DATABASE_URL',
      );
    }
    if (config.database_path) {
      throw new MBrainError(
        'Invalid Postgres config',
        'database_path is only supported when engine="sqlite" or engine="pglite"',
        'Remove database_path or switch engine to sqlite/pglite',
      );
    }
    if (config.offline) {
      throw new MBrainError(
        'Invalid Postgres config',
        'offline=true is only supported for local engines',
        'Disable offline mode or switch engine to sqlite',
      );
    }
  }

  if (config.engine === 'sqlite' || config.engine === 'pglite') {
    if (!config.database_path) {
      throw new MBrainError(
        'No database path',
        `database_path is missing from config for engine="${config.engine}"`,
        'Set database_path in ~/.mbrain/config.json before using a local engine',
      );
    }
    if (config.database_url) {
      throw new MBrainError(
        `Invalid ${config.engine} config`,
        'database_url is only supported when engine="postgres"',
        'Remove database_url or switch engine to postgres',
      );
    }
  }

  validatePgVectorEmbeddingConfig(config);
}

export function toEngineConfig(
  config: MBrainConfig,
  options?: { poolSize?: number; schemaLogger?: (message: string) => void },
): EngineConfig {
  return {
    engine: config.engine,
    database_url: config.database_url,
    database_path: config.database_path,
    ...(options?.poolSize ? { poolSize: options.poolSize } : {}),
    ...(options?.schemaLogger ? { schemaLogger: options.schemaLogger } : {}),
  };
}

export function configDir(): string {
  return getConfigDir();
}

export function configPath(): string {
  return getConfigPath();
}

export function defaultLocalDatabasePath(): string {
  return join(configDir(), 'brain.db');
}

export function defaultPGLiteDatabasePath(): string {
  return join(configDir(), 'brain.pglite');
}

export function createLocalConfigDefaults(
  overrides: MBrainConfigInput = {},
): MBrainConfig {
  return resolveConfig({
    engine: 'sqlite',
    database_path: overrides.database_path ?? process.env.MBRAIN_DATABASE_PATH ?? defaultLocalDatabasePath(),
    offline: overrides.offline ?? true,
    embedding_provider: overrides.embedding_provider ?? 'local',
    embedding_model: overrides.embedding_model ?? 'qwen3-embedding:0.6b',
    query_rewrite_provider: overrides.query_rewrite_provider ?? 'heuristic',
    openai_api_key: overrides.openai_api_key,
    anthropic_api_key: overrides.anthropic_api_key,
    storage: overrides.storage,
  });
}

function validatePgVectorEmbeddingConfig(config: MBrainConfig): void {
  if (config.embedding_provider !== 'local') return;
  if (config.engine !== 'postgres' && config.engine !== 'pglite') return;

  const model = process.env.MBRAIN_LOCAL_EMBEDDING_MODEL
    || config.embedding_model
    || DEFAULT_LOCAL_EMBEDDING_MODEL;
  const dimensions = parsePositiveInt(process.env.MBRAIN_LOCAL_EMBEDDING_DIMENSIONS)
    ?? defaultEmbeddingDimensionsForModel(model);

  if (dimensions === null || dimensions === DEFAULT_LOCAL_EMBEDDING_DIMENSIONS) return;

  throw new MBrainError(
    'Invalid pgvector embedding model',
    `engine="${config.engine}" with embedding_provider="local" requires ${DEFAULT_LOCAL_EMBEDDING_DIMENSIONS}-dimensional embeddings; model "${model}" resolves to ${dimensions} dimensions`,
    'Use qwen3-embedding:0.6b, bge-m3, mxbai-embed-large, or another 1024-dimensional embedding model for Postgres/PGLite.',
  );
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
