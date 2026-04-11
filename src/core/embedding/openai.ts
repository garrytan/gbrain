import OpenAI from 'openai';
import type { EmbeddingProvider } from './types.ts';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

export class OpenAIProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;
  private client: OpenAI | null = null;

  constructor(model = 'text-embedding-3-large', dimensions = 1536) {
    this.model = model;
    this.dimensions = dimensions;
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI();
    }
    return this.client;
  }

  async embed(text: string): Promise<Float32Array> {
    const result = await this.embedBatch([text]);
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

        let delay = BASE_DELAY_MS * Math.pow(2, attempt);
        delay = Math.min(delay, MAX_DELAY_MS);

        if (e instanceof OpenAI.APIError && e.status === 429) {
          const retryAfter = e.headers?.['retry-after'];
          if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed)) {
              delay = parsed * 1000;
            }
          }
        }

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error('Embedding failed after all retries');
  }
}
