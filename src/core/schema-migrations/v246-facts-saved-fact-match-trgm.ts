import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

/**
 * Index the saved-fact match that `search` and `query` run on every call
 * (`matchingSavedFacts` in ops/search.ts, #6721). It keeps the active facts
 * whose lowercased text and entity slug contain any of the query's words
 * (`lower(fact || ' ' || COALESCE(entity_slug, '')) LIKE ANY(...)`).
 * Unindexed, that is a scan of every fact row that lowercases and searches
 * each text once per word: about 130 ms of a 143 ms statement at 37,000
 * facts on Postgres. A trigram index on the same expression (pg_trgm already
 * backs idx_pages_trgm) turns each word into a bitmap index scan. The
 * predicate is unchanged, so the same rows come back; the index expression
 * must stay identical to the query's for the planner to use it. Deliberately
 * not partial: Postgres keeps statistics for an index expression but ignores
 * them for a partial index, and without them it estimated 452 rows for a
 * match of 7,540 and planned the visibility joins around that (about 270 ms
 * against 55-65 ms). Whole-table, ANALYZE gives the planner the
 * expression's real distribution (estimate 7,524), at the same size
 * (expired facts are a fraction of a percent).
 * Postgres builds it CONCURRENTLY after dropping an INVALID leftover; PGLite
 * builds it inline.
 */
export const FACTS_MATCH_TRGM_INDEX = {
  name: 'idx_facts_match_trgm',
  table: 'facts',
  sql: `CREATE INDEX IF NOT EXISTS idx_facts_match_trgm ON facts
    USING GIN (lower(fact || ' ' || COALESCE(entity_slug, '')) gin_trgm_ops)`,
} as const;

export const v246: Migration = {
  version: 246,
  name: 'facts_saved_fact_match_trgm',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 246, FACTS_MATCH_TRGM_INDEX, { notice: migrationNotice });
  },
};
