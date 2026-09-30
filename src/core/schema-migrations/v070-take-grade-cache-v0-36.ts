import type { Migration } from './types.ts';

export const v070: Migration = {
  version: 70,
  name: 'take_grade_cache_v0_36',
  // v0.36.1.0 — grade_takes verdict cache.
  //
  // Mirrors eval_contradictions_cache (v52) pattern:
  //   - Composite primary key (take_id, prompt_version, judge_model_id,
  //     evidence_signature) — prompt edits OR evidence-set changes
  //     cleanly invalidate prior verdicts.
  //   - judge_model_id is the literal model string for single-model runs
  //     OR 'ensemble:openai+anthropic+google' for E2 ensemble runs.
  //   - applied BOOLEAN: did we auto-resolve based on this verdict, or
  //     did it surface to review? D17 default-off auto-resolve means
  //     most rows start applied=false on fresh installs.
  //   - confidence REAL: the discretized self-reported judge confidence.
  //     CDX-11 drift detection compares this against actual accuracy
  //     over 90-day windows.
  //   - wave_version for --undo-wave reversal.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS take_grade_cache (
        take_id            BIGINT       NOT NULL,
        prompt_version     TEXT         NOT NULL,
        judge_model_id     TEXT         NOT NULL,
        evidence_signature TEXT         NOT NULL,
        wave_version       TEXT         NOT NULL DEFAULT 'v0.36.1.0',
        graded_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
        verdict            TEXT         NOT NULL
                                        CHECK (verdict IN ('correct','incorrect','partial','unresolvable')),
        confidence         REAL         NOT NULL,
        applied            BOOLEAN      NOT NULL DEFAULT false,
        cost_usd           NUMERIC(10,4),
        PRIMARY KEY (take_id, prompt_version, judge_model_id, evidence_signature)
      );
      CREATE INDEX IF NOT EXISTS take_grade_cache_applied_idx
        ON take_grade_cache (take_id, applied);
      CREATE INDEX IF NOT EXISTS take_grade_cache_wave_idx
        ON take_grade_cache (wave_version, graded_at DESC);
    `,
};
