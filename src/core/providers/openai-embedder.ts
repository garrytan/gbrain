/**
 * FORK: OpenAI embedding provider.
 * Extracted from embedding.ts — same logic, implements EmbeddingProvider interface.
 *
 * Model: text-embedding-3-large at 1536 dimensions.
 * Retry: exponential backoff (4s base, 120s cap, 5 retries) + Retry-After header.
 * Batch: up to 100 texts per API call.
 */

import OpenAI from 'openai';
import type { EmbeddingProvider } from '../embedding-provider.ts';
import { exponentialDelay, sleep } from './retry-utils.ts';

const MODEL = 'text-embedding-3-large';
const DIMENSIONS = 1536;
const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

export class OpenAIEmbedder implements EmbeddingProvider {
  readonly model = MODEL;
  readonly dimensions = DIMENSIONS;

  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI();
    }
    return this.client;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const truncated = texts.map(t => t.slice(0, MAX_CHARS));
    const results: Float32Array[] = [];
    for (let i = 0; i < truncated.length; i += BATCH_SIZE) {
      const batch = truncated.slice(i, i + BATCH_SIZE);
      results.push(...await this._batchWithRetry(batch));
    }
    return results;
  }

  private async _batchWithRetry(texts: string[]): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await this.getClient().embeddings.create({
          model: MODEL,
          input: texts,
          dimensions: DIMENSIONS,
        });
        const sorted = response.data.sort((a, b) => a.index - b.index);
        return sorted.map(d => new Float32Array(d.embedding));
      } catch (e: unknown) {
        if (attempt === MAX_RETRIES - 1) throw e;
        let delay = exponentialDelay(attempt, BASE_DELAY_MS, MAX_DELAY_MS);
        if (e instanceof OpenAI.APIError && e.status === 429) {
          const retryAfter = e.headers?.['retry-after'];
          if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed)) delay = parsed * 1000;
          }
        }
        await sleep(delay);
      }
    }
    throw new Error('OpenAI embedding failed after all retries');
  }
}
