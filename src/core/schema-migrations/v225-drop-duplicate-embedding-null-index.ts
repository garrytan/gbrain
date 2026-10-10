import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// v66's idx_chunks_embedding_null and v103's content_chunks_stale_idx are the
// same partial btree, `ON content_chunks (page_id, chunk_index) WHERE embedding
// IS NULL`, and v134 re-creates both. Every chunk insert, and every embedding
// write that clears or sets the vector, maintained two identical index entries.
// schema.sql and the PGLite schema carry content_chunks_stale_idx, so it stays;
// the planner treats the two as interchangeable for `embed --stale`.
//
// The duplicate is dropped only while content_chunks_stale_idx is valid and has
// the same definition, so a failed concurrent build or an operator's redefined
// index never leaves the stale scan without its index.
// CONCURRENTLY on Postgres (the handler runs outside a transaction), inline
// on PGLite. runSchemaTransition replays whichever indexes depend on the
// embedding column, so a later dimension change does not bring it back.
export const v225: Migration = {
  version: 225,
  name: 'drop_duplicate_embedding_null_index',
  idempotent: true,
  sql: '',
  handler: async engine => {
    const [dup] = await engine.executeRaw<{ same: boolean }>(
      `SELECT regexp_replace(pg_get_indexdef(d.indexrelid), '^CREATE INDEX \\S+ ', '')
              = regexp_replace(pg_get_indexdef(k.indexrelid), '^CREATE INDEX \\S+ ', '') AS same
         FROM pg_index d, pg_index k
        WHERE d.indexrelid = to_regclass('idx_chunks_embedding_null')
          AND k.indexrelid = to_regclass('content_chunks_stale_idx')
          AND k.indisvalid AND k.indisready`);
    if (!dup?.same) return;
    await engine.runMigration(225, `DROP INDEX ${engine.kind === 'postgres' ? 'CONCURRENTLY ' : ''}IF EXISTS idx_chunks_embedding_null;`);
  },
};
