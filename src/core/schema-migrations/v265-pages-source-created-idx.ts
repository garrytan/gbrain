import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// `gbrain facts relink --conversation` re-arms a miss recorded in
// fact_relink_attempts when a newer live page exists in the fact's source
// (facts/conversation-memo.ts conversationTriedSql:
// `EXISTS (SELECT 1 FROM pages np WHERE np.source_id = f.source_id AND
// np.deleted_at IS NULL AND np.created_at > a.attempted_at)`). That subquery
// runs once per attempt row and no pages index covers created_at, so each probe
// scanned all of pages: 2,833 attempt rows over 116k pages hit a 300 s
// statement_timeout, dry run included. pages_source_created_idx answers each
// probe with one index descent, and the same statement ran in 0.6 s. Partial on
// deleted_at IS NULL to match the probe, so soft-deleted pages stay out of it.
// Built online (CONCURRENTLY on Postgres); an interrupted build leaves an
// INVALID index that the next initSchema drops and rebuilds. Not repeated in
// schema.sql: an existing brain replays that blob before migrations, which would
// build the index without CONCURRENTLY.
export const PAGES_SOURCE_CREATED_INDEX = {
  name: 'pages_source_created_idx',
  table: 'pages',
  sql: 'CREATE INDEX IF NOT EXISTS pages_source_created_idx ON pages (source_id, created_at) WHERE deleted_at IS NULL',
};

export const v265: Migration = {
  version: 265,
  name: 'pages_source_created_idx',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 265, PAGES_SOURCE_CREATED_INDEX, { notice: migrationNotice });
  },
};
