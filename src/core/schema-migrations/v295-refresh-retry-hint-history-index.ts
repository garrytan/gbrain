import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-1623: the worktree_refreshing retry hint (refresh-retry-hint.ts) reads a worktree's newest completed refreshes,
// newest first, inside write admission. Without an index it sorted every completed refresh of the worktree. The table
// holds one row per refresh, so a plain build is brief. Fresh installs get it from WORKTREE_REFRESH_SCHEMA_SQL. DDL only.
// The number is a placeholder restamped at the merge slot.
export const v295: Migration = {
  version: 295,
  name: 'refresh_retry_hint_history_index',
  idempotent: true,
  sql: `
    CREATE INDEX IF NOT EXISTS persistence_worktree_refreshes_completed
      ON persistence_worktree_refreshes(worktree_id, completed_at DESC) WHERE state='completed';
  `,
};
