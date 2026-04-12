/**
 * Embedding Service — Multi-Provider (v2)
 *
 * Supports:
 *   International: OpenAI, Gemini, Ollama
 *   China: DashScope (Qwen), DeepSeek, Zhipu (GLM)
 *   Generic: any OpenAI-compatible endpoint
 *
 * All providers use OpenAI SDK with different baseURL + apiKey.
 * Provider is selected via GBRAIN_EMBEDDING_PROVIDER env var or config file.
 * Default: "openai" (backward compatible).
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import { loadConfig } from './config.ts';

// ── Provider registry ──────────────────────────────────────────────

export type EmbeddingProvider =
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'dashscope'   // Alibaba Qwen
  | 'deepseek'
  | 'zhipu'       // GLM / ChatGLM
  | 'custom';

interface ProviderConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  apiKey?: string;
  baseUrl?: string;
  /** Whether to send `dimensions` param in API request */
  sendDimensions: boolean;
}

const PROVIDER_DEFAULTS: Record<EmbeddingProvider, {
  model: string;
  dimensions: number;
  baseUrl?: string;
  sendDimensions: boolean;
}> = {
  openai:    { model: 'text-embedding-3-large', dimensions: 1536, sendDimensions: true },
  gemini:    { model: 'gemini-embedding-001',   dimensions: 768,  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', sendDimensions: true },
  ollama:    { model: 'nomic-embed-text',       dimensions: 768,  baseUrl: 'http://localhost:11434/v1', sendDimensions: false },
  dashscope: { model: 'text-embedding-v3',      dimensions: 1024, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sendDimensions: true },
  deepseek:  { model: 'deepseek-embedding-v2',  dimensions: 768,  baseUrl: 'https://api.deepseek.com/v1', sendDimensions: false },
  zhipu:     { model: 'embedding-3',            dimensions: 2048, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', sendDimensions: false },
  custom:    { model: 'text-embedding-3-large', dimensions: 1536, sendDimensions: true },
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

  const sendDimensions = defaults.sendDimensions;

  let apiKey: string | undefined;
  let baseUrl: string | undefined;

  switch (provider) {
    case 'openai':
      apiKey = process.env.OPENAI_API_KEY || (config as any)?.openai_api_key;
      baseUrl = process.env.OPENAI_BASE_URL;
      break;
    case 'gemini':
      apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || (config as any)?.gemini_api_key;
      baseUrl = defaults.baseUrl;
      break;
    case 'ollama':
      baseUrl = process.env.OLLAMA_BASE_URL || (config as any)?.ollama_base_url || defaults.baseUrl;
      apiKey = 'ollama'; // Ollama doesn't need a real key but OpenAI SDK requires one
      break;
    case 'dashscope':
      apiKey = process.env.DASHSCOPE_API_KEY || (config as any)?.dashscope_api_key;
      baseUrl = process.env.DASHSCOPE_BASE_URL || (config as any)?.dashscope_base_url || defaults.baseUrl;
      break;
    case 'deepseek':
      apiKey = process.env.DEEPSEEK_API_KEY || (config as any)?.deepseek_api_key;
      baseUrl = process.env.DEEPSEEK_BASE_URL || (config as any)?.deepseek_base_url || defaults.baseUrl;
      break;
    case 'zhipu':
      apiKey = process.env.ZHIPU_API_KEY || (config as any)?.zhipu_api_key;
      baseUrl = process.env.ZHIPU_BASE_URL || (config as any)?.zhipu_base_url || defaults.baseUrl;
      break;
    case 'custom':
      apiKey = process.env.GBRAIN_EMBEDDING_API_KEY || (config as any)?.embedding_api_key;
      baseUrl = process.env.GBRAIN_EMBEDDING_BASE_URL || (config as any)?.embedding_base_url;
      break;
  }

  return { provider, model, dimensions, apiKey, baseUrl, sendDimensions };
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

    // Non-OpenAI providers don't need org/project
    if (config.provider !== 'openai') {
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
      const createParams: Record<string, unknown> = {
        model: config.model,
        input: texts,
      };

      // Only send dimensions if the provider supports it
      if (config.sendDimensions && config.dimensions) {
        createParams.dimensions = config.dimensions;
      }

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

const _resolved = resolveProvider();
export const EMBEDDING_MODEL = _resolved.model;
export const EMBEDDING_DIMENSIONS = _resolved.dimensions;
