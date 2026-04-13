/**
 * Embedding Service — provider selection, model metadata, and API adapters.
 *
 * This module is the single source of truth for active embedding metadata:
 * provider, model, effective dimensions, and whether dimensions were
 * explicitly overridden.
 */

import OpenAI from 'openai';
import { loadConfig, type GBrainConfig } from './config.ts';

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  /** Embed a single text string. */
  embed(text: string): Promise<Float32Array>;
  /** Embed a batch of text strings. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  /** Provider name. */
  readonly provider: EmbeddingProviderName;
  /** Model name (stored in DB for provenance). */
  readonly model: string;
  /** Vector dimensions (must match DB schema vector(N) column). */
  readonly dimensions: number;
  /** Resolved metadata for this provider instance. */
  readonly metadata: EmbeddingMetadata;
}

export type EmbeddingProviderName = 'openai' | 'ollama';

export interface EmbeddingMetadata {
  provider: EmbeddingProviderName;
  model: string;
  dimensions: number;
  dimensionsOverridden: boolean;
}

export type EmbeddingStorageType = 'vector' | 'halfvec';

export interface EmbeddingConfigInput {
  embedding_provider?: string;
  embedding_model?: string;
  embedding_dimensions?: number | string;
  ollama_base_url?: string;
  ollama_model?: string;
}

// ---------------------------------------------------------------------------
// Shared constants & utilities
// ---------------------------------------------------------------------------

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

export const DEFAULT_OPENAI_MODEL = 'text-embedding-3-large';
export const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';

const OPENAI_MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-large': 3072,
  'text-embedding-3-small': 1536,
  'text-embedding-ada-002': 1536,
};

