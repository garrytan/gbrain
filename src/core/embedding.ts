/**
 * Embedding Service
 *
 * Supports both OpenAI and Ollama backends. Embeddings are normalized to the
 * configured storage dimension so the existing pgvector schema keeps working.
 */

import OpenAI from 'openai';
import type { BrainEngine } from './engine.ts';
import { loadConfig } from './config.ts';

type EmbeddingProvider = 'openai' | 'ollama';

interface EmbeddingRuntimeConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  ollamaBaseUrl: string;
  openaiApiKey?: string;
}

const DEFAULT_PROVIDER: EmbeddingProvider = 'openai';
const DEFAULT_MODEL = 'text-embedding-3-large';
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

const openaiClients = new Map<string, OpenAI>();

function getOpenAIClient(apiKey?: string): OpenAI {
  const resolvedApiKey = apiKey || process.env.OPENAI_API_KEY || loadConfig()?.openai_api_key;
  const cacheKey = resolvedApiKey || '__default__';
  const cached = openaiClients.get(cacheKey);
  if (cached) return cached;

  const client = resolvedApiKey
    ? new OpenAI({ apiKey: resolvedApiKey })
    : new OpenAI();
  openaiClients.set(cacheKey, client);
  return client;
}

async function getConfigValue(
  engine: BrainEngine | undefined,
  primaryKey: string,
  legacyKey?: string,
): Promise<string | null> {
  if (!engine) return null;
  const primary = await engine.getConfig(primaryKey);
  if (primary !== null) return primary;
  if (legacyKey) return engine.getConfig(legacyKey);
  return null;
}

function parseDimensions(raw: string | null | undefined, fallback: number): number {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProvider(raw: string | null | undefined): EmbeddingProvider {
  return raw?.toLowerCase() === 'ollama' ? 'ollama' : DEFAULT_PROVIDER;
}

function normalizeBaseUrl(raw: string | null | undefined): string {
  return (raw || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
}

export async function resolveEmbeddingConfig(engine?: BrainEngine): Promise<EmbeddingRuntimeConfig> {
  const provider = normalizeProvider(
    process.env.GBRAIN_EMBEDDING_PROVIDER
    || await getConfigValue(engine, 'embedding.provider', 'embedding_provider'),
  );

  const model = process.env.GBRAIN_EMBEDDING_MODEL
    || await getConfigValue(engine, 'embedding.model', 'embedding_model')
    || DEFAULT_MODEL;

  const dimensions = parseDimensions(
    process.env.GBRAIN_EMBEDDING_DIMENSIONS
      || await getConfigValue(engine, 'embedding.dimensions', 'embedding_dimensions'),
    DEFAULT_DIMENSIONS,
  );

  const ollamaBaseUrl = normalizeBaseUrl(
    process.env.GBRAIN_OLLAMA_BASE_URL
      || process.env.OLLAMA_HOST
      || await getConfigValue(engine, 'embedding.base_url', 'embedding_base_url'),
  );

  const openaiApiKey = process.env.OPENAI_API_KEY || loadConfig()?.openai_api_key;

  return {
    provider,
    model,
    dimensions,
    ollamaBaseUrl,
    openaiApiKey: openaiApiKey || undefined,
  };
}

export async function embed(text: string, engine?: BrainEngine): Promise<Float32Array> {
  const result = await embedBatch([text], { engine });
  return result[0];
}

export interface EmbedBatchOptions {
  /**
   * Engine for resolving provider config (Ollama/OpenAI/etc.).
   * Threading the engine through lets non-OpenAI providers read their
   * runtime config from the BrainEngine's config store instead of only
   * env vars (local patch, ADR-0003).
   */
  engine?: BrainEngine;
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
  const config = await resolveEmbeddingConfig(options.engine);
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch, config);
    results.push(...batchResults);
    options.onBatchComplete?.(results.length, truncated.length);
  }

  return results;
}

async function embedBatchWithRetry(
  texts: string[],
  config: EmbeddingRuntimeConfig,
): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (config.provider === 'ollama') {
        return await embedWithOllama(texts, config);
      }
      return await embedWithOpenAI(texts, config);
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;

      let delay = exponentialDelay(attempt);
      if (e instanceof OpenAI.APIError && e.status === 429) {
        const retryAfter = e.headers?.['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) delay = parsed * 1000;
        }
      }

      await sleep(delay);
    }
  }

  throw new Error('Embedding failed after all retries');
}

async function embedWithOpenAI(
  texts: string[],
  config: EmbeddingRuntimeConfig,
): Promise<Float32Array[]> {
  const response = await getOpenAIClient(config.openaiApiKey).embeddings.create({
    model: config.model,
    input: texts,
    dimensions: config.dimensions,
  });

  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => resizeEmbedding(d.embedding, config.dimensions));
}

async function embedWithOllama(
  texts: string[],
  config: EmbeddingRuntimeConfig,
): Promise<Float32Array[]> {
  const response = await fetch(`${config.ollamaBaseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      input: texts,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama embedding request failed (${response.status}): ${body || response.statusText}`);
  }

  const payload = await response.json() as { embeddings?: number[][] };
  if (!Array.isArray(payload.embeddings)) {
    throw new Error('Ollama embedding request returned no embeddings');
  }

  return payload.embeddings.map(values => resizeEmbedding(values, config.dimensions));
}

function resizeEmbedding(values: number[], targetDimensions: number): Float32Array {
  const resized = new Float32Array(targetDimensions);
  const limit = Math.min(values.length, targetDimensions);
  for (let i = 0; i < limit; i++) resized[i] = values[i];
  return resized;
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { DEFAULT_MODEL as EMBEDDING_MODEL, DEFAULT_DIMENSIONS as EMBEDDING_DIMENSIONS };
