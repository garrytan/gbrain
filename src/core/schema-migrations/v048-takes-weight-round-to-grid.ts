import type { Migration } from './types.ts';

export const v048: Migration = {
  version: 48,
  name: 'takes_weight_round_to_grid',
  // v0.32.0 — Takes v2 wave (renumbered from v46 → v48 after merging master's
  // v0.31.3 wave which claimed v46 with mcp_request_log_params_jsonb_normalize).
  // Backfill the weight column to the 0.05 grid that v0.31's engine layer
  // enforces on insert (PR #795). Cross-modal eval over 100K production
  // takes flagged 0.74, 0.82-style values as false precision; the engine
  // now rounds new inserts to the grid, but pre-v0.32 rows still carry the
  // old precision and bias every query that reads weight (search ranking,
  // scorecard, calibration math).
  //
  // What `transaction: false` actually buys (codex review #2 correction):
  // it frees the migration runner from holding a long transaction across
  // the UPDATE so other gbrain processes (workers, MCP queries) can
  // interleave. It does NOT enable mid-statement resume — a single SQL
  // statement either completes or rolls back.
  //
  // Idempotency: the WHERE clause re-evaluates each row. After the first
  // complete pass every row is on-grid; a second invocation of the
  // migration is a zero-row UPDATE.
  //
  // The IS NOT NULL guard is cheap insurance against any stale schema
  // where weight was nullable; current schema (v28+) has NOT NULL.
  sql: `
      -- Tolerance-based comparison. weight is stored as REAL (float32), which
      -- has ~1e-7 representation noise. The 0.05 grid spacing is 5e-2. Any
      -- value with abs(weight - on_grid) > 1e-3 is genuinely off-grid; below
      -- that, the difference is float32 noise from prior round-trips and
      -- re-writing it would only re-introduce the same noise, not converge.
      -- (The naive "weight <> ROUND(...)" form fires every time because
      -- mixed REAL/NUMERIC comparison promotes weight to DOUBLE PRECISION
      -- first, surfacing the 1e-7 noise as inequality.)
      UPDATE takes
         SET weight = (ROUND(weight::numeric * 20) / 20)::real
       WHERE weight IS NOT NULL
         AND abs(weight::numeric - ROUND(weight::numeric * 20) / 20) > 0.001;
    `,
  transaction: false,
};
