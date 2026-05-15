/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * OpenAI text-embedding-3-large at 1536 dimensions.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';

const DEFAULT_MODEL = 'text-embedding-3-large';
const DEFAULT_DIMENSIONS = 1536;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

export interface EmbeddingConfig {
  model: string;
  dimensions: number;
  baseURL?: string;
  apiKey?: string;
  provider: 'openai-compatible' | 'perplexity-hosted';
}

function isPerplexityConfig(model: string, baseURL?: string): boolean {
  const modelLower = model.toLowerCase();
  const baseLower = baseURL?.toLowerCase() || '';
  return modelLower.includes('pplx') || modelLower.includes('perplexity') || baseLower.includes('perplexity');
}

function isHostedPerplexity(model: string, baseURL?: string): boolean {
  const modelLower = model.toLowerCase();
  const baseLower = baseURL?.toLowerCase() || '';
  return baseLower.includes('api.perplexity.ai') || modelLower.startsWith('pplx-embed-v1-');
}

export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const model = env.GBRAIN_EMBEDDING_MODEL || DEFAULT_MODEL;
  const rawDimensions = env.GBRAIN_EMBEDDING_DIMENSIONS || String(DEFAULT_DIMENSIONS);
  const dimensions = Number.parseInt(rawDimensions, 10);

  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('GBRAIN_EMBEDDING_DIMENSIONS must be a positive integer');
  }

  const baseURL = env.GBRAIN_EMBEDDING_BASE_URL || undefined;
  const perplexityConfig = isPerplexityConfig(model, baseURL);
  const hostedPerplexity = isHostedPerplexity(model, baseURL);
  const apiKey = env.GBRAIN_EMBEDDING_API_KEY
    || (perplexityConfig ? (env.PERPLEXITY_API_KEY || env.PPLX_API_KEY) : undefined)
    || (!perplexityConfig ? env.OPENAI_API_KEY : undefined)
    || (baseURL && !hostedPerplexity ? 'not-needed' : undefined);

  return {
    model,
    dimensions,
    baseURL,
    apiKey,
    provider: hostedPerplexity ? 'perplexity-hosted' : 'openai-compatible',
  };
}

let client: OpenAI | null = null;
let clientCacheKey: string | null = null;

function getClient(config: EmbeddingConfig): OpenAI {
  const cacheKey = JSON.stringify({ baseURL: config.baseURL, apiKey: config.apiKey });
  if (!client || clientCacheKey !== cacheKey) {
    client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    clientCacheKey = cacheKey;
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
      const config = resolveEmbeddingConfig();
      const request: OpenAI.Embeddings.EmbeddingCreateParams = {
        model: config.model,
        input: texts,
        dimensions: config.dimensions,
        encoding_format: config.provider === 'perplexity-hosted' ? 'base64_int8' : 'float',
      } as OpenAI.Embeddings.EmbeddingCreateParams;
      const response = await getClient(config).embeddings.create(request);

      // Sort by index to maintain order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => coerceEmbedding(d.embedding, config));
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

function coerceEmbedding(embedding: number[] | string, config: EmbeddingConfig): Float32Array {
  const vector = typeof embedding === 'string'
    ? decodeBase64Int8Embedding(embedding)
    : new Float32Array(embedding);

  if (vector.length !== config.dimensions) {
    throw new Error(`Embedding provider returned ${vector.length} dimensions; expected ${config.dimensions}`);
  }

  return vector;
}

function decodeBase64Int8Embedding(value: string): Float32Array {
  const bytes = Buffer.from(value, 'base64');
  const vector = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    vector[i] = bytes[i] > 127 ? bytes[i] - 256 : bytes[i];
  }
  return vector;
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { DEFAULT_MODEL as EMBEDDING_MODEL, DEFAULT_DIMENSIONS as EMBEDDING_DIMENSIONS };

/**
 * v0.20.0 Cathedral II Layer 8 (D1): USD cost per 1k tokens for
 * text-embedding-3-large. Used by `gbrain sync --all` cost preview and
 * the reindex-code backfill command to surface expected spend before
 * the agent/user accepts an expensive operation.
 *
 * Value: $0.00013 / 1k tokens as of 2026. Update when OpenAI changes
 * pricing. Single source of truth — every cost-preview surface reads
 * this constant, so a pricing change is a one-line edit.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
