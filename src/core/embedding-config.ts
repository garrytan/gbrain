import type { BrainEngine } from './engine.ts';
import { loadConfig } from './config.ts';
import { resolveOpenAICredentials } from './openai-credentials.ts';

const DEFAULT_OPENAI_MODEL = 'text-embedding-3-large';
const DEFAULT_OPENAI_DIMENSIONS = 1536;
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';
const DEFAULT_OLLAMA_DIMENSIONS = 768;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

type Provider = 'openai' | 'ollama';
type EnvLike = Record<string, string | undefined>;
type EngineConfigMap = Record<string, string | null | undefined>;

export interface ResolvedEmbeddingSettings {
  provider: Provider;
  model: string;
  dimensions: number;
  baseURL?: string;
}

export interface ResolveEmbeddingSettingsSources {
  env?: EnvLike;
  engineConfig?: EngineConfigMap;
  fileConfig?: {
    embedding_provider?: string;
    embedding_model?: string;
    embedding_dimensions?: number;
    embedding_base_url?: string;
    ollama_base_url?: string;
  } | null;
}

export async function resolveEmbeddingSettings(engine?: BrainEngine): Promise<ResolvedEmbeddingSettings> {
  const env = process.env as EnvLike;
  const fileConfig = loadConfig();
  const engineConfig = engine ? await loadEngineConfig(engine) : undefined;
  return resolveEmbeddingSettingsFromSources({ env, engineConfig, fileConfig });
}

export function resolveEmbeddingSettingsFromSources(sources: ResolveEmbeddingSettingsSources): ResolvedEmbeddingSettings {
  const env = sources.env || {};
  const engineConfig = sources.engineConfig || {};
  const fileConfig = sources.fileConfig || null;

  const provider = normalizeProvider(
    env.GBRAIN_EMBEDDING_PROVIDER
    || stringValue(engineConfig.embedding_provider)
    || fileConfig?.embedding_provider,
  );

  const defaults = provider === 'ollama'
    ? {
        model: DEFAULT_OLLAMA_MODEL,
        dimensions: DEFAULT_OLLAMA_DIMENSIONS,
        baseURL: DEFAULT_OLLAMA_BASE_URL,
      }
    : {
        model: DEFAULT_OPENAI_MODEL,
        dimensions: DEFAULT_OPENAI_DIMENSIONS,
        baseURL: undefined,
      };

  const model = normalize(
    env.GBRAIN_EMBEDDING_MODEL
    || stringValue(engineConfig.embedding_model)
    || fileConfig?.embedding_model,
  ) || defaults.model;

  const dimensions = normalizePositiveInt(
    env.GBRAIN_EMBEDDING_DIMENSIONS
    || stringValue(engineConfig.embedding_dimensions)
    || numberValue(fileConfig?.embedding_dimensions),
  ) || defaults.dimensions;

  const baseURL = normalizeBaseURL(
    provider === 'ollama'
      ? env.GBRAIN_OLLAMA_BASE_URL
        || env.OLLAMA_HOST
        || stringValue(engineConfig.embedding_base_url)
        || stringValue(engineConfig.ollama_base_url)
        || fileConfig?.embedding_base_url
        || fileConfig?.ollama_base_url
        || defaults.baseURL
      : env.GBRAIN_OPENAI_BASE_URL
        || env.OPENAI_BASE_URL
        || stringValue(engineConfig.embedding_base_url)
        || fileConfig?.embedding_base_url
        || defaults.baseURL,
  );

  return { provider, model, dimensions, baseURL };
}

export async function hasEmbeddingSupport(engine?: BrainEngine): Promise<boolean> {
  const settings = await resolveEmbeddingSettings(engine);
  if (settings.provider === 'ollama') return true;
  return !!resolveOpenAICredentials();
}

export async function ensureEmbeddingSchema(engine: BrainEngine): Promise<void> {
  const settings = await resolveEmbeddingSettings(engine);
  const currentDimensions = await engine.getEmbeddingDimensions();

  if (currentDimensions !== settings.dimensions) {
    await engine.runMigration(0, buildEmbeddingMigrationSql(settings.dimensions));
  }

  await engine.setConfig('embedding_provider', settings.provider);
  await engine.setConfig('embedding_model', settings.model);
  await engine.setConfig('embedding_dimensions', String(settings.dimensions));
  if (settings.baseURL) {
    await engine.setConfig('embedding_base_url', settings.baseURL);
  }
}

export function buildEmbeddingMigrationSql(dimensions: number): string {
  const safeDimensions = normalizePositiveInt(String(dimensions));
  if (!safeDimensions) {
    throw new Error(`Invalid embedding dimensions: ${dimensions}`);
  }

  return `
    DROP INDEX IF EXISTS idx_chunks_embedding;
    UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;
    ALTER TABLE content_chunks
      ALTER COLUMN embedding TYPE vector(${safeDimensions}) USING NULL;
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
  `;
}

async function loadEngineConfig(engine: BrainEngine): Promise<EngineConfigMap> {
  const keys = [
    'embedding_provider',
    'embedding_model',
    'embedding_dimensions',
    'embedding_base_url',
    'ollama_base_url',
  ];

  const entries = await Promise.all(keys.map(async (key) => [key, await engine.getConfig(key)] as const));
  return Object.fromEntries(entries);
}

function normalizeProvider(value: unknown): Provider {
  return normalize(value).toLowerCase() === 'ollama' ? 'ollama' : 'openai';
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringValue(value: unknown): string | undefined {
  const normalized = normalize(value);
  return normalized || undefined;
}

function numberValue(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  const normalized = normalize(value);
  if (!normalized) return undefined;
  const parsed = parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function normalizeBaseURL(value: unknown): string | undefined {
  const normalized = normalize(value).replace(/\/+$/, '');
  if (!normalized) return undefined;
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) return normalized;
  return `http://${normalized}`;
}

export {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_DIMENSIONS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_DIMENSIONS,
  DEFAULT_OLLAMA_BASE_URL,
};
