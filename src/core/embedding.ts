/**
 * Embedding Service — v0.14+ thin delegation to src/core/ai/gateway.ts.
 *
 * The gateway handles provider resolution, retry, error normalization,
 * character truncation, and dimension-parameter passthrough (preserving
 * existing 1536-dim brains). Local runtime can still override the configured
 * model/dimensions via GBRAIN_EMBEDDING_MODEL / GBRAIN_EMBEDDING_DIMENSIONS
 * through loadConfig() before the gateway is configured.
 */

import {
  embed as gatewayEmbed,
  embedOne as gatewayEmbedOne,
  getEmbeddingModel as gatewayGetModel,
  getEmbeddingDimensions as gatewayGetDims,
} from './ai/gateway.ts';

// v0.27.1: re-export multimodal embedding so callers can pull both text and
// image embedding APIs from `src/core/embedding`. import-image-file consumes
// embedMultimodal directly.
export { embedMultimodal } from './ai/gateway.ts';
export type { MultimodalInput } from './ai/types.ts';

/** Embed one text. */
export async function embed(text: string): Promise<Float32Array> {
  return gatewayEmbedOne(text);
}

export interface EmbedBatchOptions {
  /**
   * Optional callback fired after each sub-batch completes. CLI wrappers
   * tick a reporter; Minion handlers can call job.updateProgress here.
   */
  onBatchComplete?: (done: number, total: number) => void;
}

/**
 * Embed a batch of texts via the gateway. Sub-batches of 100 so upstream
 * progress callbacks fire incrementally on large imports. The gateway owns
 * adaptive batch splitting and per-recipe token-budget logic; this paginator
 * is purely about progress-callback granularity.
 */
const BATCH_SIZE = 100;
export async function embedBatch(
  texts: string[],
  options: EmbedBatchOptions = {},
): Promise<Float32Array[]> {
  if (!texts || texts.length === 0) return [];
  // Fast path: small batch, no progress callback — single gateway call.
  if (texts.length <= BATCH_SIZE && !options.onBatchComplete) {
    return gatewayEmbed(texts);
  }
  const results: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const out = await gatewayEmbed(slice);
    results.push(...out);
    options.onBatchComplete?.(results.length, texts.length);
  }
  return results;
}

/** Currently-configured embedding model (short form without provider prefix). */
export function getEmbeddingModelName(): string {
  return gatewayGetModel().split(':').slice(1).join(':') || 'text-embedding-3-large';
}

/** Currently-configured embedding dimensions. */
export function getEmbeddingDimensions(): number {
  return gatewayGetDims();
}

// Back-compat exports for legacy callers that imported these from v0.13.
// Keep the local env override so operator-configured Qwen/OpenAI-compatible
// paths label chunks/previews with the same model used by loadConfig().
export const EMBEDDING_MODEL = process.env.GBRAIN_EMBEDDING_MODEL || 'text-embedding-3-large';
export const EMBEDDING_DIMENSIONS = parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS || '1536', 10);

/**
 * USD cost per 1k tokens for text-embedding-3-large. Used by
 * `gbrain sync --all` cost preview and `reindex-code` to surface
 * expected spend before accepting expensive operations.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
