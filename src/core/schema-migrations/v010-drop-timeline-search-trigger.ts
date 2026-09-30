import type { Migration } from './types.ts';

export const v010: Migration = {
  version: 10,
  name: 'drop_timeline_search_trigger',
  // Removes the trigger that updates pages.updated_at on every timeline_entries insert.
  // Structured timeline_entries are now graph data (queryable dates), not search text.
  // pages.timeline (markdown) still feeds the page search_vector via trg_pages_search_vector.
  // Removing this trigger also fixes a mutation-induced reordering bug in timeline-extract
  // pagination (listPages ORDER BY updated_at DESC drifted as inserts touched pages).
  sql: `
      DROP TRIGGER IF EXISTS trg_timeline_search_vector ON timeline_entries;
      DROP FUNCTION IF EXISTS update_page_search_vector_from_timeline();
    `,
};
