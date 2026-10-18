import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Large pages switch-on flip: the default worktree recovery budget
// (page-body/limits.ts pageRecoveryBytes, read by persistence/limits.ts
// readJournalLimits on every journal limit read) leaves room for the largest
// page already stored in segments, so a page stored while the switch was on
// stays deletable, restorable and mirrorable after the switch goes off or
// pages.max_bytes is lowered. pages_segmented_body_bytes_idx answers
// max(body_bytes) over segmented pages with one probe from its upper end, and
// stays as small as the set of segmented pages (only pages over 1 MiB). Soft-
// deleted pages stay in it: a restore brings them back. Built online
// (CONCURRENTLY on Postgres); an interrupted build leaves an INVALID index that
// the next initSchema drops and rebuilds.
export const PAGES_SEGMENTED_BODY_BYTES_INDEX = {
  name: 'pages_segmented_body_bytes_idx',
  table: 'pages',
  sql: "CREATE INDEX IF NOT EXISTS pages_segmented_body_bytes_idx ON pages (body_bytes) WHERE body_storage = 'segmented'",
};

export const v260: Migration = {
  version: 260,
  name: 'segmented_page_size_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 260, PAGES_SEGMENTED_BODY_BYTES_INDEX, { notice: migrationNotice });
  },
};
