import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v097: Migration = {
  version: 97,
  name: 'pages_dedup_partial_index',
  // v0.41.13 (#1309) — partial index for findDuplicatePage's hot path.
  //
  // Codex review of the original plan caught "no new index is hand-wavy":
  // findDuplicatePage runs once per imported file. On a 100K-page brain
  // syncing thousands of files, an unindexed sequential scan per
  // invocation is O(n²) on import wallclock.
  //
  // Partial index excludes soft-deleted rows so the same-source dedup
  // path (which already filters `deleted_at IS NULL`) gets an index-only
  // scan. Composite key matches the WHERE clause shape.
  //
  // Postgres-only: PGLite has no concurrent writers, so the engine-wide
  // SHARE lock that motivates CONCURRENTLY doesn't apply. PGLite
  // re-uses plain CREATE INDEX via the `sqlFor.pglite` branch.
  //
  // The Postgres path uses CREATE INDEX CONCURRENTLY (with `transaction:
  // false` so postgres.js doesn't wrap an implicit BEGIN) and pre-drops
  // any invalid remnant from a prior failed CONCURRENTLY attempt.
  sql: '',
  transaction: false,
  handler: async (engine) => {
    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 97, 'pages_dedup_idx');
      await engine.runMigration(
        97,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS pages_dedup_idx
             ON pages (source_id, content_hash)
             WHERE deleted_at IS NULL;`
      );
    } else {
      await engine.runMigration(
        97,
        `CREATE INDEX IF NOT EXISTS pages_dedup_idx
             ON pages (source_id, content_hash)
             WHERE deleted_at IS NULL;`
      );
    }
  },
};
