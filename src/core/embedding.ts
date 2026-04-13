/**
 * Embedding Service — Pluggable Provider Architecture
 *
 * Supports multiple embedding backends via the EmbeddingProvider interface.
 * Default: OpenAI text-embedding-3-large (1536d).
 * Optional: Ollama (e.g. nomic-embed-text at 768d) for fully local embeddings.
 *
 * Provider is selected via GBRAIN_EMBEDDING_PROVIDER env var or
 * embedding_provider in ~/.gbrain/config.json.
 *
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * 8000 character input truncation.
 */

import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  /** Embed a single text string. */
  embed(text: string): Promise<Float32Array>;
  /** Embed a batch of text strings. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  /** Model name (stored in DB for provenance). */
  readonly model: string;
  /** Vector dimensions (must match DB schema vector(N) column). */
  readonly dimensions: number;
}

// ---------------------------------------------------------------------------
// Shared constants & utilities
// ---------------------------------------------------------------------------

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

function exponentialDelay(attempt: number): number {
  const delay = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// OpenAI provider (original, default)
// ---------------------------------------------------------------------------

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'text-embedding-3-large';
  readonly dimensions = 1536;

  private client: OpenAI | null = null;

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
          dimensions: this.dimensions,
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
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;

  constructor(opts?: { model?: string; baseUrl?: string }) {
    this.model = opts?.model || 'nomic-embed-text';
    this.baseUrl = opts?.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

    // Known model dimensions — used to set DB schema correctly.
    // If the model is not in this map, we probe Ollama at embed time.
    this.dimensions = opts?.model === 'nomic-embed-text' ? 768
      : opts?.model === 'mxbai-embed-large' ? 1024
      : opts?.model === 'snowflake-arctic-embed' ? 1024
      : opts?.model === 'all-minilm' ? 384
      : 768; // default for most small Ollama embedding models
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
  ollama_base_url?: string;
  ollama_model?: string;
}): EmbeddingProvider {
  if (providerInstance) return providerInstance;

  // If no config passed, try reading from config file
  let fileConfig = config;
  if (!fileConfig) {
    try {
      const raw = readFileSync(join(homedir(), '.gbrain', 'config.json'), 'utf-8');
      fileConfig = JSON.parse(raw) as {
        embedding_provider?: string;
        ollama_base_url?: string;
        ollama_model?: string;
      };
    } catch {
      // No config file — use defaults
    }
  }

  const providerName =
    process.env.GBRAIN_EMBEDDING_PROVIDER ||
    fileConfig?.embedding_provider ||
    (process.env.OPENAI_API_KEY ? 'openai' : 'ollama');

  if (providerName === 'ollama') {
    providerInstance = new OllamaEmbeddingProvider({
      model: fileConfig?.ollama_model || process.env.OLLAMA_EMBEDDING_MODEL,
      baseUrl: fileConfig?.ollama_base_url,
    });
  } else {
    providerInstance = new OpenAIEmbeddingProvider();
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
export const EMBEDDING_MODEL = 'text-embedding-3-large';
/** @deprecated Use getEmbeddingProvider().dimensions instead */
export const EMBEDDING_DIMENSIONS = 1536;
