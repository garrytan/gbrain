/**
 * Embedding Service
 *
 * Default: OpenAI text-embedding-3-large.
 * Local/OpenAI-compatible override: configure embedding_base_url + embedding_model
 * in ~/.gbrain/config.json (or env vars) and this module will route requests there.
 */

import OpenAI from 'openai';
import { loadConfig, type GBrainConfig } from './config.ts';

const DEFAULT_MODEL = 'text-embedding-3-large';
const DEFAULT_DIMENSIONS = 1536;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;
const LOCAL_API_KEY_FALLBACK = 'local-embedding';

export interface ResolvedEmbeddingConfig {
  baseUrl?: string;
  apiKey: string;
  model: string;
  dimensions: number;
  isCustomBaseUrl: boolean;
}

let client: OpenAI | null = null;
let clientCacheKey: string | null = null;

function parseDimensions(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DIMENSIONS;
}

export function resolveEmbeddingConfig(config: GBrainConfig | null = loadConfig()): ResolvedEmbeddingConfig {
  const baseUrl = config?.embedding_base_url?.trim() || undefined;
  const model = config?.embedding_model?.trim() || DEFAULT_MODEL;
  const dimensions = parseDimensions(config?.embedding_dimensions);
  const isCustomBaseUrl = Boolean(baseUrl);
  const apiKey =
    config?.embedding_api_key?.trim()
    || config?.openai_api_key?.trim()
    || (isCustomBaseUrl ? LOCAL_API_KEY_FALLBACK : '');

  return {
    baseUrl,
    apiKey,
    model,
    dimensions,
    isCustomBaseUrl,
  };
}

function getClient(config: ResolvedEmbeddingConfig): OpenAI {
  const cacheKey = JSON.stringify({
    baseUrl: config.baseUrl || '',
    apiKey: config.apiKey,
  });

  if (!client || clientCacheKey !== cacheKey) {
    client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    clientCacheKey = cacheKey;
  }

  return client;
}

export function buildEmbeddingRequest(texts: string[], config: ResolvedEmbeddingConfig): {
  model: string;
  input: string[];
  dimensions?: number;
} {
  const request: {
    model: string;
    input: string[];
    dimensions?: number;
  } = {
    model: config.model,
    input: texts,
  };

  // Custom OpenAI-compatible local servers usually expose a fixed embedding width.
  // Do not force the OpenAI-only `dimensions` parameter there unless we later add
  // explicit capability negotiation.
  if (!config.isCustomBaseUrl) {
    request.dimensions = config.dimensions;
  }

  return request;
}

export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, MAX_CHARS);
  const result = await embedBatch([truncated]);
  return result[0];
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const truncated = texts.map(t => t.slice(0, MAX_CHARS));
  const results: Float32Array[] = [];

  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  const config = resolveEmbeddingConfig();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await getClient(config).embeddings.create(
        buildEmbeddingRequest(texts, config),
      );

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

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { DEFAULT_MODEL as EMBEDDING_MODEL, DEFAULT_DIMENSIONS as EMBEDDING_DIMENSIONS };
