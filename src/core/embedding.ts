/**
 * Embedding Service
 *
 * Supports OpenAI and Gemini embeddings behind one interface.
 * Defaults remain OpenAI-compatible, but Gemini can be selected with
 * GBRAIN_EMBEDDING_PROVIDER=gemini or by configuring GEMINI_API_KEY/GOOGLE_API_KEY.
 */

import OpenAI from 'openai';
import { loadConfig } from './config.ts';

export type EmbeddingProvider = 'openai' | 'gemini';

const OPENAI_MODEL = 'text-embedding-3-large';
const GEMINI_MODEL = 'gemini-embedding-001';
const DIMENSIONS = 1536;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let openaiClient: OpenAI | null = null;
let openaiClientKey: string | null = null;

interface EmbeddingSettings {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  apiKey: string;
}

function getEmbeddingSettings(): EmbeddingSettings {
  const config = loadConfig();
  const openaiKey = process.env.OPENAI_API_KEY || config?.openai_api_key;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || config?.gemini_api_key;
  const explicitProvider = (process.env.GBRAIN_EMBEDDING_PROVIDER || config?.embedding_provider) as EmbeddingProvider | undefined;
  const explicitModel = process.env.GBRAIN_EMBEDDING_MODEL || config?.embedding_model;

  const provider: EmbeddingProvider | null = explicitProvider
    || (geminiKey && !openaiKey ? 'gemini' : null)
    || (openaiKey ? 'openai' : null)
    || (geminiKey ? 'gemini' : null);

  if (!provider) {
    throw new Error('No embedding provider configured. Set OPENAI_API_KEY or GEMINI_API_KEY/GOOGLE_API_KEY.');
  }

  if (provider === 'gemini') {
    if (!geminiKey) {
      throw new Error('GBRAIN_EMBEDDING_PROVIDER=gemini but GEMINI_API_KEY/GOOGLE_API_KEY is missing.');
    }
    return {
      provider,
      model: explicitModel || GEMINI_MODEL,
      dimensions: DIMENSIONS,
      apiKey: geminiKey,
    };
  }

  if (!openaiKey) {
    throw new Error('GBRAIN_EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is missing.');
  }

  return {
    provider,
    model: explicitModel || OPENAI_MODEL,
    dimensions: DIMENSIONS,
    apiKey: openaiKey,
  };
}

function getOpenAIClient(apiKey: string): OpenAI {
  if (!openaiClient || openaiClientKey !== apiKey) {
    openaiClient = new OpenAI({ apiKey });
    openaiClientKey = apiKey;
  }
  return openaiClient;
}

export function hasEmbeddingProvider(): boolean {
  try {
    getEmbeddingSettings();
    return true;
  } catch {
    return false;
  }
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  try {
    return getEmbeddingSettings().provider;
  } catch {
    return null;
  }
}

export function getEmbeddingModel(): string {
  return getEmbeddingSettings().model;
}

export function getEmbeddingDimensions(): number {
  return getEmbeddingSettings().dimensions;
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
  const settings = getEmbeddingSettings();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (settings.provider === 'gemini') {
        return await embedBatchGemini(texts, settings);
      }
      return await embedBatchOpenAI(texts, settings);
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;

      let delay = exponentialDelay(attempt);

      if (settings.provider === 'openai' && e instanceof OpenAI.APIError && e.status === 429) {
        const retryAfter = e.headers?.['retry-after'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) delay = parsed * 1000;
        }
      }

      if (settings.provider === 'gemini' && typeof e === 'object' && e && 'retryAfterMs' in e) {
        const retryAfterMs = (e as { retryAfterMs?: unknown }).retryAfterMs;
        if (typeof retryAfterMs === 'number') delay = retryAfterMs;
      }

      await sleep(delay);
    }
  }

  throw new Error('Embedding failed after all retries');
}

async function embedBatchOpenAI(texts: string[], settings: EmbeddingSettings): Promise<Float32Array[]> {
  const response = await getOpenAIClient(settings.apiKey).embeddings.create({
    model: settings.model,
    input: texts,
    dimensions: settings.dimensions,
  });

  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => new Float32Array(d.embedding));
}

async function embedBatchGemini(texts: string[], settings: EmbeddingSettings): Promise<Float32Array[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:batchEmbedContents?key=${encodeURIComponent(settings.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${settings.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: settings.dimensions,
        })),
      }),
    },
  );

  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const payload = await safeJson(response);
    const message = extractGeminiErrorMessage(payload) || `${response.status} ${response.statusText}`;
    const error = new Error(`Gemini embeddings failed: ${message}`) as Error & { retryAfterMs?: number };
    if (response.status === 429 && retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed)) error.retryAfterMs = parsed * 1000;
    }
    throw error;
  }

  const payload = await response.json() as { embeddings?: Array<{ values?: number[] }> };
  const embeddings = payload.embeddings || [];
  if (embeddings.length !== texts.length) {
    throw new Error(`Gemini embeddings returned ${embeddings.length} vectors for ${texts.length} texts`);
  }

  return embeddings.map((item, index) => {
    const values = item.values;
    if (!values || values.length !== settings.dimensions) {
      throw new Error(`Gemini embedding ${index} had ${values?.length ?? 0} dimensions, expected ${settings.dimensions}`);
    }
    return normalizeVector(values);
  });
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractGeminiErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const maybeError = (payload as { error?: { message?: string } }).error;
  return maybeError?.message || null;
}

function normalizeVector(values: number[]): Float32Array {
  let sumSquares = 0;
  for (const value of values) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares) || 1;
  return new Float32Array(values.map(value => value / norm));
}

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { DIMENSIONS as EMBEDDING_DIMENSIONS };
