import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-156: the title arm's title-only predicate (remote callers and every OR
// re-run, engine-sql/titles.ts) matches the weight-A slice of
// pages.search_vector, which carries the title and only the title at weight A.
// idx_pages_search indexes the whole vector, and a GIN index cannot check a
// weight, so a term in timeline text (weight C) made its page a candidate that
// the heap recheck then threw away: at 600k pages about nine of every ten
// candidates of a typical OR re-run. This expression index holds only the
// title lexemes, so the predicate `ts_filter(search_vector, '{a}') @@ q` reads
// title matches alone. Built online (CONCURRENTLY on Postgres); an interrupted
// build leaves an INVALID index that the next initSchema drops and rebuilds.
export const PAGES_TITLE_SEARCH_INDEX = {
  name: 'idx_pages_title_search',
  table: 'pages',
  sql: "CREATE INDEX IF NOT EXISTS idx_pages_title_search ON pages USING GIN (ts_filter(search_vector, '{a}'))",
};

export const v267: Migration = {
  version: 267,
  name: 'pages_title_search_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 267, PAGES_TITLE_SEARCH_INDEX, { notice: migrationNotice });
  },
};
