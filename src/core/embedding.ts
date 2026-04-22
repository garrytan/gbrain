/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * OpenAI text-embedding-3-large at 1536 dimensions.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 *
 * Environment variables:
 *   GBRAIN_EMBEDDING_MODEL      - Embedding model name (default: text-embedding-3-large)
 *   GBRAIN_EMBEDDING_BASE_URL   - Custom endpoint URL (e.g., http://localhost:11434/v1 for Ollama)
 *   GBRAIN_EMBEDDING_DIMENSIONS - Embedding dimensions (default: 1536)
 *   OPENAI_BASE_URL / OPENAI_API_KEY - Standard OpenAI SDK env vars
 */

import OpenAI from 'openai';

const MODEL = process.env.GBRAIN_EMBEDDING_MODEL || 'text-embedding-3-large';
const DIMENSIONS = parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS || '1536', 10);
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

// Support custom base URL for Ollama and other OpenAI-compatible endpoints
const BASE_URL = process.env.GBRAIN_EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL;
// Use explicit env var if set (including empty string), otherwise fall back to standard OpenAI env vars
const API_KEY = process.env.GBRAIN_EMBEDDING_API_KEY !== undefined
  ? process.env.GBRAIN_EMBEDDING_API_KEY
  : (process.env.OPENAI_API_KEY || 'not-needed');


let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: BASE_URL,
      apiKey: API_KEY,
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
