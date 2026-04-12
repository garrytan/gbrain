/**
 * Embedding Service — Multi-Provider
 *
 * Supports: OpenAI, Gemini, Ollama, and any OpenAI-compatible endpoint.
 * Provider is selected via GBRAIN_EMBEDDING_PROVIDER env var or config file.
 * Default: "openai" (backward compatible).
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import { loadConfig } from './config.ts';

// ── Provider registry ──────────────────────────────────────────────

export type EmbeddingProvider = 'openai' | 'gemini' | 'ollama' | 'custom';

interface ProviderConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  apiKey?: string;
  baseUrl?: string;
}

const PROVIDER_DEFAULTS: Record<EmbeddingProvider, { model: string; dimensions: number }> = {
  openai:  { model: 'text-embedding-3-large', dimensions: 1536 },
  gemini:  { model: 'gemini-embedding-001',    dimensions: 1536 },
  ollama:  { model: 'nomic-embed-text',       dimensions: 768  },
  custom:  { model: 'text-embedding-3-large', dimensions: 1536 },
};

// ── Configuration resolution ───────────────────────────────────────

function resolveProvider(): ProviderConfig {
  const config = loadConfig() as Record<string, unknown> | null;

  const provider = (
    process.env.GBRAIN_EMBEDDING_PROVIDER
    || (config as any)?.embedding_provider
    || 'openai'
  ) as EmbeddingProvider;

  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai;

  const model = process.env.GBRAIN_EMBEDDING_MODEL
    || (config as any)?.embedding_model
    || defaults.model;

  const dimensions = parseInt(
    process.env.GBRAIN_EMBEDDING_DIMENSIONS
    || (config as any)?.embedding_dimensions
    || String(defaults.dimensions),
    10
  );

  let apiKey: string | undefined;
  let baseUrl: string | undefined;

  switch (provider) {
    case 'openai':
      apiKey = process.env.OPENAI_API_KEY || (config as any)?.openai_api_key;
      baseUrl = process.env.OPENAI_BASE_URL;
      break;
    case 'gemini':
      apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || (config as any)?.gemini_api_key;
      baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';
      break;
    case 'ollama':
      baseUrl = process.env.OLLAMA_BASE_URL || (config as any)?.ollama_base_url || 'http://localhost:11434/v1';
      apiKey = 'ollama'; // Ollama doesn't need a real key but OpenAI SDK requires one
      break;
    case 'custom':
      apiKey = process.env.GBRAIN_EMBEDDING_API_KEY || (config as any)?.embedding_api_key;
      baseUrl = process.env.GBRAIN_EMBEDDING_BASE_URL || (config as any)?.embedding_base_url;
      break;
  }

  return { provider, model, dimensions, apiKey, baseUrl };
}

// ── Client management ──────────────────────────────────────────────

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let cachedClient: OpenAI | null = null;
let cachedConfig: ProviderConfig | null = null;

function getClient(): { client: OpenAI; config: ProviderConfig } {
  const config = resolveProvider();

  // Recreate client if provider config changed
  if (!cachedClient || JSON.stringify(cachedConfig) !== JSON.stringify(config)) {
    const clientOpts: Record<string, unknown> = {};
    if (config.apiKey) clientOpts.apiKey = config.apiKey;
    if (config.baseUrl) clientOpts.baseURL = config.baseUrl;

    // Gemini and Ollama don't need org/project
    if (config.provider === 'gemini' || config.provider === 'ollama') {
      clientOpts.organization = null;
      clientOpts.project = null;
    }

    cachedClient = new OpenAI(clientOpts as any);
    cachedConfig = config;
  }

  return { client: cachedClient, config };
}

// ── Public API (unchanged signatures) ──────────────────────────────

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
  const { client, config } = getClient();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Gemini's OpenAI-compat endpoint supports `dimensions` for
      // gemini-embedding-001 to truncate output dimensions.
      const createParams: Record<string, unknown> = {
        model: config.model,
        input: texts,
        dimensions: config.dimensions,
      };

      const response = await client.embeddings.create(createParams as any);

      const sorted = response.data.sort((a: any, b: any) => a.index - b.index);
      return sorted.map((d: any) => new Float32Array(d.embedding));
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

// ── Utilities ──────────────────────────────────────────────────────

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Exported constants (dynamic based on config) ───────────────────

// For backward compatibility, export resolved values
const _resolved = resolveProvider();
export const EMBEDDING_MODEL = _resolved.model;
export const EMBEDDING_DIMENSIONS = _resolved.dimensions;
