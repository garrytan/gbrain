/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Provider-agnostic via the unified AI provider layer. Defaults to
 * OpenAI-compatible adapter; any provider with an OpenAI Embeddings
 * endpoint works (DeepSeek, Groq, Ollama, local proxies).
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import { getEmbeddingProvider } from '../llm/factory.ts';
import type { AIProvider } from '../llm/provider.ts';

// Backward-compatible defaults. The runtime model may differ when the
// user configures a custom embedding_provider / embedding_model.
const MODEL = 'text-embedding-3-large';
const DIMENSIONS = 1536;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

function getProvider(): AIProvider {
  const provider = getEmbeddingProvider();
  if (!provider) {
    throw new Error(
      'No embedding provider configured. Set OPENAI_API_KEY or configure ' +
        'embedding_provider in ~/.gbrain/config.json',
    );
  }
  return provider;
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
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const provider = getProvider();
      return await provider.embed(texts);
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;

      // Check for rate limit with Retry-After header
      let delay = exponentialDelay(attempt);

      // Duck-type check for OpenAI-compatible rate-limit errors
      if (
        typeof e === 'object' &&
        e !== null &&
        'status' in e &&
        (e as any).status === 429
      ) {
        const retryAfter = (e as any).headers?.['retry-after'];
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

export { MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS };

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
 * NOTE: When using a non-OpenAI embedding provider, cost estimation
 * degrades gracefully (shows "cost unknown") — see slice #5.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
