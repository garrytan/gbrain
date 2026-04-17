/**
 * OllamaProvider — embeddings via Ollama's OpenAI-compatible /v1/embeddings endpoint.
 *
 * Differences from OpenAI:
 * - No `dimensions` parameter (Matryoshka not supported)
 * - Output dim is fixed by the model (nomic-embed-text=768, mxbai-embed-large=1024, bge-m3=1024)
 * - No API key required (ignored if sent)
 * - Errors don't follow OpenAI's shape — we normalize them here so the service's
 *   retry loop sees consistent error types.
 */

import OpenAI from 'openai';
import type { EmbeddingProvider, HealthCheckResult, ProviderConfig } from '../provider.ts';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_MAX_CHARS = 8000;

/** Known Ollama embedding models and their native output dimensions. */
const KNOWN_DIMENSIONS: Record<string, number> = {
  'nomic-embed-text': 768,
  'mxbai-embed-large': 1024,
  'bge-m3': 1024,
  'snowflake-arctic-embed:large': 1024,
  'all-minilm': 384,
};

export class OllamaProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly model: string;
  readonly dimensions: number;
  readonly maxInputChars = DEFAULT_MAX_CHARS;
  private readonly client: OpenAI;

  constructor(config: ProviderConfig) {
    if (!config.model) {
      throw new Error("OllamaProvider requires `model` in ProviderConfig (e.g. 'nomic-embed-text').");
    }
    this.model = config.model;
    this.dimensions = config.dimensions ?? KNOWN_DIMENSIONS[config.model] ?? 0;

    if (!this.dimensions) {
      throw new Error(
        `OllamaProvider: cannot infer dimensions for model '${config.model}'. ` +
        `Pass --dimensions explicitly or add it to KNOWN_DIMENSIONS in providers/ollama.ts.`
      );
    }

    this.client = new OpenAI({
      apiKey: config.apiKey ?? 'ollama-no-key',
      baseURL: config.baseUrl ?? DEFAULT_BASE_URL,
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    let response;
    try {
      response = await this.client.embeddings.create({
        model: this.model,
        input: texts,
      });
    } catch (e: unknown) {
      // Normalize Ollama errors so service-layer retry can distinguish transient vs fatal.
      throw normalizeOllamaError(e);
    }
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map(d => {
      const v = new Float32Array(d.embedding);
      if (v.length !== this.dimensions) {
        throw new Error(
          `OllamaProvider: expected ${this.dimensions}-dim vector, got ${v.length}. ` +
          `Model ${this.model} may not match its declared dimensions — check ollama pull output.`
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

class OllamaError extends Error {
  constructor(message: string, readonly status?: number, readonly transient = false) {
    super(message);
    this.name = 'OllamaError';
  }
}

function normalizeOllamaError(e: unknown): Error {
  if (e instanceof OpenAI.APIError) {
    // Ollama may return 404 if model not pulled, 503 if loading, 500 transient.
    const transient = e.status === 503 || e.status === 500 || e.status === 429;
    let hint = '';
    if (e.status === 404) hint = ` (model not pulled? try: ollama pull ${e.message.match(/model "([^"]+)"/)?.[1] ?? 'MODEL'})`;
    if (e.status === 503) hint = ' (Ollama is loading the model — retry shortly)';
    return new OllamaError(`Ollama API ${e.status}: ${e.message}${hint}`, e.status, transient);
  }
  if (e instanceof Error && /ECONNREFUSED|fetch failed|ENOTFOUND/.test(e.message)) {
    return new OllamaError(
      `Ollama not reachable at the configured base URL. Is the daemon running? Try: ollama serve`,
      undefined,
      true
    );
  }
  return e instanceof Error ? e : new Error(String(e));
}

export { OllamaError };
