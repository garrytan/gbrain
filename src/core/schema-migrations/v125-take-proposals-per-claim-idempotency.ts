import type { Migration } from './types.ts';

export const v125: Migration = {
  version: 125,
  name: 'take_proposals_per_claim_idempotency',
  // #2138: the original idempotency key was per page, so each INSERT after
  // the first claim silently conflicted. md5(claim_text) makes it per claim
  // without adding/backfilling a column. The new key is strictly finer than
  // the old key and therefore preserves all existing rows.
  idempotent: true,
  sql: `
      DROP INDEX IF EXISTS take_proposals_idempotency_idx;
      CREATE UNIQUE INDEX IF NOT EXISTS take_proposals_idempotency_idx
        ON take_proposals (source_id, page_slug, content_hash, prompt_version, md5(claim_text));
    `,
};
