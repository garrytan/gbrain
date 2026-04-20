/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Supports OpenAI and MiniMax embedding providers.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import { loadConfig, type EmbeddingProvider } from './config.ts';

const OPENAI_MODEL = 'text-embedding-3-large';
const MINIMAX_MODEL = 'embo-01';
const EMBEDDING_DIMENSIONS = 1536;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;
const MINIMAX_BASE_URL = 'https://api.minimax.chat/v1';

let openaiClient: OpenAI | null = null;
let openaiClientApiKey: string | undefined;

interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  apiKey?: string;
  groupId?: string;
  baseUrl?: string;
}

interface MiniMaxEmbeddingResponse {
  vectors?: number[][];
  total_tokens?: number;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

function getEmbeddingConfig(): EmbeddingConfig {
  const config = loadConfig();
  const provider = config?.embedding_provider || 'openai';

  if (provider === 'minimax') {
    return {
      provider,
      model: config?.embedding_model || MINIMAX_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      apiKey: config?.minimax_api_key,
      groupId: config?.minimax_group_id,
      baseUrl: config?.minimax_base_url || MINIMAX_BASE_URL,
    };
  }

  return {
    provider: 'openai',
    model: config?.embedding_model || OPENAI_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    apiKey: config?.openai_api_key,
  };
}

function getOpenAIClient(apiKey?: string): OpenAI {
  if (!openaiClient || openaiClientApiKey !== apiKey) {
    openaiClient = new OpenAI(apiKey ? { apiKey } : undefined);
    openaiClientApiKey = apiKey;
  }
  return openaiClient;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  return getEmbeddingConfig().provider;
}

export function getEmbeddingModel(): string {
  return getEmbeddingConfig().model;
}

export function getEmbeddingDimensions(): number {
  return getEmbeddingConfig().dimensions;
}

export function hasEmbeddingProviderCredentials(): boolean {
  const config = getEmbeddingConfig();
  if (config.provider === 'minimax') {
    return Boolean(config.apiKey && config.groupId);
  }
  return Boolean(config.apiKey);
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
  const config = getEmbeddingConfig();

  if (!config.apiKey) {
    throw new Error(`Missing API key for embedding provider: ${config.provider}`);
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (config.provider === 'minimax') {
        return await createMiniMaxEmbeddings(texts, config);
      }
      return await createOpenAIEmbeddings(texts, config);
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;

      let delay = exponentialDelay(attempt);

      if (config.provider === 'openai' && e instanceof OpenAI.APIError && e.status === 429) {
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

async function createOpenAIEmbeddings(texts: string[], config: EmbeddingConfig): Promise<Float32Array[]> {
  const response = await getOpenAIClient(config.apiKey).embeddings.create({
    model: config.model,
    input: texts,
    dimensions: config.dimensions,
  });

  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
}

async function createMiniMaxEmbeddings(texts: string[], config: EmbeddingConfig): Promise<Float32Array[]> {
  if (!config.groupId) {
    throw new Error('MiniMax embeddings require MINIMAX_GROUP_ID to be set');
  }

  const url = new URL(`${config.baseUrl}/embeddings`);
  url.searchParams.set('GroupId', config.groupId);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      texts,
      type: 'db',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`MiniMax embeddings request failed (${response.status}): ${body}`);
  }

  const data = await response.json() as MiniMaxEmbeddingResponse;
  const statusCode = data.base_resp?.status_code;
  if (statusCode && statusCode !== 0) {
    throw new Error(data.base_resp?.status_msg || `MiniMax embeddings request failed with status_code ${statusCode}`);
  }

  if (!Array.isArray(data.vectors) || data.vectors.length !== texts.length) {
    throw new Error('MiniMax embeddings response did not contain the expected vectors array');
  }

  return data.vectors.map((vector) => {
    if (!Array.isArray(vector) || vector.length !== config.dimensions) {
      throw new Error(`MiniMax embedding dimension mismatch: expected ${config.dimensions}, got ${Array.isArray(vector) ? vector.length : 'invalid'}`);
    }
    return new Float32Array(vector);
  });
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { EMBEDDING_DIMENSIONS };
