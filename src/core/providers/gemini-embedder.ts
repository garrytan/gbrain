/**
 * FORK: Gemini embedding provider.
 *
 * Model: text-embedding-004 (stable, 768 dims max).
 * API key: GOOGLE_API_KEY or GEMINI_API_KEY.
 * Batch: up to 100 texts per call (same as OpenAI provider).
 * Retry: exponential backoff matching OpenAI provider (4s base, 120s cap, 5 retries).
 *
 * Dimensions: configurable via constructor (1–768). Defaults to 768.
 *   - 768  → native quality, new brains only (schema must be vector(768))
 *   - lower → Matryoshka truncation, useful for space-constrained deployments
 *
 * Schema compatibility note:
 *   OpenAI produces 1536-dim vectors; Gemini text-embedding-004 caps at 768.
 *   Mixing providers on the same brain requires a full re-embed migration.
 *   Run `gbrain migrate --provider gemini` (Phase 2) to handle this.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { EmbeddingProvider } from '../embedding-provider.ts';

const MODEL = 'text-embedding-004';
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

export class GeminiEmbedder implements EmbeddingProvider {
  readonly model = MODEL;
  readonly dimensions: number;

  private client: GoogleGenerativeAI | null = null;

  constructor(dimensions = 768) {
    if (dimensions < 1 || dimensions > 768) {
      throw new Error(`GeminiEmbedder: dimensions must be 1–768, got ${dimensions}`);
    }
    this.dimensions = dimensions;
  }

  private getClient(): GoogleGenerativeAI {
    if (!this.client) {
      const key = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      if (!key) {
        throw new Error(
          'Gemini embedding provider requires GOOGLE_API_KEY or GEMINI_API_KEY. ' +
          'Set one of these env vars or switch back to OpenAI with GBRAIN_EMBEDDING_PROVIDER=openai.'
        );
      }
      this.client = new GoogleGenerativeAI(key);
    }
    return this.client;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Validate key upfront — config errors should not be retried.
    this.getClient();
    const truncated = texts.map(t => t.slice(0, MAX_CHARS));
    const results: Float32Array[] = [];
    for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
      const batch = truncated.slice(i, i + BATCH_SIZE);
      results.push(...await this._batchWithRetry(batch));
    }
    return results;
  }

  private async _batchWithRetry(texts: string[]): Promise<Float32Array[]> {
    const dims = this.dimensions;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const genAI = this.getClient();
        const model = genAI.getGenerativeModel({ model: MODEL });

        const batchResult = await model.batchEmbedContents({
          requests: texts.map(text => ({
            content: { parts: [{ text }], role: 'user' },
            outputDimensionality: dims,
          })),
        });

        return batchResult.embeddings.map(e => new Float32Array(e.values));
      } catch (e: unknown) {
        if (attempt === MAX_RETRIES - 1) throw e;
        await sleep(exponentialDelay(attempt));
      }
    }
    throw new Error('Gemini embedding failed after all retries');
  }
}

function exponentialDelay(attempt: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
