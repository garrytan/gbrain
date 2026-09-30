import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v134: Migration = {
  version: 134,
  name: 'restore_chunks_embedding_null_partial_indexes',
  // #4252 heal: `migrate embeddings` rebuilt content_chunks.embedding via
  // DROP COLUMN, which cascade-dropped the `embedding IS NULL` partial
  // indexes (v66 idx_chunks_embedding_null, v103 content_chunks_stale_idx)
  // without recreating them. runSchemaTransition now captures + replays
  // dependent indexes, but brains that already ran a transition lost both
  // permanently — v66/v103 are recorded as applied, so their IF NOT EXISTS
  // never re-runs. Re-issue both defs; a no-op everywhere else.
  // Engine-aware split mirrors v103: Postgres uses CREATE INDEX
  // CONCURRENTLY + invalid-remnant pre-drop; PGLite plain CREATE INDEX.
  transaction: false,
  sql: '',
  handler: async (engine) => {
    const defs: Array<[string, string]> = [
      ['idx_chunks_embedding_null', `ON content_chunks (page_id, chunk_index) WHERE embedding IS NULL;`],
      ['content_chunks_stale_idx', `ON content_chunks (page_id, chunk_index) WHERE embedding IS NULL;`],
    ];
    for (const [name, tail] of defs) {
      if (engine.kind === 'postgres') {
        await dropInvalidConcurrentIndex(engine, 134, name);
        await engine.runMigration(
          134,
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ${tail}`
        );
      } else {
        await engine.runMigration(
          134,
          `CREATE INDEX IF NOT EXISTS ${name} ${tail}`
        );
      }
    }
  },
};
