/**
 * Embedding Service
 *
 * SiliconFlow Qwen/Qwen3-Embedding-8B at 1024 dimensions.
 * Standard OpenAI-compatible API (input/data format).
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

const MODEL = 'Qwen/Qwen3-Embedding-8B';
const DIMENSIONS = 1024;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 32; // SiliconFlow limit

const EMBEDDING_URL = 'https://api.siliconflow.com/v1/embeddings';

function getApiKey(): string {
  return process.env.OPENAI_API_KEY ?? '';
}

export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated]);
  return result[0];
}

export interface EmbedBatchOptions {
  onBatchComplete?: (done: number, total: number) => void;
}

export async function embedBatch(
  texts: string[],
  options: EmbedBatchOptions = {},
): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

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
    const res = await fetch(EMBEDDING_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        input: texts,
        dimensions: DIMENSIONS,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (attempt < MAX_RETRIES - 1) {
        await sleep(exponentialDelay(attempt));
        continue;
      }
      throw new Error(`SiliconFlow embedding failed: ${res.status} ${body}`);
    }

    const json = await res.json() as {
      data?: Array<{ embedding: number[]; index: number }>;
    };

    if (!json.data || !Array.isArray(json.data)) {
      throw new Error(`Unexpected SiliconFlow response: ${JSON.stringify(json).slice(0, 200)}`);
    }

    // Sort by index to maintain order
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map(d => new Float32Array(d.embedding));
  }

  throw new Error('Embedding failed after all retries');
}

function exponentialDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS };
export const EMBEDDING_COST_PER_1K_TOKENS = 0.000; // Qwen3-Embedding-8B: free tier

export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
