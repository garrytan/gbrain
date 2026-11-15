import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #8859 follow-up: a page purge and the retention expiry of a deleted page also take the facts extracted from the page
// and filed on none, matched by the head of their context (contextHeadSql, facts/gone-page-facts.ts). Unindexed, each
// purged page scanned every fact of its source, and `gbrain repair purged-page-facts` and its doctor check scan them
// too. idx_facts_context_head indexes the md5 of that expression for the rows filed on no page, the only rows the
// match reads; the md5 keeps the key bounded, since a context is unbounded text and need not hold a separator.
// Postgres builds it CONCURRENTLY outside the migration transaction (a handler); PGLite builds inline. Nothing is
// rewritten. No schema.sql mirror, like v237.
export const v315: Migration = {
  version: 315,
  name: 'facts_context_head_index',
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    await buildIndexOnline(engine, 315, { name: 'idx_facts_context_head', table: 'facts',
      sql: "CREATE INDEX IF NOT EXISTS idx_facts_context_head ON facts (source_id, md5(split_part(context, ' — ', 1))) WHERE source_markdown_slug IS NULL" }, { notice: migrationNotice });
  },
};
