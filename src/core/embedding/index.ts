export type { EmbeddingProvider } from './types.ts';
export { getProvider, resetProvider } from './registry.ts';

import { getProvider } from './registry.ts';

/**
 * Embed a single text using the configured provider.
 * Drop-in replacement for the old embedding.ts API.
 */
export async function embed(text: string): Promise<Float32Array> {
  if (!text.trim()) return new Float32Array(getProvider().dimensions);
  return getProvider().embed(text);
}

/**
 * Embed multiple texts using the configured provider.
 * Drop-in replacement for the old embedding.ts API.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const provider = getProvider();
  const dims = provider.dimensions;
  const nonEmpty = texts.map((t, i) => ({ t, i })).filter(({ t }) => t.trim());
  if (nonEmpty.length === 0) return texts.map(() => new Float32Array(dims));

  const results = await provider.embedBatch(nonEmpty.map(({ t }) => t));
  const out = texts.map(() => new Float32Array(dims));
  for (let j = 0; j < nonEmpty.length; j++) {
    out[nonEmpty[j].i] = results[j];
  }
  return out;
}

/** Current model name (resolved lazily). */
export function getEmbeddingModel(): string {
  return getProvider().model;
}

/** Current dimensions (resolved lazily). */
export function getEmbeddingDimensions(): number {
  return getProvider().dimensions;
}

/** @deprecated Use getEmbeddingModel() for runtime value — this always returns the OpenAI default */
export const EMBEDDING_MODEL = 'text-embedding-3-large';
/** @deprecated Use getEmbeddingDimensions() for runtime value — this always returns the OpenAI default */
export const EMBEDDING_DIMENSIONS = 1536;
