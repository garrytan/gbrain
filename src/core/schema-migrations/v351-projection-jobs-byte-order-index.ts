import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// The projection queue's walks (the resident window in projection-window.ts and its engine copy in
// engine-sql/persistence-housekeeping.ts, the drain in projections.ts, the image seal in image-seal.ts)
// compare and order `slug COLLATE "C"`, so every engine visits jobs in byte order. The only index on
// page_projection_jobs is its primary key (source_incarnation, slug) in the database's default
// collation, which cannot serve a "C" comparison when that collation is a language rule (en_US.utf8):
// each walk then read and sorted the whole queue. This index serves them. Postgres builds it
// CONCURRENTLY outside a transaction, after dropping an INVALID leftover; PGLite builds it inline.
// No schema.sql mirror, like v291, v316 and v317: existing brains replay the schema blob before
// migrations, and a blob index would be built without CONCURRENTLY on a large queue. DDL only.
export const PAGE_PROJECTION_JOBS_BYTE_ORDER_INDEX = {
  name: 'idx_page_projection_jobs_slug_c',
  table: 'page_projection_jobs',
  sql: 'CREATE INDEX IF NOT EXISTS idx_page_projection_jobs_slug_c ON page_projection_jobs (source_incarnation, slug COLLATE "C")',
} as const;

export const v351: Migration = {
  version: 351,
  name: 'projection_jobs_byte_order_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 351, PAGE_PROJECTION_JOBS_BYTE_ORDER_INDEX, { notice: migrationNotice });
  },
};
