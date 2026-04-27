/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Default: OpenAI text-embedding-3-large at 1536 dimensions.
 * Configuration is read from `embedding-config.ts` (env-driven).
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
  getEmbeddingModel,
  getEmbeddingDimensions,
  getEmbeddingBaseUrl,
  getEmbeddingApiKey,
} from './embedding-config.ts';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = getEmbeddingApiKey();
    const baseURL = getEmbeddingBaseUrl();
    client = new OpenAI({
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
    });
  }
  return client;
}

/**
 * Reset the cached OpenAI client. Tests use this when they re-stub env vars
 * mid-suite; production code never needs to call it.
 *
 * @internal
 */
export function resetEmbeddingClient(): void {
  client = null;
}

export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated]);
  return result[0];
}

export interface EmbedBatchOptions {
  /**
   * Optional callback fired after each 100-item sub-batch completes.
   * CLI wrappers tick a reporter; Minion handlers can call
   * job.updateProgress here instead of hooking the per-page callback.
   */
  onBatchComplete?: (done: number, total: number) => void;
}

export async function embedBatch(
  texts: string[],
  options: EmbedBatchOptions = {},
): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
    options.onBatchComplete?.(results.length, truncated.length);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  const model = getEmbeddingModel();
  const dimensions = getEmbeddingDimensions();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getClient().embeddings.create({
        model,
        input: texts,
        dimensions,
      });

      // Sort by index to maintain order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;

      // Check for rate limit with Retry-After header
      let delay = exponentialDelay(attempt);

      if (e instanceof OpenAI.APIError && e.status === 429) {
        const retryAfter = e.headers?.['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) {
            delay = parsed * 1000;
          }
        }
      }

      await sleep(delay);
    }
  }

  // Should not reach here
  throw new Error('Embedding failed after all retries');
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Backward-compat exports. Module-load constants are kept around because
 * other call sites import them directly; they reflect the env at first import.
 * Prefer the function form for code that may run after env mutation (tests).
 */
export const EMBEDDING_MODEL = getEmbeddingModel();
export const EMBEDDING_DIMENSIONS = getEmbeddingDimensions();

// Re-export config helpers so callers that already import from `embedding.ts`
// keep working. New code should import from `embedding-config.ts` directly.
export {
  getEmbeddingModel,
  getEmbeddingDimensions,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
};

/**
 * v0.20.0 Cathedral II Layer 8 (D1): USD cost per 1k tokens for
 * text-embedding-3-large. Used by `gbrain sync --all` cost preview and
 * the reindex-code backfill command to surface expected spend before
 * the agent/user accepts an expensive operation.
 *
 * Value: $0.00013 / 1k tokens as of 2026. Update when OpenAI changes
 * pricing. Single source of truth — every cost-preview surface reads
 * this constant, so a pricing change is a one-line edit.
 *
 * Only meaningful when the configured model is OpenAI's; for self-hosted
 * embedders the cost is zero by definition. Callers can branch on
 * `getEmbeddingModel()` if they need a strict zero for non-OpenAI runs.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
