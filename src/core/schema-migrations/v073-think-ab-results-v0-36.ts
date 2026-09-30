import type { Migration } from './types.ts';

export const v073: Migration = {
  version: 73,
  name: 'think_ab_results_v0_36',
  // v0.36.1.0 (T18 / D19) — A/B harness data for `gbrain think --ab`.
  //
  // Each row records one side-by-side comparison of think with vs.
  // without --with-calibration. After 30 days of data, `gbrain
  // calibration ab-report` aggregates win/loss across the table and
  // surfaces a calibration_net_negative doctor warning if the
  // with-calibration variant loses >55% of trials (n >= 20).
  //
  // wave_version stamped so --undo-wave can scrub these too if needed.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS think_ab_results (
        id              BIGSERIAL PRIMARY KEY,
        source_id       TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        wave_version    TEXT         NOT NULL DEFAULT 'v0.36.1.0',
        ran_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
        question        TEXT         NOT NULL,
        baseline_answer TEXT         NOT NULL,
        with_calibration_answer TEXT NOT NULL,
        preferred       TEXT         NOT NULL CHECK (preferred IN ('baseline','with_calibration','neither','tie')),
        model_id        TEXT,
        notes           TEXT
      );
      CREATE INDEX IF NOT EXISTS think_ab_results_recent_idx
        ON think_ab_results (source_id, ran_at DESC);
    `,
};
