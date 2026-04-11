/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Supports OpenAI and Venice AI embeddings while keeping stored vectors at
 * 1536 dimensions for schema compatibility.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import {
  getEmbeddingDimensions,
  getEmbeddingModel,
  resolveEmbeddingProvider,
  type EmbeddingProviderConfig,
} from './embedding-provider.ts';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;
let clientCacheKey: string | null = null;

export interface EmbeddingRequestOpts {
  config?: EmbeddingProviderConfig | null;
}

function getClient(config?: EmbeddingProviderConfig | null): OpenAI {
  const provider = resolveEmbeddingProvider(config);
  if (!provider) {
    throw new Error(
      'No embedding provider configured. Set OPENAI_API_KEY, VENICE_API_KEY, or OPENAI_BASE_URL.',
    );
  }

  const cacheKey = `${provider.provider}:${provider.baseURL || ''}:${provider.apiKey}`;
  if (!client || clientCacheKey !== cacheKey) {
    client = new OpenAI({
      apiKey: provider.apiKey,
      ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
    });
    clientCacheKey = cacheKey;
  }

  return client;
}

export async function embed(text: string, opts: EmbeddingRequestOpts = {}): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated], opts);
  return result[0];
}

export async function embedBatch(
  texts: string[],
  opts: EmbeddingRequestOpts = {},
): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch, opts);
    results.push(...batchResults);
  }

  return results;
}

async function embedBatchWithRetry(
  texts: string[],
  opts: EmbeddingRequestOpts,
): Promise<Float32Array[]> {
  const provider = resolveEmbeddingProvider(opts.config);
  if (!provider) {
    throw new Error(
      'No embedding provider configured. Set OPENAI_API_KEY, VENICE_API_KEY, or OPENAI_BASE_URL.',
    );
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getClient(opts.config).embeddings.create({
        model: provider.model,
        input: texts,
        dimensions: provider.dimensions,
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

export { getEmbeddingModel, getEmbeddingDimensions };
