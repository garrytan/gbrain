import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v172: Migration = {
  version: 172, name: 'pages_safe_chunk_pending_index', idempotent: true, transaction: false, sql: '',
  // #5050/#5247: the safe_index_pending probe (ops/search.ts) runs on every
  // remote search and now counts pages of every kind below the safe-chunk
  // fence, so the markdown-only partial pages_chunker_version_idx no longer
  // serves it. This partial index holds only unsealed pages (empty on a
  // sealed brain). The literal 4 is SAFE_FENCE_CHUNKER_VERSION when this
  // migration shipped; a later fence bump needs its own index.
  handler: async engine => {
    if (engine.kind === 'postgres') await dropInvalidConcurrentIndex(engine, 172, 'pages_safe_chunk_pending_idx');
    await engine.runMigration(172, `CREATE INDEX ${engine.kind === 'postgres' ? 'CONCURRENTLY ' : ''}IF NOT EXISTS pages_safe_chunk_pending_idx
        ON pages (source_id) WHERE chunker_version < 4`);
  },
};
