import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); the fresh-install
// copy of the table in src/schema.sql carries the same column.
export const v341: Migration = {
  version: 341,
  name: 'atom_scan_input_digest',
  // #10435 / #10332: a complete page scan records the digest of the exact text
  // the model read (`input_sha256`: the page body as a remote caller sees it,
  // withdrawn and held rows left out, keyed by the extractor version). A new
  // content_hash whose model input hashes the same (a fence-only edit, a
  // frontmatter tweak) reuses the earlier atoms instead of paying for another
  // model call. NULL on failed and partial rows and on rows written before
  // this column existed. DDL only: a metadata-only ADD COLUMN under
  // migrate.ts's lock timeout, no row rewritten, nothing to backfill.
  idempotent: true,
  sql: `
    ALTER TABLE extract_atoms_page_state
      ADD COLUMN IF NOT EXISTS input_sha256 TEXT;
  `,
};
