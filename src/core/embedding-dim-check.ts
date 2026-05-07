/**
 * Detect existing-brain embedding-dimension mismatch (v0.28.5 — A4).
 *
 * `gbrain init --embedding-dimensions N` on an existing brain whose
 * `content_chunks.embedding` column is a different `vector(M)` would
 * silently create a config/column drift: the config gets templated to N
 * but the column stays at M. The first sync write blows up with
 * "expected M, got N" — the silent-corruption pattern v0.28.5 is shipped
 * to kill.
 *
 * Loud-failure path: `gbrain init` AND `gbrain doctor` both consult this
 * helper. On mismatch they emit the same inline ALTER recipe (see
 * `embeddingMismatchMessage`) plus a pointer to `docs/embedding-migrations.md`.
 */

import type { BrainEngine } from './engine.ts';
import { PGVECTOR_HNSW_VECTOR_MAX_DIMS } from './vector-index.ts';

export interface ColumnDimResult {
  /** Whether the `content_chunks.embedding` column exists. False on a fresh brain. */
  exists: boolean;
  /** Parsed `vector(N)` dimension if known. null when the column doesn't exist or the type isn't vector. */
  dims: number | null;
}

/**
 * Read the actual dimension of `content_chunks.embedding` from the engine.
 *
 * Uses information_schema + a vector-specific catalog query. Returns
 * { exists: false, dims: null } on a fresh brain that doesn't have the
 * column yet. Returns { exists: true, dims: null } on a brain whose
 * column type isn't `vector` (shouldn't happen but defensive).
 */
export async function readContentChunksEmbeddingDim(engine: BrainEngine): Promise<ColumnDimResult> {
  // Probe column existence first to avoid noisy errors on fresh brains.
  const existsRows = await engine.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'content_chunks'
         AND column_name = 'embedding'
     ) AS exists`,
  );
  const exists = !!existsRows?.[0]?.exists;
  if (!exists) return { exists: false, dims: null };

  // pgvector stores dim in pg_type.typmod when atttypmod is set; format_type
  // returns the human-readable `vector(N)`. We parse N out of that.
  const formatRows = await engine.executeRaw<{ formatted: string | null }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'content_chunks'
        AND a.attname = 'embedding'
        AND NOT a.attisdropped`,
  );
  const formatted = formatRows?.[0]?.formatted ?? null;
  if (!formatted) return { exists: true, dims: null };

  const m = formatted.match(/vector\((\d+)\)/i);
  return { exists: true, dims: m ? parseInt(m[1], 10) : null };
}

/**
 * Build the human-readable ALTER recipe printed inline to stderr (or
 * delivered via `gbrain doctor` output) when an existing brain's column
 * dim doesn't match the requested dim.
 *
 * Steps cover the four-step contract from `docs/embedding-migrations.md`:
 *   1. DROP INDEX (HNSW can't survive ALTER COLUMN TYPE)
 *   2. ALTER COLUMN TYPE
 *   3. Wipe stale embeddings
 *   4. Conditional reindex (HNSW only when dims <= 2000)
 */
export function embeddingMismatchMessage(opts: {
  currentDims: number;
  requestedDims: number;
  requestedModel?: string;
  source?: 'init' | 'doctor';
}): string {
  const { currentDims, requestedDims, requestedModel, source } = opts;
  const supportsHnsw = requestedDims <= PGVECTOR_HNSW_VECTOR_MAX_DIMS;
  const reindexLine = supportsHnsw
    ? `CREATE INDEX IF NOT EXISTS idx_chunks_embedding\n  ON content_chunks USING hnsw (embedding vector_cosine_ops);`
    : `-- Skip reindex. dims=${requestedDims} exceeds pgvector's HNSW cap of ${PGVECTOR_HNSW_VECTOR_MAX_DIMS};\n-- searchVector falls back to exact scan.`;

  const header = source === 'doctor'
    ? `Embedding dimension mismatch detected.`
    : `Refusing to silently re-template existing brain.`;

  const lines = [
    header,
    ``,
    `  Existing column: vector(${currentDims})`,
    `  Requested:       vector(${requestedDims})${requestedModel ? `  (${requestedModel})` : ''}`,
    ``,
    `Switching dims is destructive: it drops every embedding in your brain and`,
    `requires a full re-embed (potentially hours and $1-100 in API calls).`,
    ``,
    `If you actually want to switch, run this manually against your brain's DB:`,
    ``,
    `  BEGIN;`,
    `  DROP INDEX IF EXISTS idx_chunks_embedding;`,
    `  ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${requestedDims});`,
    `  UPDATE content_chunks SET embedding = NULL, embedded_at = NULL;`,
    `  ${reindexLine.split('\n').join('\n  ')}`,
    `  COMMIT;`,
    ``,
    `Then re-embed:`,
    `  gbrain config set embedding_dimensions ${requestedDims}`,
    requestedModel ? `  gbrain config set embedding_model ${requestedModel}` : '',
    `  gbrain embed --stale`,
    ``,
    `Full guide: docs/embedding-migrations.md`,
  ].filter(Boolean);

  return lines.join('\n');
}
