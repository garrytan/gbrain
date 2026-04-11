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

/**
 * Resolve embedding provider from config.
 * Priority: env vars > DB config (future) > fallback (openai).
 * Cached for process lifetime — call resetProvider() in tests.
 */
export function getProvider(): EmbeddingProvider {
  if (cached) return cached;

  const providerName = process.env.GBRAIN_EMBEDDING_PROVIDER || 'openai';
  const defaults = DEFAULTS[providerName];
  if (!defaults) {
    throw new Error(`Unknown embedding provider: ${providerName}. Supported: ${Object.keys(DEFAULTS).join(', ')}`);
  }

  const model = (process.env.GBRAIN_EMBEDDING_MODEL || defaults.model).trim();
  if (!model) {
    throw new Error('GBRAIN_EMBEDDING_MODEL cannot be empty');
  }

  const rawDims = process.env.GBRAIN_EMBEDDING_DIMENSIONS;
  const dimensions = rawDims ? parseInt(rawDims, 10) : defaults.dimensions;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid GBRAIN_EMBEDDING_DIMENSIONS: "${rawDims}". Must be a positive integer.`);
  }

  switch (providerName) {
    case 'openai':
      cached = new OpenAIProvider(model, dimensions);
      break;
    case 'gemini':
      cached = new GeminiProvider(model, dimensions);
      break;
    case 'voyage':
      cached = new VoyageProvider(model, dimensions);
      break;
  }

  return cached!;
}

/** Reset cached provider (for tests). */
export function resetProvider(): void {
  cached = null;
}
