import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Doctor `type_proliferation` reads the distinct (source, type) pairs of live typed pages. With only single-column
// indexes on source_id and type, every way to read those pairs visits every page row, which took over 20 s on a
// large brain. idx_pages_source_type lets the check walk the pairs with one index probe each (a skip scan,
// checkTypeProliferation). Postgres builds it CONCURRENTLY outside the migration transaction (a handler); PGLite
// builds inline. Nothing is rewritten. No schema.sql mirror, like v315.
export const v316: Migration = {
  version: 316,
  name: 'pages_source_type_index',
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    await buildIndexOnline(engine, 316, { name: 'idx_pages_source_type', table: 'pages',
      sql: 'CREATE INDEX IF NOT EXISTS idx_pages_source_type ON pages (source_id, type) WHERE deleted_at IS NULL' }, { notice: migrationNotice });
  },
};
