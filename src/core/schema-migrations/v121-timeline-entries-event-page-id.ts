import type { Migration } from './types.ts';

export const v121: Migration = {
  version: 121,
  name: 'timeline_entries_event_page_id',
  // v0.42.x — Life Chronicle (#2390): the event→timeline projection pointer.
  // A `type:event` page projects ONE date-index row into timeline_entries
  // keyed to the depth/meeting page (page_id), with event_page_id pointing at
  // the event page itself. Additive + idempotent: nullable FK + partial
  // indexes; legacy rows keep event_page_id NULL so existing behavior is
  // unchanged. The partial UNIQUE(event_page_id, date) makes re-extraction
  // with a changed summary an UPDATE (not a duplicate). FK added via a guarded
  // DO block (mirrors the facts_source_id_fkey pattern) so the ALTER is a
  // no-op on re-runs. Mirrored in src/schema.sql, src/core/pglite-schema.ts,
  // and the generated src/core/schema-embedded.ts for fresh installs.
  idempotent: true,
  sql: `
      ALTER TABLE timeline_entries ADD COLUMN IF NOT EXISTS event_page_id INTEGER;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'timeline_entries_event_page_id_fkey'
             AND conrelid = 'timeline_entries'::regclass
        ) THEN
          ALTER TABLE timeline_entries
            ADD CONSTRAINT timeline_entries_event_page_id_fkey
            FOREIGN KEY (event_page_id) REFERENCES pages(id) ON DELETE CASCADE;
        END IF;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_timeline_event_page
        ON timeline_entries(event_page_id) WHERE event_page_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_event_dedup
        ON timeline_entries(event_page_id, date) WHERE event_page_id IS NOT NULL;
    `,
};
