import { DEFAULT_LOCAL_EMBEDDING_DIMENSIONS } from './embedding/provider.ts';

export const PGVECTOR_EMBEDDING_DIMENSIONS = DEFAULT_LOCAL_EMBEDDING_DIMENSIONS;

export function assertPgVectorEmbeddingDimensions(
  embedding: Float32Array,
  context: string,
): void {
  if (embedding.length === PGVECTOR_EMBEDDING_DIMENSIONS) return;

  throw new Error(
    `${context} expected ${PGVECTOR_EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}. ` +
    'The embedding runtime returned a vector of the wrong size — it is likely serving a different ' +
    'model or pooling configuration than the configured qwen3-embedding:0.6b (1024 dimensions). ' +
    'Fix the embedding runtime (or MBRAIN_LOCAL_EMBEDDING_URL / OLLAMA_HOST) rather than the storage.',
  );
}
