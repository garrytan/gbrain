import type { Migration } from './types.ts';

export const v057: Migration = {
  version: 57,
  name: 'search_telemetry_rollup',
  // v0.32.3 search-lite: per-day rollup of search-call shape.
  //
  // Powers `gbrain search stats [--days N]` and `gbrain search tune` so an
  // operator (or an agent calling tune) can reason about hit rate, intent
  // mix, budget pressure, and result-volume averages WITHOUT pulling
  // per-call rows.
  //
  // Schema math per [CDX-17]: sums + counts only, NOT averages. Read-time
  // derives averages so concurrent ON CONFLICT writes from multiple gbrain
  // processes accumulate correctly.
  //
  // Date-bucketed cache hit/miss per [CDX-18] — query_cache.hit_count is
  // a LIFETIME counter and can't be sliced by --days. The telemetry table
  // is the truth for windowed hit rate.
  //
  // PK is (date, mode, intent) so the rollup never grows past
  // 365 days × 3 modes × 4 intents = ~4380 rows/year. Acceptable.
  //
  // Engine-agnostic; idempotent.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS search_telemetry (
        date                TEXT         NOT NULL,
        mode                TEXT         NOT NULL,
        intent              TEXT         NOT NULL,
        count               INTEGER      NOT NULL DEFAULT 0,
        sum_results         INTEGER      NOT NULL DEFAULT 0,
        sum_tokens          INTEGER      NOT NULL DEFAULT 0,
        sum_budget_dropped  INTEGER      NOT NULL DEFAULT 0,
        cache_hit           INTEGER      NOT NULL DEFAULT 0,
        cache_miss          INTEGER      NOT NULL DEFAULT 0,
        first_seen          TIMESTAMPTZ  NOT NULL DEFAULT now(),
        last_seen           TIMESTAMPTZ  NOT NULL DEFAULT now(),
        PRIMARY KEY (date, mode, intent)
      );

      CREATE INDEX IF NOT EXISTS idx_search_telemetry_date
        ON search_telemetry (date DESC);
    `,
};
