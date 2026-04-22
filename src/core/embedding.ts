/**
 * Embedding Service
 * Supports multiple backends:
 *   - openai:  OpenAI text-embedding-3-large (paid, 1536 dims)
 *   - ollama:  Ollama local models via OpenAI-compatible API (free)
 *
 * Provider auto-detection: GBRAIN_EMBEDDING_PROVIDER env var
 *   Set to "openai"  to use OpenAI
 *   Set to "ollama"  to use Ollama OpenAI-compatible endpoint /v1/embeddings
 *   Set to "local"   to use Ollama native API (/api/embeddings with 'prompt' field)
 *   Default: Ollama if no API key
 *
 * Ollama configuration:
 *   GBRAIN_OLLAMA_URL       - Ollama base URL (default: http://localhost:11434)
 *   GBRAIN_EMBEDDING_MODEL - model name (default: nomic-embed-text)
 *   GBRAIN_EMBEDDING_DIMS  - embedding dimensions (default: 768 for nomic-embed-text)
 */

import OpenAI from 'openai';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

// OpenAI defaults
const OPENAI_MODEL = 'text-embedding-3-large';
const OPENAI_DIMENSIONS = 1536;

// Ollama / local defaults (nomic-embed-text)
const OLLAMA_MODEL = 'nomic-embed-text';
const OLLAMA_DIMENSIONS = 768;

type EmbeddingProvider = 'openai' | 'ollama' | 'local';

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

function detectProvider(): EmbeddingProvider {
  const override = process.env.GBRAIN_EMBEDDING_PROVIDER;
  if (override === 'ollama') return 'ollama';
  if (override === 'local')  return 'local';
  if (override === 'openai') return 'openai';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'ollama';  // Default to Ollama (local/free)
}

function getOllamaConfig() {
  return {
    url: (process.env.GBRAIN_OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, ''),
    model: process.env.GBRAIN_EMBEDDING_MODEL || OLLAMA_MODEL,
    dimensions: parseInt(process.env.GBRAIN_EMBEDDING_DIMS || String(OLLAMA_DIMENSIONS), 10),
  };
}

function getLocalConfig() {
  return {
    url: (process.env.GBRAIN_EMBEDDING_URL || 'http://localhost:11434').replace(/\/$/, ''),
    model: process.env.GBRAIN_EMBEDDING_MODEL || OLLAMA_MODEL,
    dimensions: parseInt(process.env.GBRAIN_EMBEDDING_DIMS || String(OLLAMA_DIMENSIONS), 10),
  };
}

function getOpenAIConfig() {
  return {
    model: process.env.GBRAIN_EMBEDDING_MODEL || OPENAI_MODEL,
    dimensions: parseInt(process.env.GBRAIN_EMBEDDING_DIMS || String(OPENAI_DIMENSIONS), 10),
  };
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

  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
    options.onBatchComplete?.(results.length, truncated.length);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  const provider = detectProvider();
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (provider === 'ollama') return await embedBatchOllama(texts);
      if (provider === 'local')   return await embedBatchLocal(texts);
      return await embedBatchOpenAI(texts);
    } catch (e: unknown) {
      lastError = e;
      if (attempt === MAX_RETRIES - 1) break;

      let delay = BASE_DELAY_MS * Math.pow(2, attempt);

      if (e instanceof OpenAI.APIError && (e as any).status === 429) {
        const retryAfter = (e as any).headers?.['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) delay = parsed * 1000;
        }
      }

      await sleep(delay);
    }
  }

  throw lastError ?? new Error('Embedding failed after all retries');
}

async function embedBatchOpenAI(texts: string[]): Promise<Float32Array[]> {
  const cfg = getOpenAIConfig();
  const response = await getOpenAIClient().embeddings.create({
    model: cfg.model,
    input: texts,
    dimensions: cfg.dimensions,
  });

  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
}

async function embedBatchOllama(texts: string[]): Promise<Float32Array[]> {
  const cfg = getOllamaConfig();

  // Ollama OpenAI-compatible endpoint: /v1/embeddings
  // NOTE: Ollama v0.21+ has issues with batch input arrays returning empty embeddings.
  // If you get "expected N dimensions, got 0", switch to GBRAIN_EMBEDDING_PROVIDER=local
  const response = await fetch(`${cfg.url}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      input: texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama embedding error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as {
    data?: Array<{ embedding: number[]; index: number }>;
  };

  if (!data.data || data.data.length === 0) {
    throw new Error('Ollama returned empty embedding. Try GBRAIN_EMBEDDING_PROVIDER=local');
  }

  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
}

async function embedBatchLocal(texts: string[]): Promise<Float32Array[]> {
  const cfg = getLocalConfig();
  const isOllamaNative =
    cfg.url.includes('localhost:11434') ||
    cfg.url.includes('127.0.0.1:11434');

  if (isOllamaNative) {
    // Ollama native API uses 'prompt' field instead of OpenAI 'input' array.
    // Process one at a time to avoid empty embedding bugs on batch requests.
    const results: Float32Array[] = [];
    for (const text of texts) {
      const response = await fetch(`${cfg.url}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, prompt: text }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama native embedding error: ${response.status} - ${errorText}`);
      }
      const data = await response.json() as { embedding?: number[] };
      if (!data.embedding || data.embedding.length === 0) {
        throw new Error('Ollama returned empty embedding for prompt field');
      }
      results.push(new Float32Array(data.embedding));
    }
    return results;
  }

  // Standard local server (sentence-transformers) uses OpenAI-compatible format
  const response = await fetch(`${cfg.url}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, input: texts }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Local embedding server error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as {
    data?: Array<{ embedding: number[]; index: number }>;
  };

  if (!data.data || data.data.length === 0) {
    throw new Error('Local embedding server returned no data');
  }

  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getCurrentProvider(): EmbeddingProvider {
  return detectProvider();
}

// Backwards compat
export { OPENAI_MODEL as EMBEDDING_MODEL, OPENAI_DIMENSIONS as EMBEDDING_DIMENSIONS };
