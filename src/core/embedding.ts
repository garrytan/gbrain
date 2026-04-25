/**
 * Embedding Service
 * Uses raw fetch to avoid OpenAI SDK v4.104.0 truncating embeddings to 256 dims.
 * Supports local bge-m3 (via embed-server.py) and any OpenAI-compatible API.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 */

const MODEL = process.env.EMBEDDING_MODEL || 'bge-m3';
const DIMENSIONS = parseInt(process.env.EMBEDDING_DIMENSIONS || '1024', 10);
const BASE_URL = process.env.EMBEDDING_BASE_URL || 'http://localhost:9999/v1';
const MAX_CHARS = parseInt(process.env.EMBEDDING_MAX_CHARS || '8000', 10);
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

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
      const url = `${BASE_URL}/embeddings`;
      const body = JSON.stringify({ model: MODEL, input: texts });

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Embedding API ${res.status}: ${text}`);
      }

      const json = await res.json() as {
        data: Array<{ index: number; embedding: number[] }>;
      };

      const sorted = json.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (e: unknown) {
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
