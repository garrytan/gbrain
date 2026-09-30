import type { Migration } from './types.ts';
import { dropInvalidConcurrentIndex } from './helpers.ts';

export const v104: Migration = {
  version: 104,
  name: 'pages_atom_source_hash_idx',
  // Partial expression index on frontmatter->>'source_hash' for atom
  // rows. Powers `atomsExistingForHashes` in extract_atoms
  // (src/core/cycle/extract-atoms.ts), which replaces the prior
  // per-hash loop that did 7K SQL round trips per cycle on a brain
  // with ~7K conversation transcripts.
  //
  // Mirrors v97 pattern: Postgres uses CREATE INDEX CONCURRENTLY
  // (no SHARE-lock blocking concurrent writes) and pre-drops any
  // invalid remnant from a prior failed CONCURRENTLY attempt via
  // pg_index.indisvalid. PGLite uses plain CREATE INDEX.
  transaction: false,
  sql: '',
  handler: async (engine) => {
    if (engine.kind === 'postgres') {
      await dropInvalidConcurrentIndex(engine, 104, 'pages_atom_source_hash_idx');
      await engine.runMigration(
        104,
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS pages_atom_source_hash_idx
             ON pages ((frontmatter->>'source_hash'))
             WHERE type = 'atom' AND deleted_at IS NULL;`
      );
    } else {
      await engine.runMigration(
        104,
        `CREATE INDEX IF NOT EXISTS pages_atom_source_hash_idx
             ON pages ((frontmatter->>'source_hash'))
             WHERE type = 'atom' AND deleted_at IS NULL;`
      );
    }
  },
};
