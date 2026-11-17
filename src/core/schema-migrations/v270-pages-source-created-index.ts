import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #7379: `gbrain facts relink --conversation` and doctor `unlinked_facts` re-arm an
// unmemoized miss when a live page was created in the fact's source after the
// attempt (facts/conversation-memo.ts conversationTriedSql:
// `EXISTS (SELECT 1 FROM pages np WHERE np.source_id = f.source_id AND
// np.deleted_at IS NULL AND np.created_at > a.attempted_at)`). The probe runs
// once per attempt row, and no pages index covered created_at, so each probe
// read every live page of the source: a few thousand attempts over a large
// brain hit statement_timeout, dry run included. This partial index answers
// each probe with one descent. Built online (CONCURRENTLY on Postgres); an
// interrupted build leaves an INVALID index that the next initSchema drops and
// rebuilds. Not in schema.sql: Postgres initSchema replays that blob before
// migrations, which would build the index as a plain, write-blocking CREATE
// INDEX on every upgrading brain.
export const PAGES_SOURCE_CREATED_INDEX = {
  name: 'pages_source_created_idx',
  table: 'pages',
  sql: 'CREATE INDEX IF NOT EXISTS pages_source_created_idx ON pages (source_id, created_at) WHERE deleted_at IS NULL',
};

export const v270: Migration = {
  version: 270,
  name: 'pages_source_created_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 270, PAGES_SOURCE_CREATED_INDEX, { notice: migrationNotice });
  },
};
