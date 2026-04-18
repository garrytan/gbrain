/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * // FORK: Delegates to the active EmbeddingProvider (openai | gemini).
 * // FORK: Set GBRAIN_EMBEDDING_PROVIDER=gemini to switch providers.
 * // FORK: Public API (embed, embedBatch, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS) is unchanged.
 */

import { getActiveProvider } from './embedding-provider.ts';

export async function embed(text: string): Promise<Float32Array> {
  return getActiveProvider().embed(text);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  return getActiveProvider().embedBatch(texts);
}

// FORK: These reflect the active provider, not hardcoded OpenAI values.
export const EMBEDDING_MODEL = getActiveProvider().model;
export const EMBEDDING_DIMENSIONS = getActiveProvider().dimensions;
