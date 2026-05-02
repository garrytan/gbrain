/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * OpenAI text-embedding-3-large at 1536 dimensions by default.
 * Optional local deterministic hashing provider via GBRAIN_EMBEDDING_PROVIDER=local.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';

const OPENAI_MODEL = 'text-embedding-3-large';
const DIMENSIONS = 1536;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;
const LOCAL_MODEL = `local-hash-v1-${DIMENSIONS}`;

let client: OpenAI | null = null;
let clientApiKey: string | null = null;

export type EmbeddingProvider = 'openai' | 'local';

export function getEmbeddingProvider(): EmbeddingProvider {
  const raw = (process.env.GBRAIN_EMBEDDING_PROVIDER || 'openai').trim().toLowerCase();
  if (raw === 'openai' || raw === '') return 'openai';
  if (raw === 'local' || raw === 'hash' || raw === 'local-hash') return 'local';
  throw new Error(`Unsupported GBRAIN_EMBEDDING_PROVIDER=${raw}. Supported values: openai, local`);
}

export function isEmbeddingConfigured(): boolean {
  try {
    const provider = getEmbeddingProvider();
    return provider === 'local' || Boolean(process.env.OPENAI_API_KEY?.trim());
  } catch {
    return false;
  }
}

export function getEmbeddingModel(): string {
  return getEmbeddingProvider() === 'local' ? LOCAL_MODEL : OPENAI_MODEL;
}

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for OpenAI embeddings. Set GBRAIN_EMBEDDING_PROVIDER=local to use local embeddings.');
  }
  if (!client || clientApiKey !== apiKey) {
    client = new OpenAI({ apiKey });
    clientApiKey = apiKey;
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
  const provider = getEmbeddingProvider();

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = provider === 'local'
      ? embedBatchLocal(batch)
      : await embedBatchOpenAIWithRetry(batch);
    results.push(...batchResults);
    options.onBatchComplete?.(results.length, truncated.length);
  }

  return results;
}

function embedBatchLocal(texts: string[]): Float32Array[] {
  return texts.map(localHashEmbedding);
}

function localHashEmbedding(text: string): Float32Array {
  const vector = new Float32Array(DIMENSIONS);
  const tokens = tokenize(text);

  if (tokens.length === 0) {
    const fallback = text.trim();
    if (fallback.length > 0) addFeature(vector, `text:${fallback}`, 1);
    return normalize(vector);
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    addFeature(vector, `tok:${token}`, 1);

    if (i > 0) addFeature(vector, `bi:${tokens[i - 1]} ${token}`, 1.25);

    // Character n-grams make local embeddings less brittle for code symbols,
    // typos, and partial words while staying deterministic and dependency-free.
    if (token.length >= 4) {
      for (let j = 0; j <= token.length - 4; j++) {
        addFeature(vector, `char:${token.slice(j, j + 4)}`, 0.25);
      }
    }
  }

  return normalize(vector);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function addFeature(vector: Float32Array, feature: string, weight: number): void {
  const hash = fnv1a(feature);
  const idx = hash % DIMENSIONS;
  const sign = (hash & 0x80000000) === 0 ? 1 : -1;
  vector[idx] += sign * weight;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalize(vector: Float32Array): Float32Array {
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  if (magnitude === 0) return vector;

  const scale = 1 / Math.sqrt(magnitude);
  for (let i = 0; i < vector.length; i++) vector[i] *= scale;
  return vector;
}

async function embedBatchOpenAIWithRetry(texts: string[]): Promise<Float32Array[]> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error('OPENAI_API_KEY is required for OpenAI embeddings. Set GBRAIN_EMBEDDING_PROVIDER=local to use local embeddings.');
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getClient().embeddings.create({
        model: OPENAI_MODEL,
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

export { OPENAI_MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS };

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

/** Compute USD cost estimate for the configured provider. Local embeddings are free. */
export function estimateConfiguredEmbeddingCostUsd(tokens: number): number {
  return getEmbeddingProvider() === 'local' ? 0 : estimateEmbeddingCostUsd(tokens);
}
