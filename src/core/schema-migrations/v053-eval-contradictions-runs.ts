import type { Migration } from './types.ts';

export const v053: Migration = {
  version: 53,
  name: 'eval_contradictions_runs',
  // v0.32.6 — M5 time-series tracking for the contradiction probe.
  //
  // One row per `gbrain eval suspected-contradictions` run. The headline
  // numbers (queries_evaluated, with_contradiction, total_flagged) plus
  // Wilson 95% CI bounds enable `gbrain eval suspected-contradictions
  // trend [--days N]` to plot brain consistency over time.
  //
  // report_json carries the full ProbeReport for replay/inspection.
  // source_tier_breakdown is also surfaced as a top-level JSONB column
  // so trend queries can group by tier without parsing the full report.
  //
  // No FK to other tables: this is an append-only metrics log, not a
  // relational record. Trend reads filter on ran_at.
  //
  // Idempotent across PGLite and Postgres.
  sql: `
      CREATE TABLE IF NOT EXISTS eval_contradictions_runs (
        run_id                       TEXT         PRIMARY KEY,
        ran_at                       TIMESTAMPTZ  NOT NULL DEFAULT now(),
        schema_version               INTEGER      NOT NULL DEFAULT 1,
        judge_model                  TEXT         NOT NULL,
        prompt_version               TEXT         NOT NULL,
        queries_evaluated            INTEGER      NOT NULL,
        queries_with_contradiction   INTEGER      NOT NULL,
        total_contradictions_flagged INTEGER      NOT NULL,
        wilson_ci_lower              REAL         NOT NULL,
        wilson_ci_upper              REAL         NOT NULL,
        judge_errors_total           INTEGER      NOT NULL,
        cost_usd_total               REAL         NOT NULL,
        duration_ms                  INTEGER      NOT NULL,
        source_tier_breakdown        JSONB        NOT NULL,
        report_json                  JSONB        NOT NULL
      );
      CREATE INDEX IF NOT EXISTS eval_contradictions_runs_ran_at_idx
        ON eval_contradictions_runs (ran_at DESC);
    `,
};
