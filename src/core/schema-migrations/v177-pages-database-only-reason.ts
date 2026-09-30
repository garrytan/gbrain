import type { Migration } from './types.ts';

export const v177: Migration = {
  // #5254: a page written database-only while its filesystem source had no
  // canonical owner (persistence.unbound_write=database_only) is stamped
  // 'unbound_source', so writes and sync after binding keep it database-only
  // instead of materializing or overwriting it. Nullable, no backfill (no
  // earlier binary could write such a page), no index (read per page; the
  // doctor count scans only non-NULL rows; bootstrap-coverage: column-only).
  // Keep in sync with src/schema.sql (regenerate schema-embedded.ts via
  // build:schema) and src/core/pglite-schema.ts.
  version: 177,
  name: 'pages_database_only_reason',
  idempotent: true,
  sql: `ALTER TABLE pages ADD COLUMN IF NOT EXISTS database_only_reason TEXT;`,
};
