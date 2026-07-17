import type { BrainEngine } from './engine.ts';
import {
  PGVECTOR_COLUMN_MAX_DIMS,
  resolveSchemaEmbeddingDim,
  readContentChunksEmbeddingDim,
} from './embedding-dim-check.ts';
import { PGVECTOR_HNSW_VECTOR_MAX_DIMS } from './vector-index.ts';

export interface EmbeddingDimensionAlignmentResult {
  status: 'already_aligned' | 'aligned' | 'invalidated';
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
 * Repair the pre-1.1.27 state where config changed but same-width vectors
 * kept the previous model's embedding. Only derived vectors are invalidated;
 * page/chunk text remains untouched and the stale pipeline can resume safely.
 */
export async function invalidateMismatchedEmbeddingModels(
  engine: BrainEngine,
  targetModel: string,
): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count
       FROM content_chunks
      WHERE embedding IS NOT NULL
        AND model IS DISTINCT FROM $1`,
    [targetModel],
  );
  const count = Number(Array.isArray(rows) ? rows[0]?.count ?? 0 : 0);
  if (count === 0) return 0;

  await engine.transaction(async (tx) => {
    await tx.executeRaw(
      `UPDATE content_chunks
          SET embedding = NULL,
              embedded_at = NULL,
              model = $1
        WHERE embedding IS NOT NULL
          AND model IS DISTINCT FROM $1`,
      [targetModel],
    );
  });
  return count;
}

/**
 * Align the primary text embedding column with the configured model dimension.
 * Only derived embeddings are removed. Pages, chunks and source material stay intact.
 */
export async function alignEmbeddingDimension(
  engine: BrainEngine,
  targetDimensions: number,
  opts: { forceReembed?: boolean; targetModel?: string } = {},
): Promise<EmbeddingDimensionAlignmentResult> {
  if (!Number.isInteger(targetDimensions) || targetDimensions <= 0 || targetDimensions > PGVECTOR_COLUMN_MAX_DIMS) {
    throw new Error(`Invalid embedding dimension: ${targetDimensions}`);
  }

  const current = await readContentChunksEmbeddingDim(engine);
  if (!current.exists) {
    throw new Error('content_chunks.embedding does not exist; run `pmbrain apply-migrations --yes` first.');
  }
  if (current.dims === targetDimensions && !opts.forceReembed) {
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

  if (current.dims === targetDimensions) {
    await engine.transaction(async (tx) => {
      if (opts.targetModel) {
        await tx.executeRaw(
          'UPDATE content_chunks SET embedding = NULL, embedded_at = NULL, model = $1',
          [opts.targetModel],
        );
      } else {
        await tx.executeRaw(
          'UPDATE content_chunks SET embedding = NULL, embedded_at = NULL WHERE embedding IS NOT NULL',
        );
      }
    });
    return {
      status: 'invalidated',
      previous_dimensions: current.dims,
      target_dimensions: targetDimensions,
      cleared_embeddings: clearedEmbeddings,
      hnsw_index_created: false,
    };
  }

  await engine.transaction(async (tx) => {
    await tx.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
    await tx.executeRaw('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding');
    await tx.executeRaw(`ALTER TABLE content_chunks ADD COLUMN embedding vector(${targetDimensions})`);
    if (opts.targetModel) {
      await tx.executeRaw('UPDATE content_chunks SET embedded_at = NULL, model = $1', [opts.targetModel]);
    } else {
      await tx.executeRaw('UPDATE content_chunks SET embedded_at = NULL');
    }
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
