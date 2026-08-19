/**
 * SQL fragments for the primary text embedding's content-revision contract.
 *
 * The revision is chunk-local: page metadata and frontmatter updates do not
 * change it. Image and multimodal vector columns have separate provenance and
 * deliberately do not use these fragments.
 */

export function primaryEmbeddingFreshSql(alias = 'cc'): string {
  return `${alias}.embedding IS NOT NULL AND ${alias}.embedded_content_revision = ${alias}.content_revision`;
}

export function primaryEmbeddingStaleSql(alias = 'cc'): string {
  // Keep the non-NULL conjunct explicit: it makes the second OR arm imply
  // content_chunks_stale_revision_idx's partial predicate, so Postgres can
  // BitmapOr the existing NULL-vector index with the mismatch index.
  return `(${alias}.embedding IS NULL OR (${alias}.embedding IS NOT NULL AND ${alias}.embedded_content_revision IS DISTINCT FROM ${alias}.content_revision))`;
}

const PRIMARY_EMBEDDING_INPUT_CHANGED =
  `(EXCLUDED.chunk_text IS DISTINCT FROM content_chunks.chunk_text
           OR EXCLUDED.chunk_source IS DISTINCT FROM content_chunks.chunk_source)`;

/**
 * Shared by both engine upsert statements. The database trigger bumps
 * content_revision after these expressions are evaluated whenever chunk_text
 * changes, so a vector supplied with new text is stamped at current + 1.
 */
export const CONTENT_AWARE_EMBEDDING_UPSERT_ASSIGNMENTS = `
         embedding = CASE
           WHEN ${PRIMARY_EMBEDDING_INPUT_CHANGED} THEN EXCLUDED.embedding
           WHEN content_chunks.embedded_content_revision IS DISTINCT FROM content_chunks.content_revision THEN EXCLUDED.embedding
           WHEN content_chunks.embedding IS NULL THEN EXCLUDED.embedding
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedding
           ELSE content_chunks.embedding
         END,
         model = CASE
           WHEN ${PRIMARY_EMBEDDING_INPUT_CHANGED} THEN EXCLUDED.model
           WHEN content_chunks.embedded_content_revision IS DISTINCT FROM content_chunks.content_revision THEN EXCLUDED.model
           WHEN content_chunks.embedding IS NULL THEN EXCLUDED.model
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.model
           ELSE content_chunks.model
         END,
         embedded_at = CASE
           WHEN ${PRIMARY_EMBEDDING_INPUT_CHANGED} AND EXCLUDED.embedding IS NULL THEN NULL
           WHEN content_chunks.embedded_content_revision IS DISTINCT FROM content_chunks.content_revision THEN EXCLUDED.embedded_at
           WHEN content_chunks.embedding IS NULL AND EXCLUDED.embedding IS NOT NULL THEN EXCLUDED.embedded_at
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN EXCLUDED.embedded_at
           ELSE content_chunks.embedded_at
         END,
         embedded_content_revision = CASE
           WHEN ${PRIMARY_EMBEDDING_INPUT_CHANGED}
             THEN CASE WHEN EXCLUDED.embedding IS NULL THEN NULL ELSE content_chunks.content_revision + 1 END
           WHEN content_chunks.embedded_content_revision IS DISTINCT FROM content_chunks.content_revision
             THEN CASE WHEN EXCLUDED.embedding IS NULL THEN NULL ELSE content_chunks.content_revision END
           WHEN content_chunks.embedding IS NULL AND EXCLUDED.embedding IS NOT NULL THEN content_chunks.content_revision
           WHEN EXCLUDED.embedded_at IS NOT NULL
                AND (content_chunks.embedded_at IS NULL OR EXCLUDED.embedded_at > content_chunks.embedded_at)
                THEN content_chunks.content_revision
           ELSE content_chunks.embedded_content_revision
         END`;

/** Forward-reference bootstrap needed before the static schema blob replays. */
export const CHUNK_CONTENT_REVISION_BOOTSTRAP_SQL = `
        ALTER TABLE content_chunks
          ADD COLUMN IF NOT EXISTS content_revision BIGINT NOT NULL DEFAULT 1;
        ALTER TABLE content_chunks
          ADD COLUMN IF NOT EXISTS embedded_content_revision BIGINT DEFAULT 1;
        ALTER TABLE content_chunks
          ALTER COLUMN embedded_content_revision DROP DEFAULT;
`;
