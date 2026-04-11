import type { EmbeddingProvider } from './types.ts';

export abstract class BaseProvider implements EmbeddingProvider {
  abstract readonly name: string;
  abstract readonly model: string;
  abstract readonly dimensions: number;

  protected maxChars = 8000;
  protected maxRetries = 5;
  protected baseDelayMs = 4000;
  protected maxDelayMs = 120000;
  protected batchSize = 100;

  async embed(text: string): Promise<Float32Array> {
    const result = await this.embedBatch([text]);
    return result[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const truncated = texts.map(t => t.slice(0, this.maxChars));
    const results: Float32Array[] = [];
    for (let i = 0; i < truncated.length; i += this.batchSize) {
      const batch = truncated.slice(i, i + this.batchSize);
      results.push(...await this.withRetry(batch));
    }
    return results;
  }

  private async withRetry(texts: string[]): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.callAPI(texts);
      } catch (e: unknown) {
        if (attempt === this.maxRetries - 1) throw e;
        const delay = this.getRetryDelay(e, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error(`${this.name} embedding failed after all retries`);
  }

  protected abstract callAPI(texts: string[]): Promise<Float32Array[]>;

  protected getRetryDelay(_error: unknown, attempt: number): number {
    return Math.min(this.baseDelayMs * Math.pow(2, attempt), this.maxDelayMs);
  }
}
