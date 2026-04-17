/**
 * Embedding Service — provider-agnostic batching, retry, truncation.
 *
 * Owns the cross-cutting concerns: chunked batching to respect provider rate limits,
 * exponential backoff on retryable errors, input truncation to provider's max chars.
 *
 * Delegates the actual API call to a provider instance from `./factory.ts`.
 */

import OpenAI from 'openai';
import type { EmbeddingProvider } from './provider.ts';
import { createProvider } from './factory.ts';
import { OllamaError } from './providers/ollama.ts';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

let defaultProvider: EmbeddingProvider | null = null;

/** Lazy-init: build the default provider on first use. Override in tests via setProvider. */
function getProvider(): EmbeddingProvider {
  if (!defaultProvider) {
    defaultProvider = createProvider();
  }
  return defaultProvider;
}

/** Replace the singleton provider — for tests, or after config reload. */
export function setProvider(provider: EmbeddingProvider | null): void {
  defaultProvider = provider;
}

/** Returns the active provider's metadata without re-creating it. */
export function getActiveProvider(): EmbeddingProvider {
  return getProvider();
}

export async function embed(text: string): Promise<Float32Array> {
  const provider = getProvider();
  const truncated = text.slice(0, provider.maxInputChars);
  const result = await embedBatchInternal(provider, [truncated]);
  return result[0];
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const provider = getProvider();
  const truncated = texts.map(t => t.slice(0, provider.maxInputChars));
  const results: Float32Array[] = [];

  for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
    const batch = truncated.slice(i, i + BATCH_SIZE);
    const batchResults = await embedBatchInternal(provider, batch);
    results.push(...batchResults);
  }
  return results;
}

async function embedBatchInternal(provider: EmbeddingProvider, texts: string[]): Promise<Float32Array[]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await provider.embed(texts);
    } catch (e: unknown) {
      if (attempt === MAX_RETRIES - 1) throw e;
      if (!isRetryable(e)) throw e;
      await sleep(retryDelay(e, attempt));
    }
  }
  throw new Error('Embedding failed after all retries');
}

function isRetryable(e: unknown): boolean {
  if (e instanceof OpenAI.APIError) {
    return e.status === 429 || e.status === 500 || e.status === 502 || e.status === 503;
  }
  if (e instanceof OllamaError) return e.transient;
  // Network / DNS / fetch failures from any provider — retry
  if (e instanceof Error && /ECONNREFUSED|fetch failed|ENOTFOUND|ETIMEDOUT/.test(e.message)) return true;
  return false;
}

function retryDelay(e: unknown, attempt: number): number {
  // Honor Retry-After if the provider sent one (OpenAI 429s).
  if (e instanceof OpenAI.APIError && e.status === 429) {
    const retryAfter = e.headers?.['retry-after'];
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed)) return parsed * 1000;
    }
  }
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Backward-compat exports — these mirror the old src/core/embedding.ts contract.
// Code that does `import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '...'`
// gets the active provider's values.
export function getEmbeddingModel(): string {
  return getProvider().model;
}

export function getEmbeddingDimensions(): number {
  return getProvider().dimensions;
}
