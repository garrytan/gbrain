/**
 * Embedding catalog reads: what the embedding commands ask Postgres about its vector columns (the declared width of a
 * `content_chunks` vector column, the stored embedding identity, which tables carry an `embedding` column, and whether a
 * table holds any vector). Each function runs the statement its caller ran through `executeRaw`, with the same text and
 * parameters, on the engine's own `executeRaw`; only its home moved (embedding-dim-check.ts, stored-embedding-identity.ts,
 * commands/embeddings.ts). The Rust engine answers the same members from its per-vector records
 * (rust/crates/gbrain-store/src/embedding_catalog.rs).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/** The tables that can carry the primary `embedding` vector column, in the order the embedding commands visit them. */
export const PRIMARY_EMBEDDING_TABLES = ['content_chunks', 'facts', 'query_cache', 'takes'] as const;
export type EmbeddingStore = typeof PRIMARY_EMBEDDING_TABLES[number];

/** A `content_chunks` vector column: whether it exists and its declared width (null when the type is not a vector type). */
export interface ChunkVectorColumn { exists: boolean; dims: number | null }

/** The stored embedding identity: the configured model and the declared width of `content_chunks.embedding`. */
export interface EmbeddingIdentity { model: string | null; dimensions: number }

const FORMAT_TYPE_SQL = `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'content_chunks'
        AND a.attname = $1
        AND NOT a.attisdropped`;

/**
 * The declared width of a `content_chunks` vector column: `{ exists: false, dims: null }` when the column is missing,
 * `{ exists: true, dims: null }` when its type is not a pgvector type.
 */
export async function readChunkVectorColumn(raw: EngineRawRead, column: string): Promise<ChunkVectorColumn> {
  // Probe column existence first to avoid noisy errors on fresh brains.
  const existsRows = await raw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'content_chunks'
         AND column_name = $1
     ) AS exists`,
    [column],
  );
  if (!existsRows?.[0]?.exists) return { exists: false, dims: null };
  // pgvector stores dim in pg_type.typmod when atttypmod is set; format_type returns `vector(N)` / `halfvec(N)`.
  const formatRows = await raw<{ formatted: string | null }>(FORMAT_TYPE_SQL, [column]);
  const formatted = formatRows?.[0]?.formatted ?? null;
  if (!formatted) return { exists: true, dims: null };
  const m = formatted.match(/(?:vector|halfvec)\((\d+)\)/i);
  return { exists: true, dims: m ? parseInt(m[1], 10) : null };
}

/**
 * The stored embedding identity: null when the brain has no `content_chunks` table; throws when the table has no
 * `embedding` column or its width is unknown (automatic schema resizing is refused). `readModel` reads the config
 * `embedding_model`.
 */
export async function readEmbeddingIdentity(raw: EngineRawRead, readModel: () => Promise<string | null>): Promise<EmbeddingIdentity | null> {
  const rows = await raw<{ formatted: string | null }>(FORMAT_TYPE_SQL, ['embedding']);
  if (rows.length === 0) {
    const tables = await raw<{ present: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'content_chunks') AS present
    `);
    if (tables[0]?.present === false) return null;
    throw new Error('Stored embedding column identity is unavailable. Run gbrain migrate embeddings --status before an explicit migration; the schema has not been resized.');
  }
  const dimensions = Number(rows[0].formatted?.match(/^(?:halfvec|vector)\((\d+)\)$/)?.[1]);
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('Stored embedding dimensions are unknown. Run gbrain migrate embeddings --status; automatic schema resizing is refused.');
  }
  const model = await readModel().catch(() => null);
  return { model: model?.trim() || null, dimensions };
}

