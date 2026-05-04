/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * OpenAI-compatible embeddings.
 *
 * Defaults to OpenAI text-embedding-v4 at 1536 dimensions, but can run
 * against any OpenAI-compatible embedding endpoint by setting:
 *   - GBRAIN_EMBEDDING_API_KEY or OPENAI_API_KEY
 *   - GBRAIN_EMBEDDING_BASE_URL or OPENAI_BASE_URL
 *   - GBRAIN_EMBEDDING_MODEL or OPENAI_EMBEDDING_MODEL
 *   - GBRAIN_EMBEDDING_TARGET_DIMENSIONS or OPENAI_EMBEDDING_DIMENSIONS
 *
 * Example: DashScope/Qwen's OpenAI-compatible endpoint works by setting
 * GBRAIN_EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
 * and GBRAIN_EMBEDDING_MODEL=text-embedding-v4.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';

const DEFAULT_MODEL = 'text-embedding-v4';
const DEFAULT_DIMENSIONS = 1024;
const MODEL = firstEnv('GBRAIN_EMBEDDING_MODEL', 'OPENAI_EMBEDDING_MODEL') ?? DEFAULT_MODEL;
const DIMENSIONS = parseDimensions(
  firstEnv(
    'GBRAIN_EMBEDDING_TARGET_DIMENSIONS',
    'GBRAIN_EMBEDDING_DIMENSIONS',
    'OPENAI_EMBEDDING_DIMENSIONS',
  ),
) ?? DEFAULT_DIMENSIONS;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseDimensions(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeOpenAIBaseURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\/+$/, '');
  // DashScope documents its OpenAI-compatible base as /compatible-mode/v1.
  // Users commonly paste /compatible-mode; normalize that footgun here so
  // adapters do not have to special-case provider quirks.
  if (trimmed.endsWith('/compatible-mode')) return `${trimmed}/v1`;
  return trimmed;
}

function getClient(): OpenAI {
  if (!client) {
    const apiKey = firstEnv('OPENAI_API_KEY', 'GBRAIN_EMBEDDING_API_KEY');
    const baseURL = normalizeOpenAIBaseURL(
      firstEnv('OPENAI_BASE_URL', 'GBRAIN_EMBEDDING_BASE_URL'),
    );
    client = new OpenAI({
      ...(apiKey ? { apiKey } : {}),
      ...(baseURL ? { baseURL } : {}),
    });
  }
  return client;
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
      const response = await getClient().embeddings.create({
        model: MODEL,
        input: texts,
        dimensions: DIMENSIONS,
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

export { MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS };

/**
 * v0.20.0 Cathedral II Layer 8 (D1): USD cost per 1k tokens for
 * the default OpenAI embedding model. Used by `gbrain sync --all` cost preview and
 * the reindex-code backfill command to surface expected spend before
 * the agent/user accepts an expensive operation.
 *
 * Value: $0.00013 / 1k tokens as of 2026. Custom OpenAI-compatible providers
 * may price differently; treat previews as OpenAI-default estimates unless the
 * caller overrides pricing in a future provider config.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
