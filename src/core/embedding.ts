/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * OpenAI text-embedding-3-large at 1536 dimensions.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';

const MODEL = 'text-embedding-3-large';
const DIMENSIONS = 1536;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
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

// ── Coalescing queue ──────────────────────────────────────────────────────────
// Groups concurrent embed() calls within EMBEDDING_BATCH_WINDOW_MS into one
// OpenAI API call. Default 2 000 ms. Set EMBEDDING_BATCH_WINDOW_MS=0 to disable.
// Flush also triggers early when the queue hits BATCH_SIZE (100) to keep
// request sizes bounded.
const BATCH_WINDOW_MS = parseInt(process.env.EMBEDDING_BATCH_WINDOW_MS ?? '2000', 10);

type QueueItem = {
  text: string;
  resolve: (v: Float32Array) => void;
  reject: (e: unknown) => void;
};
const coalesceQueue: QueueItem[] = [];
let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

async function flushCoalesceQueue(): Promise<void> {
  coalesceTimer = null;
  const items = coalesceQueue.splice(0);
  if (items.length === 0) return;
  try {
    const embeddings = await embedBatch(items.map(i => i.text));
    items.forEach((item, idx) => item.resolve(embeddings[idx]));
  } catch (e) {
    items.forEach(item => item.reject(e));
  }
}

// Drop-in replacement for embed() that coalesces concurrent callers.
// N concurrent page writes within the window → 1 OpenAI API call instead of N.
export function embedQueued(text: string): Promise<Float32Array> {
  if (BATCH_WINDOW_MS === 0) return embed(text);
  return new Promise((resolve, reject) => {
    coalesceQueue.push({ text: text.slice(0, MAX_CHARS), resolve, reject });
    if (!coalesceTimer) {
      coalesceTimer = setTimeout(() => { void flushCoalesceQueue(); }, BATCH_WINDOW_MS);
    }
    if (coalesceQueue.length >= BATCH_SIZE) {
      clearTimeout(coalesceTimer);
      void flushCoalesceQueue();
    }
  });
}

export { MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS };
