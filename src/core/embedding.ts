/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 *
 *
 *
 */

import { getActiveProvider } from './embedding-provider.ts';

export async function embed(text: string): Promise<Float32Array> {
  return getActiveProvider().embed(text);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  return getActiveProvider().embedBatch(texts);
}

// the persisted provider choice to env before these are first read.
// Previously exported as module-level const, which caused ordering bugs:
// the provider singleton was created at import time, before config was applied.
export function getEmbeddingModel(): string { return getActiveProvider().model; }
export function getEmbeddingDimensions(): number { return getActiveProvider().dimensions; }
