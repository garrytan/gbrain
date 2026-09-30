import type { Migration } from './types.ts';

export const v009: Migration = {
  version: 9,
  name: 'timeline_dedup_index',
  // Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS handles fresh + upgrade.
  // Dedup any existing duplicates first so the index can be created.
  // Helper btree turns the DELETE...USING self-join from O(n²) into O(n log n).
  // Without it, a brain with 80K+ duplicate timeline rows hits Supabase
  // Management API's 60s ceiling. See migration v8 for the same pattern.
  sql: `
      CREATE INDEX IF NOT EXISTS idx_timeline_dedup_helper
        ON timeline_entries(page_id, date, summary);
      DELETE FROM timeline_entries a USING timeline_entries b
        WHERE a.page_id = b.page_id
          AND a.date = b.date
          AND a.summary = b.summary
          AND a.id > b.id;
      DROP INDEX IF EXISTS idx_timeline_dedup_helper;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup
        ON timeline_entries(page_id, date, summary);
    `,
};