/** The tables of PRIMARY_EMBEDDING_TABLES that have an `embedding` column, in that order. */
export async function listEmbeddingStores(raw: EngineRawRead): Promise<EmbeddingStore[]> {
  const rows = await raw<{ table_name: string }>(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'embedding'
      AND table_name = ANY($1::text[])
  `, [[...PRIMARY_EMBEDDING_TABLES]]);
  return PRIMARY_EMBEDDING_TABLES.filter(table => rows.some(row => row.table_name === table));
}

/** One constant statement per store, so no table name is spliced into SQL. */
const HAS_VECTORS_SQL: Readonly<Record<EmbeddingStore, string>> = {
  // chunk-visibility-ok: asks whether any stored row holds a vector (any generation), as the raw callers it replaced did
  content_chunks: 'SELECT EXISTS (SELECT 1 FROM content_chunks WHERE embedding IS NOT NULL) AS present',
  facts: 'SELECT EXISTS (SELECT 1 FROM facts WHERE embedding IS NOT NULL) AS present',
  query_cache: 'SELECT EXISTS (SELECT 1 FROM query_cache WHERE embedding IS NOT NULL) AS present',
  takes: 'SELECT EXISTS (SELECT 1 FROM takes WHERE embedding IS NOT NULL) AS present',
};

/** Whether any row of `store` holds a vector. */
export async function hasStoredVectors(raw: EngineRawRead, store: EmbeddingStore): Promise<boolean> {
  const sql = HAS_VECTORS_SQL[store];
  if (!sql) throw new Error(`hasStoredVectors: '${String(store)}' is not an embedding store`);
  const [row] = await raw<{ present: boolean }>(sql);
  return !!row?.present;
}

/** The fixed-width `content_chunks` vector columns beside `embedding` (`vector(1024)` on Postgres and PGLite). */
export const FIXED_VECTOR_COLUMNS = ['embedding_image', 'embedding_multimodal'] as const;
export type FixedVectorColumn = typeof FIXED_VECTOR_COLUMNS[number];

/** One source's `content_chunks` rows and how many of them hold a vector in the column. */
export interface ChunkVectorCoverageRow { source_id: string; total: number; covered: number }

/** One constant statement per column, so no column name is spliced into SQL (the doctor's unified_multimodal_coverage text). */
const COVERAGE_SQL: Readonly<Record<FixedVectorColumn, string>> = {
  // chunk-visibility-ok: doctor coverage ratio moved verbatim from doctor/checks/data-integrity.ts; it counts every chunk row, as before.
  embedding_image: `SELECT
           COALESCE(p.source_id, 'default') AS source_id,
           COUNT(*)::text AS total,
           SUM(CASE WHEN cc.embedding_image IS NOT NULL THEN 1 ELSE 0 END)::text AS covered
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         GROUP BY p.source_id`,
  // chunk-visibility-ok: doctor coverage ratio moved verbatim from doctor/checks/data-integrity.ts; it counts every chunk row, as before.
  embedding_multimodal: `SELECT
           COALESCE(p.source_id, 'default') AS source_id,
           COUNT(*)::text AS total,
           SUM(CASE WHEN cc.embedding_multimodal IS NOT NULL THEN 1 ELSE 0 END)::text AS covered
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         GROUP BY p.source_id`,
};

/**
 * Per source with at least one chunk, the chunks (every generation, soft-deleted pages too) and how many hold a vector in
 * `column`, in source id order. Throws when the column is missing (a brain from before v0.36 that has not migrated).
 */
export async function countChunkVectorCoverage(raw: EngineRawRead, column: FixedVectorColumn): Promise<ChunkVectorCoverageRow[]> {
  const sql = COVERAGE_SQL[column];
  if (!sql) throw new Error(`countChunkVectorCoverage: '${String(column)}' is not a fixed vector column`);
  const rows = await raw<{ source_id: string | null; total: string; covered: string }>(sql);
  return rows
    .map((r) => ({ source_id: r.source_id || 'default', total: parseInt(String(r.total), 10), covered: parseInt(String(r.covered), 10) }))
    .sort((a, b) => (a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : 0));
}
