/**
 * Embedding Service
 *
 * Supports two backends:
 * - OpenAI text-embedding-3-large (1536 dimensions) via OpenAI API
 * - Ollama with bge-m3 (1024 dimensions) for local inference
 *
 * Set OLLAMA_URL to enable Ollama backend.
 * e.g. OLLAMA_URL=http://localhost:11434
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';

// Config
const OLLAMA_URL = process.env['OLLAMA_URL'] ?? '';
const USE_OLLAMA = Boolean(OLLAMA_URL);
const OPENAI_MODEL = 'text-embedding-3-large';
const OLLAMA_MODEL = 'bge-m3';
const DIMENSIONS = 1024; // bge-m3 uses 1024 dims; OpenAI uses 1536
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let openAIClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openAIClient) {
    openAIClient = new OpenAI();
  }
  return openAIClient;
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
    const batchResults = USE_OLLAMA
      ? await embedBatchOllama(batch)
      : await embedBatchOpenAI(batch);
    results.push(...batchResults);
  }

  return results;
}

async function embedBatchOpenAI(texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getOpenAIClient().embeddings.create({
        model: OPENAI_MODEL,
        input: texts,
        dimensions: 1536,
      });

      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;
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
  throw new Error('OpenAI embedding failed after all retries');
}

async function embedBatchOllama(texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OLLAMA_MODEL, input: texts }),
      });

      if (!response.ok) {
        throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { embeddings: number[][] };
      return data.embeddings.map(embedding => new Float32Array(embedding));
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;
      await sleep(exponentialDelay(attempt));
    }
  }
  throw new Error('Ollama embedding failed after all retries');
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { OPENAI_MODEL as EMBEDDING_MODEL, DIMENSIONS as EMBEDDING_DIMENSIONS, USE_OLLAMA };
