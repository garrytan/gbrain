import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-217: page history carries why a page changed (docs/guides/page-history.md).
// - page_versions.change_reason: the reason for the write that replaced this
//   snapshot, mirrored from the write's Git trailer (`gbrain-reason: <path>: <text>`)
//   or, on a page that never reaches Git, the database's own record of it.
// - page_versions.successor_pruned: set on a retained snapshot whose next
//   snapshot was pruned, so a remote reader cannot check the successor's
//   visibility and is never shown the reason (fails closed).
// - pages.version_history_gap_at: when the page last lost history (a prune, or
//   a sync import that consumed more than one commit for its file).
// - reason_purge_tombstones: text-free (commit, path) pairs a purge found a
//   claim in, so a later sync or re-import never brings that reason back.
// Nullable columns, no backfill; existing rows are never re-stamped. Fresh
// installs get these from this migration too (not src/schema.sql), so fresh and
// upgraded brains share column ordinals. The number is a placeholder restamped
// at the merge slot.
export const v279: Migration = {
  version: 279,
  name: 'page_change_reasons',
  idempotent: true,
  sql: `
    ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS change_reason TEXT;
    ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS successor_pruned BOOLEAN;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS version_history_gap_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS reason_purge_tombstones (
      source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      commit_sha TEXT NOT NULL,
      path       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (source_id, commit_sha, path)
    );
    DO $rls$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
        ALTER TABLE reason_purge_tombstones ENABLE ROW LEVEL SECURITY;
      END IF;
    END $rls$;
  `,
};
