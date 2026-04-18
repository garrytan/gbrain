/**
 * FORK: Gemini embedding provider.
 *
 * Model: gemini-embedding-001 (3072 dims max, Matryoshka truncation supported).
 * API key: GOOGLE_API_KEY or GEMINI_API_KEY.
 * Batch: up to 100 texts per call (same as OpenAI provider).
 * Retry: exponential backoff matching OpenAI provider (4s base, 120s cap, 5 retries).
 *
 * Dimensions: configurable via constructor (1–3072). Defaults to 768.
 *   - 3072 → full fidelity (new brains; schema must be vector(3072))
 *   - 768  → compact, good quality, compatible with many existing setups
 *   - 1536 → OpenAI-compatible dims; allows swapping provider without schema migration
 *
 * Schema compatibility note:
 *   OpenAI produces 1536-dim vectors. To switch existing brains:
 *   - Same dims (1536): run `gbrain migrate --provider gemini --dimensions 1536`
 *     (re-embeds all chunks with Gemini, no ALTER TABLE needed)
 *   - New dims (768 or 3072): run `gbrain migrate --provider gemini [--dimensions N]`
 *     (ALTER TABLE + full re-embed)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { EmbeddingProvider } from '../embedding-provider.ts';

const MODEL = 'gemini-embedding-001';
const MAX_DIMS = 3072;
const DEFAULT_DIMS = 768;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

export class GeminiEmbedder implements EmbeddingProvider {
  readonly model = MODEL;
  readonly dimensions: number;

  private client: GoogleGenerativeAI | null = null;

  constructor(dimensions = DEFAULT_DIMS) {
    if (dimensions < 1 || dimensions > MAX_DIMS) {
      throw new Error(`GeminiEmbedder: dimensions must be 1–${MAX_DIMS}, got ${dimensions}`);
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
