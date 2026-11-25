import type { Migration } from './types.ts';
import { PERSISTENCE_REQUEST_SLUG_BYTE_ORDER_INDEX } from '../persistence/schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// The per-source slug walks compare and order `slug COLLATE "C"`, so every engine lists pages in byte order: the
// listPages slug keyset, the reconcile audit walk, the duplicate-entity stubs, the doctor slug sample, and the
// drift-conflict audit over the request table. The only slug indexes on pages and persistence_requests use the
// database's default collation, which cannot serve a "C" comparison when that collation is a language rule
// (en_US.utf8): each walk then read and sorted the whole source. These two indexes serve them. `source_id` keeps the
// default collation, because the walks compare it with `=` in that collation. Postgres builds each CONCURRENTLY outside
// a transaction, one statement per call, after dropping an INVALID leftover; PGLite builds them inline. No schema.sql
// mirror for the pages index, like v291, v316, v317 and v326: existing brains replay the schema blob before migrations,
// and a blob index would be built without CONCURRENTLY on a large table. DDL only.
export const PAGES_SOURCE_SLUG_BYTE_ORDER_INDEX = {
  name: 'idx_pages_source_slug_c',
  table: 'pages',
  sql: 'CREATE INDEX IF NOT EXISTS idx_pages_source_slug_c ON pages (source_id, slug COLLATE "C")',
} as const;

export const v338: Migration = {
  version: 338,
  name: 'byte_order_slug_indexes',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 338, PAGES_SOURCE_SLUG_BYTE_ORDER_INDEX, { notice: migrationNotice });
    await buildIndexOnline(engine, 338, PERSISTENCE_REQUEST_SLUG_BYTE_ORDER_INDEX, { notice: migrationNotice });
  },
};
