import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v034: Migration = {
  version: 34,
  name: 'destructive_guard_columns',
  // v0.26.5 — soft-delete + recovery window for sources AND pages.
  // Renumbered v33→v34 on master merge: master's v33 (admin_dashboard_columns_v0_26_3)
  // landed first in PR #586. v34 follows it.
  //
  // pages.deleted_at: `delete_page` op now sets deleted_at = now() instead of
  // hard-deleting. The autopilot purge phase hard-deletes rows where
  // deleted_at < now() - 72h. Search and `get_page` filter
  // `WHERE deleted_at IS NULL` by default; `include_deleted: true` opts in.
  //
  // sources.archived/archived_at/archive_expires_at: promoted from JSONB keys
  // to real columns. v0.26.0 + the cherry-picked PR #595 wrote these inside
  // `sources.config` JSONB. Real columns are faster to filter, avoid the
  // reserved-key footgun, and let the search visibility filter compile to a
  // column lookup. The 72h TTL is preserved by reading
  // `archive_expires_at = archived_at + INTERVAL '72 hours'`.
  //
  // Backfill: any row that previously stored `{"archived":true,"archived_at":"...","archive_expires_at":"..."}`
  // in config gets migrated to the new columns, then the keys are stripped
  // from JSONB so the JSONB shape stays canonical going forward.
  //
  // Engine-aware partial index: Postgres uses CREATE INDEX CONCURRENTLY (no
  // write-blocking lock); PGLite uses plain CREATE INDEX. Mirrors v14
  // (pages_updated_at_index) handler shape.
  sql: '',
  handler: async (engine) => {
    // 1. Add columns. ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent on
    //    both engines.
    await engine.runMigration(34, `
        ALTER TABLE pages   ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived           BOOLEAN     NOT NULL DEFAULT false;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived_at        TIMESTAMPTZ;
        ALTER TABLE sources ADD COLUMN IF NOT EXISTS archive_expires_at TIMESTAMPTZ;
      `);

    // 2. Backfill from JSONB shape used by pre-v0.26.5 cherry-picks of PR #595.
    //    Idempotent: subsequent re-runs find zero matching rows.
    await engine.runMigration(34, `
        UPDATE sources
        SET archived = true,
            archived_at = COALESCE((config->>'archived_at')::timestamptz, now()),
            archive_expires_at = COALESCE(
              (config->>'archive_expires_at')::timestamptz,
              COALESCE((config->>'archived_at')::timestamptz, now()) + INTERVAL '72 hours'
            )
        WHERE config ? 'archived'
          AND (config->>'archived')::boolean = true
          AND archived = false;
      `);
    await engine.runMigration(34, `
        UPDATE sources
        SET config = config - 'archived' - 'archived_at' - 'archive_expires_at'
        WHERE config ?| ARRAY['archived', 'archived_at', 'archive_expires_at'];
      `);

    // 3. Partial index for the autopilot purge sweep. Postgres CONCURRENTLY
    //    avoids the SHARE lock on `pages`; PGLite has no concurrent writers.
    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 34, 'pages_deleted_at_purge_idx');
      await engine.runMigration(34, `
          CREATE INDEX CONCURRENTLY IF NOT EXISTS pages_deleted_at_purge_idx
            ON pages (deleted_at) WHERE deleted_at IS NOT NULL;
        `);
    } else {
      await engine.runMigration(34, `
          CREATE INDEX IF NOT EXISTS pages_deleted_at_purge_idx
            ON pages (deleted_at) WHERE deleted_at IS NOT NULL;
        `);
    }
  },
  // CONCURRENTLY on Postgres requires no surrounding transaction. PGLite ignores
  // this flag, so the index DDL runs in whatever wrapper applies.
  transaction: false,
};
