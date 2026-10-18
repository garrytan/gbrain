import type { Migration } from './types.ts';
import { PAGE_BODY_STAGING_TEXTS_SQL } from '../page-body/schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); the fresh-install
// copy in src/schema.sql (PAGE_BODY_SCHEMA_SQL) carries the same table.
//
// Segmented page storage (Wave B PR 2) follow-up:
// - page_body_staging_texts: the segment texts each body staging staged or
//   deduped onto. A segmented create keeps its manifest rows in memory until it
//   publishes, and a replace stages its texts before its manifest rows, so a
//   page purge that deleted every text no manifest row references killed such
//   a write (page_body_manifest_source_id_sha256_fkey). A purge now keeps the
//   texts a live staging recorded here, and only those. Hashes only, no text;
//   rows go with their staging (ON DELETE CASCADE). Nothing to backfill: a
//   staging opened before this migration records nothing and its write keeps
//   the old behavior until it ends.
// - content_chunks.retired_generation is re-added where an earlier build of
//   v252 dropped it (test brains of that build only): the released binary's
//   chunk readers still select it (v252). A no-op everywhere else.
export const v255: Migration = {
  version: 255,
  name: 'page_body_staging_texts',
  idempotent: true,
  sql: `
    ${PAGE_BODY_STAGING_TEXTS_SQL}
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS retired_generation BIGINT;
  `,
};
