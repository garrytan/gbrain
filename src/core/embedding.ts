/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * OpenAI text-embedding-3-large at 1536 dimensions.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import type { BrainEngine } from './engine.ts';
import { resolveOpenAICredentials } from './openai-credentials.ts';
import { resolveEmbeddingSettings } from './embedding-config.ts';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let openAIClient: OpenAI | null = null;
let openAIClientCacheKey = '';

async function getOpenAIClient(engine?: BrainEngine): Promise<{ client: OpenAI; model: string; dimensions: number }> {
  const settings = await resolveEmbeddingSettings(engine);
  const creds = resolveOpenAICredentials();
  if (!creds) {
    throw new Error('No OpenAI-compatible credentials found. Set OPENAI_API_KEY or authenticate Hermes/Codex first.');
  }

  const cacheKey = `${creds.baseURL || ''}|${creds.apiKey}`;
  if (!openAIClient || openAIClientCacheKey !== cacheKey) {
    openAIClient = new OpenAI({
      apiKey: creds.apiKey,
      ...(creds.baseURL ? { baseURL: creds.baseURL } : {}),
    });
    openAIClientCacheKey = cacheKey;
  }

  return { client: openAIClient, model: settings.model, dimensions: settings.dimensions };
}

export async function embed(text: string, engine?: BrainEngine): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated], engine);
  return result[0];
}

export async function embedBatch(texts: string[], engine?: BrainEngine): Promise<Float32Array[]> {
  const settings = await resolveEmbeddingSettings(engine);
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = settings.provider === 'ollama'
      ? await embedBatchWithOllama(batch, settings)
      : await embedBatchWithOpenAI(batch, engine);
    results.push(...batchResults);
  }

  return results;
}

async function embedBatchWithOpenAI(texts: string[], engine?: BrainEngine): Promise<Float32Array[]> {
  const { client, model, dimensions } = await getOpenAIClient(engine);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await client.embeddings.create({
        model,
        input: texts,
        dimensions,
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

  throw new Error('Embedding failed after all retries');
}

async function embedBatchWithOllama(
  texts: string[],
  settings: Awaited<ReturnType<typeof resolveEmbeddingSettings>>,
): Promise<Float32Array[]> {
  const response = await fetch(`${settings.baseURL || 'http://127.0.0.1:11434'}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      input: texts,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama embeddings failed (${response.status}): ${body.slice(0, 400)}`);
  }

  const payload = await response.json() as { embeddings?: number[][]; embedding?: number[]; error?: string };
  const rawEmbeddings = Array.isArray(payload.embeddings)
    ? payload.embeddings
    : Array.isArray(payload.embedding)
      ? [payload.embedding]
      : null;

  if (!rawEmbeddings) {
    throw new Error(`Ollama embeddings response missing embeddings array${payload.error ? `: ${payload.error}` : ''}`);
  }

  return rawEmbeddings.map((embedding, index) => {
    if (embedding.length !== settings.dimensions) {
      throw new Error(`Ollama embedding dimension mismatch for item ${index}: expected ${settings.dimensions}, got ${embedding.length}`);
    }
    return new Float32Array(embedding);
  });
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { DEFAULT_OPENAI_MODEL as EMBEDDING_MODEL, DEFAULT_OPENAI_DIMENSIONS as EMBEDDING_DIMENSIONS } from './embedding-config.ts';
