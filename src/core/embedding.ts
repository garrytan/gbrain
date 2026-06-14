/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Defaults to OpenAI text-embedding-3-large at 1536 dimensions.
 * Override via env vars to use Cloudflare Workers AI or any OpenAI-compatible provider:
 *   GBRAIN_EMBED_PROVIDER=cloudflare
 *   CLOUDFLARE_ACCOUNT_ID=<account-id>
 *   CLOUDFLARE_API_TOKEN=<workers-ai-token>
 *   GBRAIN_EMBED_MODEL=@cf/baai/bge-large-en-v1.5
 *
 *   OPENAI_API_KEY=<key>
 *   OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
 *   GBRAIN_EMBED_MODEL=nvidia/nv-embedqa-e5-v5
 *   GBRAIN_EMBED_DIMENSIONS=1024   (omit to let provider use its native output size)
 *   GBRAIN_EMBED_INPUT_TYPE=passage  (NVIDIA asymmetric models require "query" or "passage")
 *   GBRAIN_EMBED_DIMENSION_MISMATCH=pad|truncate|native|error
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import { cleanForEmbedding } from './chunkers/clean.ts';

type EmbeddingProvider = 'openai' | 'cloudflare' | 'openai-compatible';
type DimensionMismatchMode = 'pad' | 'truncate' | 'native' | 'error';

const PROVIDER = resolveEmbeddingProvider();
const CLOUDFLARE_DEFAULT_MODEL = '@cf/baai/bge-large-en-v1.5';
const MODEL = process.env.GBRAIN_EMBED_MODEL
  ?? (PROVIDER === 'cloudflare' ? CLOUDFLARE_DEFAULT_MODEL : 'text-embedding-3-large');
const DIMENSIONS = process.env.GBRAIN_EMBED_DIMENSIONS
  ? parseInt(process.env.GBRAIN_EMBED_DIMENSIONS, 10)
  : 1536;
// Only pass the dimensions param when using OpenAI (which supports truncation).
// Third-party providers (Cloudflare, NVIDIA NIM, etc.) return fixed-size vectors and reject it.
const PASS_DIMENSIONS = PROVIDER === 'openai' && !process.env.OPENAI_BASE_URL;
// NVIDIA asymmetric models (nv-embedqa-*) require input_type in the request body.
const INPUT_TYPE = process.env.GBRAIN_EMBED_INPUT_TYPE ?? null;
const DIMENSION_MISMATCH = resolveDimensionMismatchMode();
// Allow providers with shorter context windows (e.g. NVIDIA nv-embedqa-e5-v5: 512 tokens ≈ 2000 chars).
const MAX_CHARS = process.env.GBRAIN_EMBED_MAX_CHARS
  ? parseInt(process.env.GBRAIN_EMBED_MAX_CHARS, 10)
  : 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    if (PROVIDER === 'cloudflare') {
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_AUTH_TOKEN;
      if (!accountId || !apiToken) {
        throw new Error('Cloudflare embeddings require CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
      }
      client = new OpenAI({
        apiKey: apiToken,
        baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      });
    } else {
      // OpenAI SDK reads OPENAI_API_KEY and OPENAI_BASE_URL from env automatically.
      client = new OpenAI();
    }
  }
  return client;
}

function resolveEmbeddingProvider(): EmbeddingProvider {
  const configured = process.env.GBRAIN_EMBED_PROVIDER?.toLowerCase();
  if (configured === 'cloudflare' || configured === 'openai' || configured === 'openai-compatible') {
    return configured;
  }
  if (process.env.CLOUDFLARE_ACCOUNT_ID && (process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_AUTH_TOKEN)) {
    return 'cloudflare';
  }
  if (process.env.OPENAI_BASE_URL) return 'openai-compatible';
  return 'openai';
}

function resolveDimensionMismatchMode(): DimensionMismatchMode {
  const configured = process.env.GBRAIN_EMBED_DIMENSION_MISMATCH?.toLowerCase();
  if (configured === 'pad' || configured === 'truncate' || configured === 'native' || configured === 'error') {
    return configured;
  }
  return PROVIDER === 'cloudflare' ? 'pad' : 'native';
}

export function hasEmbeddingCredentials(): boolean {
  if (PROVIDER === 'cloudflare') {
    return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && (process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_AUTH_TOKEN));
  }
  return Boolean(process.env.OPENAI_API_KEY);
}

export async function embed(text: string): Promise<Float32Array> {
  const cleaned = cleanForEmbedding(text).slice(0, MAX_CHARS);
  const result = await embedBatch([cleaned]);
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
  const truncated = texts.map(t => cleanForEmbedding(t).slice(0, MAX_CHARS));
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createParams: any = {
        model: MODEL,
        input: texts,
        ...(PASS_DIMENSIONS ? { dimensions: DIMENSIONS } : {}),
        ...(INPUT_TYPE ? { input_type: INPUT_TYPE } : {}),
      };
      const response = await getClient().embeddings.create(createParams);

      // Sort by index to maintain order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => normalizeEmbeddingDimensions(d.embedding));
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

export function normalizeEmbeddingDimensions(
  embedding: number[] | Float32Array,
  targetDimensions = DIMENSIONS,
  mode: DimensionMismatchMode = DIMENSION_MISMATCH,
): Float32Array {
  const vector = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
  if (vector.length === targetDimensions || mode === 'native') return vector;

  if (mode === 'pad' && vector.length < targetDimensions) {
    const padded = new Float32Array(targetDimensions);
    padded.set(vector);
    return padded;
  }

  if (mode === 'truncate' && vector.length > targetDimensions) {
    return vector.slice(0, targetDimensions);
  }

  throw new Error(
    `Embedding dimension mismatch: model returned ${vector.length}, target is ${targetDimensions}. ` +
    'Set GBRAIN_EMBED_DIMENSION_MISMATCH=pad, truncate, native, or error.',
  );
}

export { MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS, PROVIDER as EMBEDDING_PROVIDER };

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
