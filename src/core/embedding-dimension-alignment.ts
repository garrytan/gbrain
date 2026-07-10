import type { BrainEngine } from './engine.ts';
import {
  PGVECTOR_COLUMN_MAX_DIMS,
  resolveSchemaEmbeddingDim,
  readContentChunksEmbeddingDim,
} from './embedding-dim-check.ts';
import { PGVECTOR_HNSW_VECTOR_MAX_DIMS } from './vector-index.ts';

export interface EmbeddingDimensionAlignmentResult {
  status: 'already_aligned' | 'aligned';
  previous_dimensions: number | null;
  target_dimensions: number;
  cleared_embeddings: number;
  hnsw_index_created: boolean;
}

/** Resolve the recipe-recommended dimension for a newly selected model. */
export function recommendedEmbeddingDimension(model: string): number {
  const resolved = resolveSchemaEmbeddingDim({ embedding_model: model });
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.dim;
}

/**
 * Align the primary text embedding column with the configured model dimension.
 * Only derived embeddings are removed. Pages, chunks and source material stay intact.
 */
export async function alignEmbeddingDimension(
  engine: BrainEngine,
  targetDimensions: number,
): Promise<EmbeddingDimensionAlignmentResult> {
  if (!Number.isInteger(targetDimensions) || targetDimensions <= 0 || targetDimensions > PGVECTOR_COLUMN_MAX_DIMS) {
    throw new Error(`Invalid embedding dimension: ${targetDimensions}`);
  }

  const current = await readContentChunksEmbeddingDim(engine);
  if (!current.exists) {
    throw new Error('content_chunks.embedding does not exist; run `pmbrain apply-migrations --yes` first.');
  }
  if (current.dims === targetDimensions) {
    return {
      status: 'already_aligned',
      previous_dimensions: current.dims,
      target_dimensions: targetDimensions,
      cleared_embeddings: 0,
      hnsw_index_created: targetDimensions <= PGVECTOR_HNSW_VECTOR_MAX_DIMS,
    };
  }

  const countRows = await engine.executeRaw<{ count: string | number }>(
    'SELECT COUNT(*) AS count FROM content_chunks WHERE embedding IS NOT NULL',
  );
  const clearedEmbeddings = Number(countRows[0]?.count ?? 0);
  const createHnsw = targetDimensions <= PGVECTOR_HNSW_VECTOR_MAX_DIMS;

  await engine.transaction(async (tx) => {
    await tx.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
    await tx.executeRaw('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding');
    await tx.executeRaw(`ALTER TABLE content_chunks ADD COLUMN embedding vector(${targetDimensions})`);
    if (createHnsw) {
      await tx.executeRaw(
        'CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)',
      );
    }
  });

  return {
    status: 'aligned',
    previous_dimensions: current.dims,
    target_dimensions: targetDimensions,
    cleared_embeddings: clearedEmbeddings,
    hnsw_index_created: createHnsw,
  };
}
