import type { EmbeddingProvider } from './types.ts';

const MAX_CHARS = 8000;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 120000;
const BATCH_SIZE = 128;

export class VoyageProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly model: string;
  readonly dimensions: number;

  constructor(model = 'voyage-3', dimensions = 1024) {
    this.model = model;
    this.dimensions = dimensions;
  }

  private getApiKey(): string {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error('VOYAGE_API_KEY environment variable is required for Voyage embedding provider');
    return key;
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
        const response = await fetch('https://api.voyageai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.getApiKey()}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: texts,
            output_dimension: this.dimensions,
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Voyage API error ${response.status}: ${body}`);
        }

        const data = await response.json() as {
          data: { embedding: number[]; index: number }[];
        };

        const sorted = data.data.sort((a, b) => a.index - b.index);
        return sorted.map(d => new Float32Array(d.embedding));
      } catch (e: unknown) {
        if (attempt === MAX_RETRIES - 1) throw e;

        let delay = BASE_DELAY_MS * Math.pow(2, attempt);
        delay = Math.min(delay, MAX_DELAY_MS);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error('Voyage embedding failed after all retries');
  }
}
