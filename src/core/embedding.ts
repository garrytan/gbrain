/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Default: OpenAI text-embedding-3-large at 1536 dimensions.
 *
 * Overrides via environment:
 *   EMBEDDING_BASE_URL    — custom OpenAI-compatible embeddings endpoint
 *                           (e.g. http://localhost:1234/v1 for LM Studio,
 *                            http://localhost:11434/v1 for Ollama)
 *   EMBEDDING_API_KEY     — API key (defaults to OPENAI_API_KEY or 'local')
 *   EMBEDDING_MODEL       — model name (default: text-embedding-3-large)
 *   EMBEDDING_DIMENSIONS  — embedding vector dimension (default: 1536)
 *   EMBEDDING_SEND_DIMENSIONS — set to '1' only if provider accepts the
 *                                OpenAI-style `dimensions` request parameter
 *                                (text-embedding-3-*). Local providers
 *                                typically reject it. Default: auto — send
 *                                dimensions only when MODEL starts with
 *                                "text-embedding-3".
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';

const MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-large';
const DIMENSIONS = Number.parseInt(
  process.env.EMBEDDING_DIMENSIONS || '1536',
  10,
);
const SEND_DIMENSIONS = (() => {
  const override = process.env.EMBEDDING_SEND_DIMENSIONS;
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;
  // Auto: only OpenAI text-embedding-3-* models support the dimensions param
  return MODEL.startsWith('text-embedding-3');
})();

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const baseURL = process.env.EMBEDDING_BASE_URL;
    const apiKey =
      process.env.EMBEDDING_API_KEY ||
      process.env.OPENAI_API_KEY ||
      (baseURL ? 'local' : undefined);
    client = new OpenAI({
      ...(baseURL ? { baseURL } : {}),
      ...(apiKey ? { apiKey } : {}),
    });
  }
  return client;
}

export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated]);
  return result[0];
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const request: Parameters<
        ReturnType<typeof getClient>['embeddings']['create']
      >[0] = {
        model: MODEL,
        input: texts,
        // Force float encoding. The SDK defaults to base64 which LM Studio
        // decodes incorrectly (returns 192 floats for a 768-dim vector).
        // 'float' is the spec-compliant format all providers must accept.
        encoding_format: 'float',
        ...(SEND_DIMENSIONS ? { dimensions: DIMENSIONS } : {}),
      };
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

export { MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS };
