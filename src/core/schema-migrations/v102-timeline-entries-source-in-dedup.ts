import type { Migration } from './types.ts';

export const v102: Migration = {
  version: 102,
  name: 'timeline_entries_source_in_dedup',
  // v0.41.18.0 (gbrain onboard wave, A11 + codex finding #11):
  // Widen idx_timeline_dedup from (page_id, date, summary) to
  // (page_id, date, summary, source) so --from-meetings provenance
  // survives. Legacy rows have source='' (schema default), so legacy
  // dedup behavior is preserved.
  //
  // Slot history: originally v99, bumped to v102 after master merge.
  sql: `
      DROP INDEX IF EXISTS idx_timeline_dedup;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup
        ON timeline_entries(page_id, date, summary, source);
    `,
  sqlFor: {
    pglite: `
        DROP INDEX IF EXISTS idx_timeline_dedup;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup
          ON timeline_entries(page_id, date, summary, source);
      `,
  },
};
