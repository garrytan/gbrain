import type { Migration } from './types.ts';

export const v135: Migration = {
  version: 135,
  name: 'facts_event_time_index',
  // Event-time recall (FactListOpts.eventTime) filters and orders on
  // COALESCE(valid_from, created_at), which the created_at index at v40
  // (idx_facts_since) cannot serve. Without a matching expression index
  // the common `recall` shape — epoch cutoff, no entity, ORDER BY … LIMIT n
  // — degrades from an index scan that stops at n rows into a full scan of
  // the source plus a sort. Mirrors idx_facts_since's shape (same leading
  // column, same partial predicate) so the two paths cost the same.
  idempotent: true,
  sql: `
      CREATE INDEX IF NOT EXISTS idx_facts_since_event_time
        ON facts (source_id, (COALESCE(valid_from, created_at)) DESC)
        WHERE expired_at IS NULL;
    `,
};
