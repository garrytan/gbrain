import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v066: Migration = {
  version: 66,
  name: 'embed_stale_partial_index',
  // Renumbered v58→v59→v60→v66 across merge waves:
  //   - v58 was taken by master's v0.33.3 edges_backfilled_at.
  //   - v59 was taken by master's v0.34.0 code_traversal_cache.
  //   - v60-v65 were taken by master's v0.34.1 oauth_clients source-isolation cluster.
  // All landed before this branch could ship.
  //
  // Partial index for `embedding IS NULL` on content_chunks.
  //
  // The `embed --stale` command scans for chunks missing embeddings.
  // Without this index, the query does a full table scan of 300K+ rows
  // to find the ~48K NULLs, taking >2 min and hitting Supabase's
  // statement_timeout. With the partial index, the scan is instant.
  //
  // Also used by countStaleChunks() for the pre-flight check.
  //
  // Engine-aware via handler (mirrors v14): Postgres uses
  // CREATE INDEX CONCURRENTLY to avoid the ShareLock on `content_chunks`
  // that a plain CREATE INDEX takes for the duration of the build.
  // On a 373K-row table this lock blocks every concurrent write (sync,
  // embed, autopilot). CONCURRENTLY refuses to run inside a transaction
  // AND postgres.js's multi-statement `.unsafe()` wraps in an implicit
  // transaction, so each statement runs as a separate call. A failed
  // CONCURRENTLY leaves an invalid index with the target name; the
  // handler pre-drops any invalid remnant via pg_index.indisvalid.
  // PGLite has no concurrent writers, so plain CREATE is safe.
  idempotent: true,
  sql: '',
  handler: async (engine) => {
    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 66, 'idx_chunks_embedding_null');
      await engine.runMigration(
        66,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chunks_embedding_null
             ON content_chunks (page_id, chunk_index)
             WHERE embedding IS NULL;`
      );
    } else {
      await engine.runMigration(
        66,
        `CREATE INDEX IF NOT EXISTS idx_chunks_embedding_null
             ON content_chunks (page_id, chunk_index)
             WHERE embedding IS NULL;`
      );
    }
  },
};
