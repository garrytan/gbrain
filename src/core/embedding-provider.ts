/**
 * FORK: Provider-agnostic embedding abstraction (Option C).
 *
 * Providers:
 *   openai  — text-embedding-3-large, 1536 dims (default)
 *   gemini  — text-embedding-004, 768 dims (new brains)
 *
 * Config env vars:
 *   GBRAIN_EMBEDDING_PROVIDER=openai|gemini  (default: openai)
 *   GBRAIN_EMBEDDING_DIMENSIONS=N            (Gemini only: override output dims, 1–768)
 *
 * Schema note: changing provider on an existing brain requires a re-embed migration
 * if dimensions differ. New brains pick up the dimension at init time.
 */

import { OpenAIEmbedder } from './providers/openai-embedder.ts';
import { GeminiEmbedder } from './providers/gemini-embedder.ts';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

let _active: EmbeddingProvider | null = null;

export function getActiveProvider(): EmbeddingProvider {
  if (!_active) {
    const name = (process.env.GBRAIN_EMBEDDING_PROVIDER ?? 'openai').toLowerCase();
    if (name === 'gemini') {
      const dims = parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS ?? '768', 10);
      _active = new GeminiEmbedder(dims);
    } else {
      _active = new OpenAIEmbedder();
    }
  }
  return _active;
}

/**
 * Returns true if the active provider's API key is present in the environment.
 * Use this instead of checking OPENAI_API_KEY directly — supports all providers.
 */
export function isEmbeddingAvailable(): boolean {
  const name = (process.env.GBRAIN_EMBEDDING_PROVIDER ?? 'openai').toLowerCase();
  if (name === 'gemini') {
    return !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
  }
  return !!process.env.OPENAI_API_KEY;
}

/** Reset cached provider. Used in tests when env vars change between cases. */
export function resetActiveProvider(): void {
  _active = null;
}