const OLLAMA_MODEL_DIMENSIONS: Record<string, number> = {
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'snowflake-arctic-embed': 1024,
  'all-minilm': 384,
};

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDimensions(value: number | string | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getConfigWithEnv(config?: EmbeddingConfigInput): EmbeddingConfigInput | null {
  if (config) return config;
  const loaded = loadConfig();
  return loaded ? normalizeEmbeddingConfig(loaded) : null;
}

function normalizeEmbeddingConfig(config: EmbeddingConfigInput | GBrainConfig): EmbeddingConfigInput {
  return {
    embedding_provider: config.embedding_provider,
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    ollama_base_url: config.ollama_base_url,
    ollama_model: config.ollama_model,
  };
}

function resolveProviderName(config?: EmbeddingConfigInput): EmbeddingProviderName {
  const resolved = process.env.GBRAIN_EMBEDDING_PROVIDER
    || config?.embedding_provider
    || (process.env.OPENAI_API_KEY ? 'openai' : 'ollama');
  return resolved === 'ollama' ? 'ollama' : 'openai';
}

function defaultDimensionsFor(provider: EmbeddingProviderName, model: string): number {
  if (provider === 'ollama') {
    return OLLAMA_MODEL_DIMENSIONS[model] || 768;
  }
  return OPENAI_MODEL_DIMENSIONS[model] || OPENAI_MODEL_DIMENSIONS[DEFAULT_OPENAI_MODEL];
}

export function resolveEmbeddingMetadata(config?: EmbeddingConfigInput): EmbeddingMetadata {
  const resolvedConfig = getConfigWithEnv(config) || undefined;
  const provider = resolveProviderName(resolvedConfig);
  const model = process.env.GBRAIN_EMBEDDING_MODEL
    || resolvedConfig?.embedding_model
    || (provider === 'ollama'
      ? process.env.OLLAMA_EMBEDDING_MODEL || resolvedConfig?.ollama_model || DEFAULT_OLLAMA_MODEL
      : DEFAULT_OPENAI_MODEL);
  const explicitDimensions = parseDimensions(
    process.env.GBRAIN_EMBEDDING_DIMENSIONS || resolvedConfig?.embedding_dimensions,
  );

  return {
    provider,
    model,
    dimensions: explicitDimensions ?? defaultDimensionsFor(provider, model),
    dimensionsOverridden: explicitDimensions !== undefined,
  };
}

export function getEmbeddingStorageType(dimensions: number): EmbeddingStorageType {
  return dimensions > 2000 ? 'halfvec' : 'vector';
}

export function getEmbeddingColumnType(metadata: EmbeddingMetadata): string {
  return `${getEmbeddingStorageType(metadata.dimensions)}(${metadata.dimensions})`;
}

export function getEmbeddingIndexOps(metadata: EmbeddingMetadata): string {
  return `${getEmbeddingStorageType(metadata.dimensions)}_cosine_ops`;
}

// ---------------------------------------------------------------------------
// OpenAI provider (original, default)
// ---------------------------------------------------------------------------

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'openai' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly metadata: EmbeddingMetadata;
  private readonly explicitDimensions?: number;

  private client: OpenAI | null = null;

  constructor(opts?: { model?: string; dimensions?: number }) {
    const metadata = resolveEmbeddingMetadata({
      embedding_provider: 'openai',
      embedding_model: opts?.model,
      embedding_dimensions: opts?.dimensions,
    });
    this.model = metadata.model;
    this.dimensions = metadata.dimensions;
    this.metadata = metadata;
    this.explicitDimensions = metadata.dimensionsOverridden ? metadata.dimensions : undefined;
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI();
    }
    return this.client;
  }

  async embed(text: string): Promise<Float32Array> {
    const truncated = text.slice(0, MAX_CHARS);
    const result = await this.embedBatch([truncated]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const truncated = texts.map(t => t.slice(0, MAX_CHARS));
    const results: Float32Array[] = [];

    for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
      const batch = truncated.slice(i, i + BATCH_SIZE);
      const batchResults = await this.embedBatchWithRetry(batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.getClient().embeddings.create({
          model: this.model,
          input: texts,
          ...(this.explicitDimensions ? { dimensions: this.explicitDimensions } : {}),
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
}

// ---------------------------------------------------------------------------
// Ollama provider (local embeddings via Ollama API)
// ---------------------------------------------------------------------------

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly provider = 'ollama' as const;
  readonly model: string;
  readonly dimensions: number;
  readonly metadata: EmbeddingMetadata;
  private readonly baseUrl: string;

  constructor(opts?: { model?: string; baseUrl?: string; dimensions?: number }) {
    const metadata = resolveEmbeddingMetadata({
      embedding_provider: 'ollama',
      embedding_model: opts?.model,
      embedding_dimensions: opts?.dimensions,
    });
    this.model = metadata.model;
    this.dimensions = metadata.dimensions;
    this.metadata = metadata;
    this.baseUrl = opts?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  }

  async embed(text: string): Promise<Float32Array> {
    const truncated = text.slice(0, MAX_CHARS);
    const result = await this.embedBatch([truncated]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const truncated = texts.map(t => t.slice(0, MAX_CHARS));
    const results: Float32Array[] = [];

    for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
      const batch = truncated.slice(i, i + BATCH_SIZE);
      const batchResults = await this.embedBatchWithRetry(batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Ollama /api/embed endpoint (v0.1.26+)
        const response = await fetch(`${this.baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            input: texts,
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Ollama embed API error (${response.status}): ${body}`);
        }

        const data = await response.json() as { embeddings: number[][] };
        if (!data.embeddings || !Array.isArray(data.embeddings)) {
          throw new Error(`Unexpected Ollama response: missing embeddings array`);
        }

        return data.embeddings.map((emb: number[]) => new Float32Array(emb));
      } catch (e: unknown) {
        if (attempt === MAX_RETRIES - 1) throw e;
        await sleep(exponentialDelay(attempt));
      }
    }

    throw new Error('Ollama embedding failed after all retries');
  }
}

// ---------------------------------------------------------------------------
// Provider factory — selects backend based on config / env vars
// ---------------------------------------------------------------------------

let providerInstance: EmbeddingProvider | null = null;

/**
 * Get or create the configured embedding provider.
 *
 * Resolution order:
 * 1. GBRAIN_EMBEDDING_PROVIDER env var ('openai' | 'ollama')
 * 2. embedding_provider field in ~/.gbrain/config.json
 * 3. Default: 'openai' (if OPENAI_API_KEY is set), otherwise 'ollama'
 */
export function getEmbeddingProvider(config?: {
  embedding_provider?: string;
  embedding_model?: string;
  embedding_dimensions?: number | string;
  ollama_base_url?: string;
  ollama_model?: string;
}): EmbeddingProvider {
  if (providerInstance) return providerInstance;

  const fileConfig = getConfigWithEnv(config) || undefined;
  const providerName = resolveProviderName(fileConfig);
  const metadata = resolveEmbeddingMetadata(fileConfig);

  if (providerName === 'ollama') {
    providerInstance = new OllamaEmbeddingProvider({
      model: metadata.model,
      dimensions: metadata.dimensionsOverridden ? metadata.dimensions : undefined,
      baseUrl: fileConfig?.ollama_base_url,
    });
  } else {
    providerInstance = new OpenAIEmbeddingProvider({
      model: metadata.model,
      dimensions: metadata.dimensionsOverridden ? metadata.dimensions : undefined,
    });
  }

  return providerInstance;
}

/**
 * Reset the provider singleton (useful for testing or config changes).
 */
export function resetEmbeddingProvider(): void {
  providerInstance = null;
}

// ---------------------------------------------------------------------------
// Convenience functions — backward-compatible with existing callers.
// These delegate to the default provider (no explicit config injection needed).
// ---------------------------------------------------------------------------

export async function embed(text: string): Promise<Float32Array> {
  return getEmbeddingProvider().embed(text);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  return getEmbeddingProvider().embedBatch(texts);
}

// ---------------------------------------------------------------------------
// Exports for external consumers that need model/dimensions metadata
// ---------------------------------------------------------------------------

/** @deprecated Use getEmbeddingProvider().model instead */
export const EMBEDDING_MODEL = DEFAULT_OPENAI_MODEL;
/** @deprecated Use getEmbeddingProvider().dimensions instead */
export const EMBEDDING_DIMENSIONS = OPENAI_MODEL_DIMENSIONS[DEFAULT_OPENAI_MODEL];
