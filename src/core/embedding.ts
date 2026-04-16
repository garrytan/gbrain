/**
 * Embedding Service — provider router
 *
 * Selects between OpenAI (default) and self-hosted E5 based on:
 *   GBRAIN_EMBEDDING_PROVIDER=e5|openai   (default: openai)
 *
 * OpenAI: text-embedding-3-large at 1536 dimensions.
 * E5:     intfloat/multilingual-e5-small (or compatible) at 384 dimensions.
 *
 * Both providers expose the same interface: embed(), embedBatch(),
 * EMBEDDING_MODEL, EMBEDDING_DIMENSIONS.
 */

import * as e5 from './embedding-e5.ts';
import * as openai from './embedding-openai.ts';

const PROVIDER = (process.env.GBRAIN_EMBEDDING_PROVIDER || 'openai').toLowerCase();
const isE5 = PROVIDER === 'e5';

export async function embed(text: string): Promise<Float32Array> {
  return isE5 ? e5.embed(text) : openai.embed(text);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  return isE5 ? e5.embedBatch(texts) : openai.embedBatch(texts);
}

export const EMBEDDING_MODEL = isE5 ? e5.EMBEDDING_MODEL : openai.EMBEDDING_MODEL;
export const EMBEDDING_DIMENSIONS = isE5 ? e5.EMBEDDING_DIMENSIONS : openai.EMBEDDING_DIMENSIONS;

/**
 * Runtime dimensions — accounts for auto-detection in E5 provider.
 * Use this instead of EMBEDDING_DIMENSIONS when the actual dimension
 * matters (schema creation, vector column sizing).
 */
export function getEmbeddingDimensions(): number {
  return isE5 ? e5.getE5Dimensions() : openai.EMBEDDING_DIMENSIONS;
}

export function getEmbeddingProvider(): string {
  return isE5 ? 'e5' : 'openai';
}
