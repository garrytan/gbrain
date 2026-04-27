/**
 * Embedding configuration helpers.
 *
 * Kept separate from `embedding.ts` so that engine code, migrations, and
 * tests can read the configured model/dim without reaching into the OpenAI
 * client module — which is mocked aggressively by `test/embed.test.ts`.
 *
 * Default: OpenAI text-embedding-3-large at 1536 dimensions (legacy baseline).
 *
 * Override via env:
 *   GBRAIN_EMBEDDING_MODEL       — model name passed to the API
 *   GBRAIN_EMBEDDING_DIMENSIONS  — output vector dim, must match the column type
 *   GBRAIN_EMBEDDING_BASE_URL    — OpenAI-compatible endpoint (Ollama, vLLM, …)
 *   GBRAIN_EMBEDDING_API_KEY     — overrides OPENAI_API_KEY for the embed client only
 */

export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-large';
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/**
 * Read the configured embedding model. Falls back to the legacy default so
 * existing brains stay byte-identical when no env var is set.
 */
export function getEmbeddingModel(): string {
  const v = process.env.GBRAIN_EMBEDDING_MODEL;
  return v && v.trim().length > 0 ? v : DEFAULT_EMBEDDING_MODEL;
}

/**
 * Read the configured embedding dimensions. Must match the type of the
 * `content_chunks.embedding` column — migration v30 keeps them in sync.
 */
export function getEmbeddingDimensions(): number {
  const v = process.env.GBRAIN_EMBEDDING_DIMENSIONS;
  if (!v) return DEFAULT_EMBEDDING_DIMENSIONS;
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(
      `GBRAIN_EMBEDDING_DIMENSIONS must be a positive integer, got "${v}"`,
    );
  }
  return n;
}

/**
 * Read the optional OpenAI-compatible base URL. Used by the embedding client
 * to redirect requests to local servers like Ollama (`http://localhost:11434/v1`).
 */
export function getEmbeddingBaseUrl(): string | undefined {
  const v = process.env.GBRAIN_EMBEDDING_BASE_URL;
  return v && v.trim().length > 0 ? v : undefined;
}

/**
 * Read the embedder-specific API key, falling back to OPENAI_API_KEY. Lets
 * users keep a real OpenAI key for chat models while pointing embeddings at
 * a self-hosted endpoint with a placeholder key.
 */
export function getEmbeddingApiKey(): string | undefined {
  return process.env.GBRAIN_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
}
