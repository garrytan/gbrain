/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Defaults to OpenAI text-embedding-3-large at 1536 dimensions, but every
 * knob (model, dims, base URL, API key, cost, batch size, max chars) is
 * configurable via GBRAIN_EMBED_* env vars. See src/core/embedding-config.ts
 * for the full list and validation rules.
 *
 * To run against a local Ollama instance:
 *   export GBRAIN_EMBED_URL=http://localhost:11434/v1
 *   export GBRAIN_EMBED_MODEL=nomic-embed-text
 *   export GBRAIN_EMBED_DIMENSIONS=768
 *   export GBRAIN_EMBED_KEY=ollama        # any non-empty value
 *   export GBRAIN_EMBED_COST_PER_1K=0     # local = free
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 */

import OpenAI from 'openai';
import { getEmbeddingConfig } from './embedding-config.ts';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const cfg = getEmbeddingConfig();
    const opts: ConstructorParameters<typeof OpenAI>[0] = {};
    if (cfg.baseUrl) opts.baseURL = cfg.baseUrl;
    if (cfg.apiKey) opts.apiKey = cfg.apiKey;
    client = new OpenAI(opts);
  }
  return client;
}

/**
 * Reset the cached OpenAI client. Tests only — flush after mutating env
 * vars that affect the client (baseURL, apiKey).
 */
export function resetEmbeddingClient(): void {
  client = null;
}

export async function embed(text: string): Promise<Float32Array> {
  const cfg = getEmbeddingConfig();
  const truncated = text.slice(0, cfg.maxChars);
  const result = await embedBatch([truncated]);
  return result[0];
}

export interface EmbedBatchOptions {
  /**
   * Optional callback fired after each sub-batch completes.
   * CLI wrappers tick a reporter; Minion handlers can call
   * job.updateProgress here instead of hooking the per-page callback.
   */
  onBatchComplete?: (done: number, total: number) => void;
}

export async function embedBatch(
  texts: string[],
  options: EmbedBatchOptions = {},
): Promise<Float32Array[]> {
  const cfg = getEmbeddingConfig();
  const truncated = texts.map(t => t.slice(0, cfg.maxChars));
  const results: Float32Array[] = [];

  for (let i = 0; i < truncated.length; i += cfg.batchSize) {
    const batch = truncated.slice(i, i + cfg.batchSize);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
    options.onBatchComplete?.(results.length, truncated.length);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  const cfg = getEmbeddingConfig();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Some OpenAI-compatible providers (e.g. Ollama, LM Studio) do NOT
      // accept a `dimensions` param — they always return the model's native
      // dim. We pass it only when targeting the actual OpenAI endpoint
      // (cfg.baseUrl is undefined). For custom endpoints, the dim env var
      // is purely informational; the actual dim must match what the model
      // returns or pgvector inserts will fail with a clear error.
      const request: Parameters<ReturnType<typeof getClient>['embeddings']['create']>[0] = {
        model: cfg.model,
        input: texts,
      };
      if (!cfg.baseUrl) {
        request.dimensions = cfg.dimensions;
      }

      const response = await getClient().embeddings.create(request);

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

// ============================================================
// Backward-compatible exports
//
// Pre-existing callers import these as plain constants. We can't make
// them live-track env vars without runtime trickery (Proxy on a primitive
// is fragile — `${X}` fails). So they snapshot the config at module load.
//
// New code should call getEmbeddingConfig() directly to pick up env
// changes made after module load (e.g. tests, reindex commands that flip
// providers mid-process).
// ============================================================

const _initialConfig = getEmbeddingConfig();

/** @deprecated Prefer getEmbeddingConfig().model — this snapshots at module load. */
export const EMBEDDING_MODEL = _initialConfig.model;

/** @deprecated Prefer getEmbeddingConfig().dimensions — this snapshots at module load. */
export const EMBEDDING_DIMENSIONS = _initialConfig.dimensions;

/**
 * v0.20.0 Cathedral II Layer 8 (D1): USD cost per 1k tokens. Defaults to
 * text-embedding-3-large pricing ($0.00013) but configurable via
 * GBRAIN_EMBED_COST_PER_1K. Used by `gbrain sync --all` cost preview and
 * the reindex-code backfill command to surface expected spend before
 * the agent/user accepts an expensive operation.
 *
 * Local models: set to 0.
 *
 * @deprecated Prefer getEmbeddingConfig().costPer1kTokens — this snapshots at module load.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = _initialConfig.costPer1kTokens;

/**
 * Compute USD cost estimate for embedding `tokens` at current model rate.
 * Reads the live config each call, so cost env changes take effect mid-process.
 */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * getEmbeddingConfig().costPer1kTokens;
}
