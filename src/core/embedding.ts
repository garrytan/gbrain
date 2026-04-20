/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * Default: OpenAI text-embedding-3-large at 1536 dimensions.
 * Optional provider override: Voyage AI with configurable model/dimensions.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';

const DEFAULT_PROVIDER = 'openai';
const DEFAULT_MODEL = 'text-embedding-3-large';
const DEFAULT_DIMENSIONS = 1536;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let openAIClient: OpenAI | null = null;

export interface EmbeddingConfig {
  provider: 'openai' | 'voyage';
  model: string;
  dimensions?: number;
}

function getOpenAIClient(): OpenAI {
  if (!openAIClient) {
    openAIClient = new OpenAI();
  }
  return openAIClient;
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const providerRaw = (process.env.EMBEDDING_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  const model = process.env.EMBEDDING_MODEL || DEFAULT_MODEL;
  const dimensionsRaw = process.env.EMBEDDING_DIMENSIONS;
  const dimensions = dimensionsRaw ? parseInt(dimensionsRaw, 10) : DEFAULT_DIMENSIONS;

  if (providerRaw !== 'openai' && providerRaw !== 'voyage') {
    throw new Error(`Unsupported embedding provider: ${providerRaw}. Expected openai or voyage.`);
  }

  if (dimensionsRaw && Number.isNaN(dimensions)) {
    throw new Error(`Invalid EMBEDDING_DIMENSIONS: ${dimensionsRaw}`);
  }

  return {
    provider: providerRaw,
    model,
    dimensions,
  };
}

async function createVoyageEmbeddings(texts: string[], config: EmbeddingConfig): Promise<Float32Array[]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage');

  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: texts,
      ...(config.dimensions ? { output_dimension: config.dimensions } : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Voyage embedding request failed (${response.status}): ${body}`);
  }

  const json = await response.json() as { data: Array<{ index: number; embedding: number[] }> };
  const sorted = json.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
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

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (config.provider === 'voyage') {
        return await createVoyageEmbeddings(texts, config);
      }

      const response = await getOpenAIClient().embeddings.create({
        model: config.model,
        input: texts,
        ...(config.dimensions ? { dimensions: config.dimensions } : {}),
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

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const EMBEDDING_PROVIDER = DEFAULT_PROVIDER;
export const EMBEDDING_MODEL = DEFAULT_MODEL;
export const EMBEDDING_DIMENSIONS = DEFAULT_DIMENSIONS;
