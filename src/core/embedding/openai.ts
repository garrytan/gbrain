import OpenAI from 'openai';
import { BaseProvider } from './base.ts';

export class OpenAIProvider extends BaseProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;
  private client: OpenAI | null = null;

  constructor(model = 'text-embedding-3-large', dimensions = 1536) {
    super();
    this.model = model;
    this.dimensions = dimensions;
  }

  private getClient(): OpenAI {
    if (!this.client) this.client = new OpenAI();
    return this.client;
  }

  protected async callAPI(texts: string[]): Promise<Float32Array[]> {
    const response = await this.getClient().embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
    });
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map(d => new Float32Array(d.embedding));
  }

  protected getRetryDelay(error: unknown, attempt: number): number {
    if (error instanceof OpenAI.APIError && error.status === 429) {
      const retryAfter = error.headers?.['retry-after'];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) return parsed * 1000;
      }
    }
    return super.getRetryDelay(error, attempt);
  }
}
