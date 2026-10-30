import type { Migration } from './types.ts';

export const v268: Migration = {
  // GBRA-133: the owner stamp of an effect claim ({ token, owner }), written in the
  // statement that mints the token, so a consumer can release a running effect
  // whose stamped owner it proves dead instead of waiting out the 2-minute lease
  // (the request side has done this since #6650 through claim_phase). Nullable,
  // no backfill, no index (bootstrap-coverage: column-only). Fresh installs get it
  // from this migration too (not src/schema.sql), like v155's effect columns.
  version: 268,
  name: 'effect_claim_owner',
  idempotent: true,
  sql: `
    ALTER TABLE persistence_effects ADD COLUMN IF NOT EXISTS claim_owner JSONB;
  `,
};
