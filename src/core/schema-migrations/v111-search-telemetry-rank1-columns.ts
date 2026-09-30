import type { Migration } from './types.ts';

export const v111: Migration = {
  version: 111,
  name: 'search_telemetry_rank1_columns',
  // T7 of the retrieval-cathedral wave — rank-1 base_score drift signal.
  // Aggregate columns (NOT per-query rows, D10) so a downward drift in the
  // median rank-1 match score is computable from the existing day/mode/intent
  // rollup with bounded growth. search_telemetry lives only in migration v57
  // (not the schema blobs), so these are ADD COLUMN IF NOT EXISTS on both
  // engines; fresh installs pick them up right after v57 runs.
  idempotent: true,
  sql: `
      ALTER TABLE search_telemetry ADD COLUMN IF NOT EXISTS sum_rank1_score DOUBLE PRECISION NOT NULL DEFAULT 0;
      ALTER TABLE search_telemetry ADD COLUMN IF NOT EXISTS count_rank1 INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE search_telemetry ADD COLUMN IF NOT EXISTS rank1_lt_solid INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE search_telemetry ADD COLUMN IF NOT EXISTS rank1_solid INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE search_telemetry ADD COLUMN IF NOT EXISTS rank1_high INTEGER NOT NULL DEFAULT 0;
    `,
};
