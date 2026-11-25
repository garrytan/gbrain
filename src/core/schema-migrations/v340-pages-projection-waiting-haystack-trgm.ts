import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';
import { ACTIVATION_SERVED_REVISION } from '../search/safe-chunks.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Search coverage counts the pages waiting for indexing that could affect a query, and a query word counts when it
// is a whole token of `lower(title || ' ' || slug)` (engine-sql/retrieval-coverage.ts `countInScope`). The count
// is exact up to its cap: every waiting page in scope is checked, not the first 1000 an engine happens to read, so
// the answer no longer depends on the order pages were written in. Without an index each check is a regex over every
// waiting page in scope. This trigram index over that text, on the waiting pages only (idx_pages_projection_waiting's
// predicate, so it is empty once indexing catches up), lets Postgres find the few pages a word matches through the
// index.
//
// `fastupdate = off`: a page written after the build goes straight into the index, not into a pending list that
// each read scans in full until a vacuum (with it on, the planner priced the index above a scan of every waiting
// page and tested them all). Every page write already updates the waiting set's partial index (v317), so this adds
// the trigram entries of one title and slug per write.
//
// Postgres builds it CONCURRENTLY outside a transaction, after dropping an INVALID leftover; PGLite builds it inline.
// No schema.sql mirror, like v317 and v339. DDL only; nothing is rewritten.
export const PAGES_PROJECTION_WAITING_WORDS_INDEX = {
  name: 'idx_pages_projection_waiting_words',
  table: 'pages',
  sql: `CREATE INDEX IF NOT EXISTS idx_pages_projection_waiting_words ON pages
        USING GIN ((lower(COALESCE(title, '') || ' ' || slug)) gin_trgm_ops) WITH (fastupdate = off)
        WHERE deleted_at IS NULL AND text_projection_revision IS DISTINCT FROM knowledge_revision
          AND text_projection_revision IS DISTINCT FROM '${ACTIVATION_SERVED_REVISION}'::uuid`,
} as const;

export const v340: Migration = {
  version: 340,
  name: 'pages_projection_waiting_haystack_trgm',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 340, PAGES_PROJECTION_WAITING_WORDS_INDEX, { notice: migrationNotice });
  },
};
