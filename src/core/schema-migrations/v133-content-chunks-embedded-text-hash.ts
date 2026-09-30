import type { Migration } from './types.ts';

export const v133: Migration = {
  version: 133,
  name: 'content_chunks_embedded_text_hash',
  // #4246: per-chunk embed-time content revision. upsertChunks stamps
  // md5(chunk_text) whenever an embedding lands; a later text rewrite that
  // keeps the vector is then detectable (embedded_text_hash <> md5(chunk_text))
  // and invalidateContentDriftEmbeddings NULLs it into the existing
  // embed-stale cursor. Deliberately NO backfill: hashing existing rows
  // would assert "this vector matches this text" for rows where that is
  // exactly what's in question, and treating NULL as stale would force a
  // corpus-wide re-embed spike on upgrade. NULL is grandfathered (heal-
  // forward); each row picks up its hash on its next re-embed. No index:
  // the column is only scanned by the invalidation sweep inside embed
  // runs (bootstrap-coverage: column-only, no probe needed). Keep in sync
  // with src/schema.sql (regenerate schema-embedded.ts via build:schema)
  // and src/core/pglite-schema.ts.
  idempotent: true,
  sql: `
      ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedded_text_hash TEXT;
    `,
};
