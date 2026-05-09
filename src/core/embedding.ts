/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Provider is configurable via GBRAIN_EMBEDDING_PROVIDER env var:
 *   - "openai" (default): uses OpenAI API (OPENAI_API_KEY required)
 *   - "ollama": uses local Ollama via OpenAI-compatible API (zero cost)
 *
 * Model and dimensions are configurable via env vars:
 *   - GBRAIN_EMBEDDING_MODEL (default: text-embedding-3-large for openai, nomic-embed-text for ollama)
 *   - GBRAIN_EMBEDDING_DIMENSIONS (default: 768)
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';

const PROVIDER = process.env.GBRAIN_EMBEDDING_PROVIDER || 'openai';
const DEFAULT_MODEL = PROVIDER === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-large';
const MODEL = process.env.GBRAIN_EMBEDDING_MODEL || DEFAULT_MODEL;
const DIMENSIONS = parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS || '768', 10);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    if (PROVIDER === 'ollama') {
      client = new OpenAI({
        baseURL: OLLAMA_BASE_URL,
        apiKey: 'ollama', // Ollama does not require a real API key
      });
    } else {
      client = new OpenAI();
    }
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
  // Ollama does not support batch embedding — process one at a time
  if (PROVIDER === 'ollama') {
    const results: Float32Array[] = [];
    for (const text of texts) {
      const vec = await embedSingleWithRetry(text);
      results.push(vec);
    }
    return results;
  }

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

async function embedSingleWithRetry(text: string): Promise<Float32Array> {
  let input = text;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getClient().embeddings.create({
        model: MODEL,
        input,
      });
      return new Float32Array(response.data[0].embedding);
    } catch (e: unknown) {
      // Context-length errors (e.g. CJK text where 1 char > 1 token) cannot
      // be fixed by retrying — halve the input and retry immediately.
      if (e instanceof OpenAI.APIError && e.status === 400) {
        const msg = (e.message ?? '').toLowerCase();
        if (msg.includes('context length') || msg.includes('input length') || msg.includes('too long')) {
          const halved = Math.floor(input.length / 2);
          if (halved < 100) throw e; // too short to be useful; propagate
          input = input.slice(0, halved);
          continue; // retry immediately with shorter input, no sleep
        }
      }
      if (attempt === MAX_RETRIES - 1) throw e;
      await sleep(exponentialDelay(attempt));
    }
  }
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
 * Value: $0.00013 / 1k tokens as of 2026 for openai. Ollama is $0.
 * Single source of truth — every cost-preview surface reads
 * this constant, so a pricing change is a one-line edit.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = PROVIDER === 'ollama' ? 0 : 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
