import type { Migration } from './types.ts';

export const v068: Migration = {
  version: 68,
  name: 'calibration_profiles_v0_36',
  // v0.36.1.0 — Hindsight calibration wave. Per-holder profile rows
  // aggregating TakesScorecard data into qualitative pattern statements.
  //
  // Schema design (from plan D17/D18):
  //   - source_id is REQUIRED — every read routes through sourceScopeOpts(ctx)
  //     so we can never leak a profile across the v0.34.1 source-isolation
  //     boundary. FK to sources(id) with CASCADE so source deletion cleans
  //     up the per-source profile.
  //   - wave_version stamps every row so `gbrain calibration --undo-wave
  //     v0.36.1.0` can reverse just this wave's writes.
  //   - published BOOL gates E8 team-brain mount sharing (D15 asymmetric
  //     opt-in). Default false: nothing leaks until owner explicitly publishes.
  //   - grade_completion REAL [0..1]: fraction of unresolved takes the
  //     grade_takes phase actually processed before its budget cap fired
  //     (F1 fix — dashboard shows "60% graded" badge instead of silently
  //     reading stale data).
  //   - voice_gate_passed + voice_gate_attempts: D11 audit columns. When
  //     passed=false the row uses the template-fallback narrative and
  //     surfaces for review.
  //   - judge_model_agreement REAL: ensemble agreement on profile
  //     generation itself (E2 applied to the meta-step).
  //   - active_bias_tags TEXT[] with GIN index: E3 (calibration-aware
  //     contradictions) joins on this; E7 (nudges) matches new takes against it.
  //
  // PGLite parity: identical DDL works since PGLite ships GIN.
  // Idempotent across both engines.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS calibration_profiles (
        id                      BIGSERIAL PRIMARY KEY,
        source_id               TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        holder                  TEXT         NOT NULL,
        wave_version            TEXT         NOT NULL DEFAULT 'v0.36.1.0',
        generated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
        published               BOOLEAN      NOT NULL DEFAULT false,
        total_resolved          INTEGER      NOT NULL,
        brier                   REAL,
        accuracy                REAL,
        partial_rate            REAL,
        grade_completion        REAL         NOT NULL DEFAULT 1.0,
        domain_scorecards       JSONB        NOT NULL,
        pattern_statements      TEXT[]       NOT NULL,
        voice_gate_passed       BOOLEAN      NOT NULL,
        voice_gate_attempts     SMALLINT     NOT NULL,
        active_bias_tags        TEXT[]       NOT NULL,
        model_id                TEXT         NOT NULL,
        cost_usd                NUMERIC(10,4),
        judge_model_agreement   REAL
      );
      CREATE INDEX IF NOT EXISTS calibration_profiles_holder_recent_idx
        ON calibration_profiles (source_id, holder, generated_at DESC);
      CREATE INDEX IF NOT EXISTS calibration_profiles_bias_tags_gin
        ON calibration_profiles USING GIN (active_bias_tags);
      CREATE INDEX IF NOT EXISTS calibration_profiles_published_idx
        ON calibration_profiles (source_id, published, holder)
        WHERE published = true;
    `,
};
