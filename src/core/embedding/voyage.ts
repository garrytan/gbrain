import { BaseProvider } from './base.ts';

export class VoyageProvider extends BaseProvider {
  readonly name = 'voyage';
  readonly model: string;
  readonly dimensions: number;
  protected batchSize = 128;

  constructor(model = 'voyage-4-large', dimensions = 1024) {
    super();
    this.model = model;
    this.dimensions = dimensions;
  }

  private getApiKey(): string {
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error('VOYAGE_API_KEY environment variable is required for Voyage embedding provider');
    return key;
  }

  protected async callAPI(texts: string[]): Promise<Float32Array[]> {
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
  }
}
