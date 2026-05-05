/**
 * Embedding Service
 * Ported from production Ruby implementation (embedding_service.rb, 190 LOC)
 *
 * OpenAI text-embedding-3-large at 1536 dimensions by default.
 * Can be configured for local Ollama embeddings via ~/.gbrain/config.json:
 * embedding_provider=ollama, embedding_model=nomic-embed-text,
 * embedding_dimensions=768, embedding_base_url=http://localhost:11434.
 * Retry with exponential backoff (4s base, 120s cap, 5 retries).
 * Provider-specific input truncation. Ollama/local embedding models often
 * have much smaller context windows than OpenAI embedding models.
 */

import OpenAI from 'openai';
import { loadConfig } from './config.ts';

const DEFAULT_PROVIDER = 'openai';
const DEFAULT_MODEL = 'text-embedding-3-large';
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const OPENAI_MAX_CHARS = 8000;
const OLLAMA_MAX_CHARS = 1800;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

export interface EmbeddingRuntimeConfig {
  provider: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
}

export function getEmbeddingConfig(): EmbeddingRuntimeConfig {
  const cfg = loadConfig();
  const provider = (
    process.env.GBRAIN_EMBED_PROVIDER ||
    process.env.GBRAIN_EMBEDDING_PROVIDER ||
    cfg?.embedding_provider ||
    DEFAULT_PROVIDER
  ).toLowerCase();

  const model =
    process.env.GBRAIN_EMBED_MODEL ||
    process.env.GBRAIN_EMBEDDING_MODEL ||
    cfg?.embedding_model ||
    (provider === 'ollama' ? 'nomic-embed-text' : DEFAULT_MODEL);

  const dimensionsRaw =
    process.env.GBRAIN_EMBED_DIMENSIONS ||
    process.env.GBRAIN_EMBEDDING_DIMENSIONS ||
    (cfg?.embedding_dimensions != null ? String(cfg.embedding_dimensions) : '');
  const dimensions = Number.parseInt(dimensionsRaw, 10) ||
    (provider === 'ollama' ? 768 : DEFAULT_DIMENSIONS);

  const baseUrl =
    process.env.GBRAIN_EMBED_BASE_URL ||
    process.env.GBRAIN_EMBEDDING_BASE_URL ||
    cfg?.embedding_base_url ||
    (provider === 'ollama' ? DEFAULT_OLLAMA_BASE_URL : undefined);

  return { provider, model, dimensions, baseUrl };
}

export function embeddingsConfigured(): boolean {
  const cfg = getEmbeddingConfig();
  if (cfg.provider === 'ollama') return true;
  return Boolean(process.env.OPENAI_API_KEY || loadConfig()?.openai_api_key);
}

export async function embed(text: string): Promise<Float32Array> {
  const truncated = text.slice(0, maxCharsForProvider());
  const result = await embedBatch([truncated]);
  return result[0];
}

function maxCharsForProvider(): number {
  return getEmbeddingConfig().provider === 'ollama' ? OLLAMA_MAX_CHARS : OPENAI_MAX_CHARS;
}

export interface EmbedBatchOptions {
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
  const truncated = texts.map(t => t.slice(0, maxCharsForProvider()));
  const results: Float32Array[] = [];

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchWithRetry(batch);
    results.push(...batchResults);
    options.onBatchComplete?.(results.length, truncated.length);
  }

  return results;
}

async function embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
  const cfg = getEmbeddingConfig();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (cfg.provider === 'ollama') {
        return await embedBatchWithOllama(texts, cfg);
      }

      const response = await getClient().embeddings.create({
        model: cfg.model,
        input: texts,
        dimensions: cfg.dimensions,
      });

      // Sort by index to maintain order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;

      // Check for rate limit with Retry-After header
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

  // Should not reach here
  throw new Error('Embedding failed after all retries');
}

async function embedBatchWithOllama(texts: string[], cfg: EmbeddingRuntimeConfig): Promise<Float32Array[]> {
  const baseUrl = (cfg.baseUrl || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, input: texts }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama embedding failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const payload = await response.json() as { embeddings?: number[][]; embedding?: number[] };
  const rawEmbeddings = payload.embeddings ?? (payload.embedding ? [payload.embedding] : undefined);
  if (!rawEmbeddings || rawEmbeddings.length !== texts.length) {
    throw new Error(`Ollama returned ${rawEmbeddings?.length ?? 0} embedding(s) for ${texts.length} input(s)`);
  }
  return rawEmbeddings.map((embedding) => {
    if (embedding.length !== cfg.dimensions) {
      throw new Error(`Ollama returned ${embedding.length} dimensions, expected ${cfg.dimensions}`);
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

export const EMBEDDING_MODEL = getEmbeddingConfig().model;
export const EMBEDDING_DIMENSIONS = getEmbeddingConfig().dimensions;

/**
 * v0.20.0 Cathedral II Layer 8 (D1): USD cost per 1k tokens for
 * text-embedding-3-large. Used by `gbrain sync --all` cost preview and
 * the reindex-code backfill command to surface expected spend before
 * the agent/user accepts an expensive operation.
 *
 * Value: $0.00013 / 1k tokens as of 2026. Update when OpenAI changes
 * pricing. Single source of truth — every cost-preview surface reads
 * this constant, so a pricing change is a one-line edit.
 */
export const EMBEDDING_COST_PER_1K_TOKENS = 0.00013;

/** Compute USD cost estimate for embedding `tokens` at current model rate. */
export function estimateEmbeddingCostUsd(tokens: number): number {
  return (tokens / 1000) * EMBEDDING_COST_PER_1K_TOKENS;
}
