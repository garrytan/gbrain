import type { Migration } from './types.ts';

export const v171: Migration = {
  version: 171,
  name: 'content_chunks_embedding_input_hash',
  // #5553: per-chunk embedding-input provenance, written in the same
  // statement as the vector (src/core/embedding-input-hash.ts). A projection
  // rebuild keeps a vector only when the stored hash equals the recomputed
  // one. Same shape as v133 and v166's fact provenance: nullable, no
  // backfill (a hash cannot be proven for an existing vector), no index
  // (read only per page during a rebuild; bootstrap-coverage: column-only).
  // NULL on a contextual page is nulled once and stamped by its re-embed.
  // Keep in sync with src/schema.sql (regenerate schema-embedded.ts via
  // build:schema) and src/core/pglite-schema.ts.
  idempotent: true,
  sql: `
      ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_input_hash TEXT;
    `,
};
