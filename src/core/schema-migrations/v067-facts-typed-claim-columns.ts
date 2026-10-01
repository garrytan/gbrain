import type { Migration } from './types.ts';

export const v067: Migration = {
  version: 67,
  name: 'facts_typed_claim_columns',
  // v0.35.4 — typed-claim columns for trajectory queries.
  //
  // Adds four optional columns to `facts` so metric assertions like
  // "$50K MRR" can be stored as (claim_metric=mrr, claim_value=50000,
  // claim_unit=USD, claim_period=monthly) and queried chronologically
  // by `gbrain eval trajectory` + the `find_trajectory` MCP op.
  //
  // All columns nullable: existing fence rows persist identically.
  // The partial index covers only metric-bearing rows and stays
  // zero-byte until the v0.35.4 extraction path (`src/core/facts/extract.ts`)
  // starts emitting typed fields, so this migration is metadata-only
  // on both engines.
  //
  // See plan: ~/.claude/plans/system-instruction-you-are-working-curious-jellyfish.md
  // Locked decisions D1 (inline extension), D-CDX-7 (v66→v67 renumber).
  idempotent: true,
  sql: `
      ALTER TABLE facts
        ADD COLUMN IF NOT EXISTS claim_metric  TEXT,
        ADD COLUMN IF NOT EXISTS claim_value   DOUBLE PRECISION,
        ADD COLUMN IF NOT EXISTS claim_unit    TEXT,
        ADD COLUMN IF NOT EXISTS claim_period  TEXT;

      CREATE INDEX IF NOT EXISTS facts_typed_claim_idx
        ON facts (entity_slug, claim_metric, valid_from)
        WHERE claim_metric IS NOT NULL;
    `,
};
