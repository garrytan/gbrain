import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v014: Migration = {
  version: 14,
  name: 'pages_updated_at_index',
  // v0.14.1 (fix wave): fixes the 14.6s "list pages newest-first" seqscan on 31k+ row brains.
  // Original report: https://github.com/garrytan/gbrain/issues/170 (PR #215).
  //
  // Engine-aware via handler (not SQL): Postgres uses CREATE INDEX CONCURRENTLY
  // to avoid the write-blocking SHARE lock on `pages`. CONCURRENTLY refuses to
  // run inside a transaction AND postgres.js's multi-statement `.unsafe()` wraps
  // in an implicit transaction, so the handler runs each statement as a separate
  // call. A failed CONCURRENTLY leaves an invalid index with the target name;
  // the handler pre-drops any invalid remnant via pg_index.indisvalid. PGLite
  // has no concurrent writers, so plain CREATE is safe.
  sql: '',
  handler: async (engine) => {
    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 14, 'idx_pages_updated_at_desc');
      await engine.runMigration(
        14,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pages_updated_at_desc
             ON pages (updated_at DESC);`
      );
    } else {
      await engine.runMigration(
        14,
        `CREATE INDEX IF NOT EXISTS idx_pages_updated_at_desc
             ON pages (updated_at DESC);`
      );
    }
  },
};
