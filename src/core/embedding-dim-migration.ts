import type { BrainEngine } from './engine.ts';
import { readContentChunksEmbeddingDim } from './embedding-dim-check.ts';
import { PGVECTOR_HNSW_VECTOR_MAX_DIMS } from './vector-index.ts';

export interface EmbeddingDimMigrationPlan {
  currentDims: number;
  targetDims: number;
  recreateHnsw: boolean;
  queryCachePresent: boolean;
}

export interface EmbeddingDimMigrationResult extends EmbeddingDimMigrationPlan {
  status: 'migrated' | 'noop';
  embeddingsCleared: true;
  queryCacheCleared: boolean;
}

function assertValidDims(dims: number): void {
  if (!Number.isInteger(dims) || dims <= 0 || dims > 4096) {
    throw new Error(`Invalid embedding dimensions: ${dims}`);
  }
}

async function tableExists(engine: BrainEngine, tableName: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return !!rows[0]?.exists;
}

export async function planEmbeddingDimMigration(
  engine: BrainEngine,
  targetDims: number,
): Promise<EmbeddingDimMigrationPlan> {
  assertValidDims(targetDims);
  const current = await readContentChunksEmbeddingDim(engine);
  if (!current.exists || current.dims === null) {
    throw new Error('content_chunks.embedding does not exist. Run `gbrain init` first.');
  }

  return {
    currentDims: current.dims,
    targetDims,
    recreateHnsw: targetDims <= PGVECTOR_HNSW_VECTOR_MAX_DIMS,
    queryCachePresent: await tableExists(engine, 'query_cache'),
  };
}

export async function migrateEmbeddingDimensions(
  engine: BrainEngine,
  targetDims: number,
): Promise<EmbeddingDimMigrationResult> {
  const plan = await planEmbeddingDimMigration(engine, targetDims);
  if (plan.currentDims === targetDims) {
    return {
      ...plan,
      status: 'noop',
      embeddingsCleared: true,
      queryCacheCleared: false,
    };
  }

  const statements = [
    'BEGIN',
    'DROP INDEX IF EXISTS idx_chunks_embedding',
    `ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${targetDims}) USING NULL::vector(${targetDims})`,
    'UPDATE content_chunks SET embedded_at = NULL',
    ...(plan.recreateHnsw
      ? ['CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)']
      : []),
    ...(plan.queryCachePresent
      ? [
          'DROP INDEX IF EXISTS idx_query_cache_embedding_hnsw',
          'DELETE FROM query_cache',
          `ALTER TABLE query_cache ALTER COLUMN embedding TYPE vector(${targetDims}) USING NULL::vector(${targetDims})`,
          ...(plan.recreateHnsw
            ? ['CREATE INDEX IF NOT EXISTS idx_query_cache_embedding_hnsw ON query_cache USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL']
            : []),
        ]
      : []),
    'COMMIT',
  ];

  try {
    for (const sql of statements) {
      await engine.executeRaw(sql);
    }
  } catch (err) {
    try { await engine.executeRaw('ROLLBACK'); } catch { /* ignore rollback failure */ }
    throw err;
  }

  await engine.setConfig('embedding_dimensions', String(targetDims));

  return {
    ...plan,
    status: 'migrated',
    embeddingsCleared: true,
    queryCacheCleared: plan.queryCachePresent,
  };
}
