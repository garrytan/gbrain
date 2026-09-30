import type { Migration } from './types.ts';

export const v049: Migration = {
  version: 49,
  name: 'eval_takes_quality_runs',
  // v0.32 — Takes v2 wave (EXP-5). Renumbered from v47 → v49 after merging
  // master's v0.31.3 wave (v46 → mcp_request_log_params_jsonb_normalize).
  //
  // DB-authoritative store for the takes-quality eval CLI's receipts.
  // Codex review #6 corrected the original two-phase plan (split-brain
  // reconciliation gap) — DB row is the source of truth, the disk file
  // is a best-effort artifact.
  //
  // 4-sha unique key (corpus, prompt, model_set, rubric) so:
  //   - Re-running the same run is idempotent (ON CONFLICT DO NOTHING).
  //   - A future rubric tweak produces a different rubric_sha8 → distinct
  //     row → trend mode segregates by rubric_version (codex review #3).
  //
  // receipt_json carries the full receipt blob so `replay` can reconstruct
  // when the disk artifact is missing (DB-authoritative replay path).
  //
  // Index `(rubric_version, created_at DESC)` matches the trend query
  // shape: ORDER BY created_at DESC LIMIT N filtered by rubric_version.
  sql: `
      CREATE TABLE IF NOT EXISTS eval_takes_quality_runs (
        id                    BIGSERIAL    PRIMARY KEY,
        receipt_sha8_corpus   TEXT         NOT NULL,
        receipt_sha8_prompt   TEXT         NOT NULL,
        receipt_sha8_models   TEXT         NOT NULL,
        receipt_sha8_rubric   TEXT         NOT NULL,
        rubric_version        TEXT         NOT NULL,
        verdict               TEXT         NOT NULL CHECK (verdict IN ('pass','fail','inconclusive')),
        overall_score         REAL         NOT NULL,
        dim_scores            JSONB        NOT NULL,
        cost_usd              REAL         NOT NULL,
        receipt_json          JSONB        NOT NULL,
        receipt_disk_path     TEXT,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
        UNIQUE (receipt_sha8_corpus, receipt_sha8_prompt, receipt_sha8_models, receipt_sha8_rubric)
      );
      CREATE INDEX IF NOT EXISTS eval_takes_quality_runs_trend_idx
        ON eval_takes_quality_runs (rubric_version, created_at DESC);
    `,
};
