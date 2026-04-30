/**
 * Embedding Service
 *
 * Default path: OpenAI text-embedding-3-large at 1536 dimensions.
 * Optional path: Voyage embeddings via GBRAIN_EMBED_PROVIDER=voyage.
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';

const DEFAULT_OPENAI_MODEL = 'text-embedding-3-large';
const DEFAULT_OPENAI_DIMENSIONS = 1536;

// Deliberately defaults to the legacy 1536-dim Voyage model because the shipped
// GBrain schema is vector(1536). Newer Voyage models default to 1024/2048 and
// require a schema migration or fresh DB initialized at that dimension.
const DEFAULT_VOYAGE_MODEL = 'voyage-large-2';
const DEFAULT_VOYAGE_DIMENSIONS = 1536;
const DEFAULT_VOYAGE_BASE_URL = 'https://api.voyageai.com/v1';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

const VOYAGE_OUTPUT_DIMENSION_MODELS = new Set([
  'voyage-4-large',
  'voyage-4',
  'voyage-4-lite',
  'voyage-3-large',
  'voyage-3.5',
  'voyage-3.5-lite',
  'voyage-code-3',
]);

type EmbeddingProvider = 'openai' | 'voyage';

interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  baseURL?: string;
  voyageInputType: 'document' | 'query' | null;
}

let client: OpenAI | null = null;
let clientKey: string | null = null;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parseProvider(raw: string | undefined): EmbeddingProvider {
  const provider = (raw || 'openai').toLowerCase();
  if (provider === 'openai' || provider === 'voyage') return provider;
  throw new Error(`Unsupported GBRAIN_EMBED_PROVIDER ${JSON.stringify(raw)}. Expected "openai" or "voyage".`);
}

export function resolveEmbeddingConfig(): EmbeddingConfig {
  const provider = parseProvider(process.env.GBRAIN_EMBED_PROVIDER);

  if (provider === 'voyage') {
    const model = process.env.GBRAIN_EMBED_MODEL || process.env.VOYAGE_EMBED_MODEL || DEFAULT_VOYAGE_MODEL;
    const defaultDimensions = model === DEFAULT_VOYAGE_MODEL ? DEFAULT_VOYAGE_DIMENSIONS : 1024;
    return {
      provider,
      model,
      dimensions: parsePositiveIntEnv('GBRAIN_EMBED_DIMENSIONS', defaultDimensions),
      baseURL: (process.env.GBRAIN_EMBED_BASE_URL || process.env.VOYAGE_BASE_URL || DEFAULT_VOYAGE_BASE_URL).replace(/\/+$/, ''),
      voyageInputType: (process.env.GBRAIN_EMBED_INPUT_TYPE as 'document' | 'query' | undefined) || 'document',
    };
  }

  return {
    provider,
    model: process.env.GBRAIN_EMBED_MODEL || DEFAULT_OPENAI_MODEL,
    dimensions: parsePositiveIntEnv('GBRAIN_EMBED_DIMENSIONS', DEFAULT_OPENAI_DIMENSIONS),
    baseURL: process.env.GBRAIN_EMBED_BASE_URL || process.env.OPENAI_BASE_URL,
    voyageInputType: null,
  };
}

const INITIAL_CONFIG = resolveEmbeddingConfig();
export const EMBEDDING_MODEL = INITIAL_CONFIG.model;
export const EMBEDDING_DIMENSIONS = INITIAL_CONFIG.dimensions;

function getClient(config: EmbeddingConfig): OpenAI {
  const key = `${config.baseURL || ''}\0${process.env.OPENAI_API_KEY || ''}`;
  if (!client || clientKey !== key) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: config.baseURL,
    });
    clientKey = key;
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
  const config = resolveEmbeddingConfig();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (config.provider === 'voyage') {
        return await embedVoyageBatch(texts, config);
      }
      return await embedOpenAIBatch(texts, config);
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1 || !isRetryableEmbeddingError(e)) throw e;
      await sleep(retryDelay(e, attempt));
    }
  }

  // Should not reach here
  throw new Error('Embedding failed after all retries');
}

async function embedOpenAIBatch(texts: string[], config: EmbeddingConfig): Promise<Float32Array[]> {
  const response = await getClient(config).embeddings.create({
    model: config.model,
    input: texts,
    dimensions: config.dimensions,
  });

  // Sort by index to maintain order
  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => checkedEmbedding(d.embedding, config.dimensions, 'OpenAI'));
}

class EmbeddingHTTPError extends Error {
  constructor(message: string, readonly status: number, readonly headers: Headers) {
    super(message);
    this.name = 'EmbeddingHTTPError';
  }
}

async function embedVoyageBatch(texts: string[], config: EmbeddingConfig): Promise<Float32Array[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY is required when GBRAIN_EMBED_PROVIDER=voyage');
  }

  const body: Record<string, unknown> = {
    input: texts,
    model: config.model,
    truncation: true,
  };
  if (config.voyageInputType) body.input_type = config.voyageInputType;
  if (VOYAGE_OUTPUT_DIMENSION_MODELS.has(config.model) && config.dimensions !== 1024) {
    body.output_dimension = config.dimensions;
  }

  const response = await fetch(`${config.baseURL || DEFAULT_VOYAGE_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new EmbeddingHTTPError(
      `Voyage embeddings request failed with HTTP ${response.status}: ${text.slice(0, 500)}`,
      response.status,
      response.headers,
    );
  }

  const payload = await response.json() as { data?: Array<{ index?: number; embedding: number[] }> };
  if (!Array.isArray(payload.data)) {
    throw new Error('Voyage embeddings response missing data array');
  }

  const sorted = payload.data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return sorted.map(d => checkedEmbedding(d.embedding, config.dimensions, 'Voyage'));
}

function checkedEmbedding(embedding: ArrayLike<number>, expected: number, provider: string): Float32Array {
  if (embedding.length !== expected) {
    throw new Error(`${provider} embedding dimension mismatch: expected ${expected}, got ${embedding.length}`);
  }
  return new Float32Array(Array.from(embedding));
}

function isRetryableEmbeddingError(e: unknown): boolean {
  if (e instanceof OpenAI.APIError) {
    return e.status === 429 || (typeof e.status === 'number' && e.status >= 500);
  }
  if (e instanceof EmbeddingHTTPError) {
    return e.status === 429 || e.status >= 500;
  }
  return false;
}

function retryDelay(e: unknown, attempt: number): number {
  let delay = exponentialDelay(attempt);

  if (e instanceof OpenAI.APIError && e.status === 429) {
    const retryAfter = e.headers?.['retry-after'];
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed)) delay = parsed * 1000;
    }
  }

  if (e instanceof EmbeddingHTTPError && e.status === 429) {
    const retryAfter = e.headers.get('retry-after');
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed)) delay = parsed * 1000;
    }
  }

  return delay;
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
