import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Embedding backlog age: `embedding_pending_since` is when a chunk's stored
// vector (the active embedding column) last became missing. Every site that
// NULLs the vector or inserts a chunk without one sets it, and every vector
// write clears it beside `embedded_at`. The doctor `embeddings` check reads it
// instead of `created_at`, which an edit or a model-swap invalidation never
// resets. Nullable with no default: metadata-only on Postgres 11+ and PGLite.
// Not in schema.sql's CREATE TABLE: this migration adds it on every install,
// after the migration-added content_chunks columns, so fresh and upgraded
// brains share column ordinals (the v180 pattern). No index: only doctor reads
// it, over the chunks already missing a vector (bootstrap-coverage:
// column-only, no probe needed).
//
// BACKFILL: chunks already missing a vector get their `created_at` once,
// because nothing recorded when their vector went missing. The active column
// is `search_embedding_column` when it names an existing column, else
// `embedding`. When any row was backfilled, config
// `embedding_pending_since_backfilled_at` records when, so doctor labels an
// age older than that stamp as a created_at backfill.
export const v221: Migration = {
  version: 221,
  name: 'chunk_embedding_pending_since',
  idempotent: true,
  sql: `
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_pending_since TIMESTAMPTZ;
    DO $backfill$
    DECLARE active_column text; backfilled bigint;
    BEGIN
      SELECT c.column_name INTO active_column
        FROM config k
        JOIN information_schema.columns c
          ON c.table_schema = current_schema() AND c.table_name = 'content_chunks' AND c.column_name = k.value
       WHERE k.key = 'search_embedding_column';
      EXECUTE format('UPDATE content_chunks SET embedding_pending_since = created_at
                       WHERE %I IS NULL AND embedding_pending_since IS NULL', COALESCE(active_column, 'embedding'));
      GET DIAGNOSTICS backfilled = ROW_COUNT;
      IF backfilled > 0 THEN
        INSERT INTO config (key, value) VALUES ('embedding_pending_since_backfilled_at', now()::text)
          ON CONFLICT (key) DO NOTHING;
      END IF;
    END $backfill$;
  `,
};
