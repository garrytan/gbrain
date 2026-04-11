import { GoogleGenAI } from '@google/genai';
import type { EmbeddingProvider } from './types.ts';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 100;

export class GeminiProvider implements EmbeddingProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly dimensions: number;
  private client: GoogleGenAI | null = null;

  constructor(model = 'gemini-embedding-2-preview', dimensions = 1536) {
    this.model = model;
    this.dimensions = dimensions;
  }

  private getClient(): GoogleGenAI {
    if (!this.client) {
      const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY environment variable is required for Gemini embedding provider');
      this.client = new GoogleGenAI({ apiKey });
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
        const response = await this.getClient().models.embedContent({
          model: this.model,
          contents: texts.map(t => ({ parts: [{ text: t }] })),
          config: { outputDimensionality: this.dimensions },
        });

        return (response.embeddings || []).map(
          e => new Float32Array(e.values || []),
        );
      } catch (e: unknown) {
        if (attempt === MAX_RETRIES - 1) throw e;

        let delay = BASE_DELAY_MS * Math.pow(2, attempt);
        delay = Math.min(delay, MAX_DELAY_MS);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error('Gemini embedding failed after all retries');
  }
}
