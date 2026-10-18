import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(). Migration-only, like
// the other tables that reference takes (takes itself is created by v37).
//
// W7 (wave 4b), the private forecast journal: the horizon of a take (the
// last day its claim can come true), one row per take
// (src/core/takes-horizon.ts). A table of its own rather than a column on
// takes, because takes_list and takes_search return t.*, and a new column
// would reach remote callers. claim_sha256 binds the row to the claim it was
// set for; an edited claim reads the row as not current. Rows go with their
// take (ON DELETE CASCADE). Dates, an enum, a hash and a timestamp only: no
// page text. DDL only, nothing to backfill: horizons come from an explicit,
// preview-first scan or the owner.
export const v251: Migration = {
  version: 251,
  name: 'take_horizons',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS take_horizons (
      take_id BIGINT PRIMARY KEY REFERENCES takes(id) ON DELETE CASCADE,
      claim_sha256 TEXT NOT NULL,
      horizon_date DATE NOT NULL,
      basis TEXT NOT NULL CHECK (basis IN ('stated','stated_relative','owner')),
      set_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS take_horizons_date_idx ON take_horizons (horizon_date);
  `,
};
