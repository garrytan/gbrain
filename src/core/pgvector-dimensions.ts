import { DEFAULT_LOCAL_EMBEDDING_DIMENSIONS } from './embedding/provider.ts';

export const PGVECTOR_EMBEDDING_DIMENSIONS = DEFAULT_LOCAL_EMBEDDING_DIMENSIONS;

export function assertPgVectorEmbeddingDimensions(
  embedding: Float32Array,
  context: string,
): void {
  if (embedding.length === PGVECTOR_EMBEDDING_DIMENSIONS) return;

  throw new Error(
    `${context} expected ${PGVECTOR_EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}. ` +
    'Postgres/PGLite pgvector storage is configured for qwen3-embedding:0.6b-compatible embeddings.',
  );
}
