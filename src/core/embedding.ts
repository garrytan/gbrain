/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Default: OpenAI text-embedding-3-large at 1536 dimensions.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';

const MODEL = process.env.GBRAIN_EMBEDDING_MODEL || 'text-embedding-3-large';
const DIMENSIONS = Number.parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS || '1536', 10);
const DISABLE_DIMENSIONS =
  process.env.GBRAIN_EMBEDDING_DISABLE_DIMENSIONS === '1'
  || process.env.GBRAIN_EMBEDDING_DISABLE_DIMENSIONS === 'true';
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = process.env.GBRAIN_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    const baseURL =
      process.env.GBRAIN_OPENAI_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      process.env.OPENAI_API_BASE;

    const opts: Record<string, unknown> = {};
    if (apiKey) opts.apiKey = apiKey;
    if (baseURL) opts.baseURL = baseURL;

    client = new OpenAI(opts);
  }
  return client;
}

function getDimensions(): number {
  if (!Number.isFinite(DIMENSIONS) || DIMENSIONS <= 0) {
    throw new Error(`Invalid GBRAIN_EMBEDDING_DIMENSIONS: ${process.env.GBRAIN_EMBEDDING_DIMENSIONS}`);
  }
  return DIMENSIONS;
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
      const req: Record<string, unknown> = {
        model: MODEL,
        input: texts,
      };
      if (!DISABLE_DIMENSIONS) req.dimensions = getDimensions();

      const response = await getClient().embeddings.create(req as any);

      // Sort by index to maintain order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      const expected = getDimensions();
      return sorted.map(d => {
        const emb = new Float32Array(d.embedding);
        if (emb.length !== expected) {
          throw new Error(`Embedding dimension mismatch (expected ${expected}, got ${emb.length})`);
        }
        return emb;
      });
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
