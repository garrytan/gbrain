import type { EmbeddingProvider } from './types.ts';
import { OpenAIProvider } from './openai.ts';
import { GeminiProvider } from './gemini.ts';
import { VoyageProvider } from './voyage.ts';

const DEFAULTS: Record<string, { model: string; dimensions: number }> = {
  openai: { model: 'text-embedding-3-large', dimensions: 1536 },
  gemini: { model: 'gemini-embedding-2-preview', dimensions: 1536 },
  voyage: { model: 'voyage-3', dimensions: 1024 },
};

let cached: EmbeddingProvider | null = null;

/** DB config cache — populated by loadEmbeddingConfig() during initSchema */
let dbConfig: { provider?: string; model?: string; dimensions?: string } = {};

/**
 * Load embedding config from DB config table.
 * Called once during initSchema() after DB is ready.
 * Values are cached and used as fallback when env vars are not set.
 */
export async function loadEmbeddingConfig(engine: { getConfig(key: string): Promise<string | null> }): Promise<void> {
  const [provider, model, dimensions] = await Promise.all([
    engine.getConfig('embedding_provider'),
    engine.getConfig('embedding_model'),
    engine.getConfig('embedding_dimensions'),
  ]);
  dbConfig = {
    provider: provider || undefined,
    model: model || undefined,
    dimensions: dimensions || undefined,
  };
}

/**
 * Resolve embedding provider from config.
 * Priority: env vars > DB config > defaults.
 * Cached for process lifetime — call resetProvider() in tests.
 */
export function getProvider(): EmbeddingProvider {
  if (cached) return cached;

  const providerName = process.env.GBRAIN_EMBEDDING_PROVIDER || dbConfig.provider || 'openai';
  const defaults = DEFAULTS[providerName];
  if (!defaults) {
    throw new Error(`Unknown embedding provider: ${providerName}. Supported: ${Object.keys(DEFAULTS).join(', ')}`);
  }

  const model = (process.env.GBRAIN_EMBEDDING_MODEL || dbConfig.model || defaults.model).trim();
  if (!model) {
    throw new Error('GBRAIN_EMBEDDING_MODEL cannot be empty');
  }

  // For DB-stored model in "provider:model" format, extract just the model part
  const resolvedModel = model.includes(':') ? model.split(':').slice(1).join(':') : model;

  const rawDims = process.env.GBRAIN_EMBEDDING_DIMENSIONS || dbConfig.dimensions;
  const dimensions = rawDims ? parseInt(String(rawDims), 10) : defaults.dimensions;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid GBRAIN_EMBEDDING_DIMENSIONS: "${rawDims}". Must be a positive integer.`);
  }

  switch (providerName) {
    case 'openai':
      cached = new OpenAIProvider(resolvedModel, dimensions);
      break;
    case 'gemini':
      cached = new GeminiProvider(resolvedModel, dimensions);
      break;
    case 'voyage':
      cached = new VoyageProvider(resolvedModel, dimensions);
      break;
  }

  return cached!;
}

/** Reset cached provider and DB config (for tests). */
export function resetProvider(): void {
  cached = null;
  dbConfig = {};
}
