import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';
import { ACTIVATION_SERVED_REVISION } from '../search/safe-chunks.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #9192: the search readiness probe asks whether any visible page is out of search, in idx_pages_projection_pending's
// order under LIMIT 1. A page v153 left serving its pre-upgrade index is in that index too, so while a large brain
// rebuilds, the probe stepped over every such page on every search (about 0.8 us each, about 0.5 s at 600k pages).
// idx_pages_projection_waiting holds only the pages out of search, so the walk stops at its first row and the index is
// empty once the rebuild finishes. Postgres builds it CONCURRENTLY outside the migration transaction (a handler);
// PGLite builds inline. Nothing is rewritten. No schema.sql mirror, like v316.
export const v317: Migration = {
  version: 317,
  name: 'pages_projection_waiting_index',
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    await buildIndexOnline(engine, 317, { name: 'idx_pages_projection_waiting', table: 'pages',
      sql: `CREATE INDEX IF NOT EXISTS idx_pages_projection_waiting ON pages (source_id, page_kind, slug)
        WHERE deleted_at IS NULL AND text_projection_revision IS DISTINCT FROM knowledge_revision
          AND text_projection_revision IS DISTINCT FROM '${ACTIVATION_SERVED_REVISION}'::uuid` }, { notice: migrationNotice });
  },
};
