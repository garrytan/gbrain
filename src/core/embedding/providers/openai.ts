/**
 * OpenAIProvider — embeddings via OpenAI's API or any OpenAI-compatible endpoint
 * that supports the Matryoshka `dimensions` parameter (text-embedding-3 family).
 */

import OpenAI from 'openai';
import type { EmbeddingProvider, HealthCheckResult, ProviderConfig } from '../provider.ts';

const DEFAULT_MODEL = 'text-embedding-3-large';
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_MAX_CHARS = 8000;

/** Models in the text-embedding-3 family accept the `dimensions` param (Matryoshka). */
function supportsMatryoshka(model: string): boolean {
  return model.startsWith('text-embedding-3');
}

export class OpenAIProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;
  readonly maxInputChars = DEFAULT_MAX_CHARS;
  private readonly client: OpenAI;
  private readonly useDimensionsParam: boolean;

  constructor(config: ProviderConfig) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.dimensions = config.dimensions ?? DEFAULT_DIMENSIONS;
    this.useDimensionsParam = supportsMatryoshka(this.model);

    this.client = new OpenAI({
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? '',
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      ...(this.useDimensionsParam ? { dimensions: this.dimensions } : {}),
    });
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map(d => {
      const v = new Float32Array(d.embedding);
      if (v.length !== this.dimensions) {
        throw new Error(
          `OpenAIProvider: expected ${this.dimensions}-dim vector, got ${v.length}. ` +
          `Model ${this.model} may not support requested dimensions.`
        );
      }
      return v;
    });
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const result = await this.embed(['health check']);
      return {
        ok: true,
        latencyMs: Date.now() - start,
        detectedDimensions: result[0]?.length,
      };
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ok: false, reason, latencyMs: Date.now() - start };
    }
  }
}
