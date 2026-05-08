export const PGVECTOR_HNSW_VECTOR_MAX_DIMS = 2000;

const CHUNK_EMBEDDING_HNSW_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);';

export function chunkEmbeddingIndexSql(dims: number): string {
  if (dims <= PGVECTOR_HNSW_VECTOR_MAX_DIMS) return CHUNK_EMBEDDING_HNSW_INDEX;
  return [
    '-- idx_chunks_embedding skipped: pgvector HNSW vector indexes support',
    `-- at most ${PGVECTOR_HNSW_VECTOR_MAX_DIMS} dimensions; exact vector scans remain available.`,
  ].join('\n');
}

export function applyChunkEmbeddingIndexPolicy(sql: string, dims: number): string {
  return sql.replaceAll(CHUNK_EMBEDDING_HNSW_INDEX, chunkEmbeddingIndexSql(dims));
}
