import type { Migration } from './types.ts';

export const v069: Migration = {
  version: 69,
  name: 'take_proposals_v0_36',
  // v0.36.1.0 — propose_takes phase queue.
  //
  // Schema design:
  //   - (source_id, page_slug, content_hash, prompt_version) is the
  //     idempotency cache (mirrors dream_verdicts in v0.23 synthesize).
  //     Without this, every propose_takes cycle re-spends LLM tokens on
  //     unchanged pages.
  //   - dedup_against_fence_rows JSONB (F2 fix): records the fence state
  //     at proposal time so we can audit "did the LLM see the existing
  //     fence rows when it proposed?" Prevents duplicate proposals.
  //   - proposal_run_id (CDX-4 fix): groups proposals from a single
  //     `gbrain dream --phase propose_takes` run so --rollback <run_id>
  //     can bulk-reject a bad-prompt run.
  //   - predicted_brier + predicted_brier_bucket_n (E5): forecast computed
  //     at proposal time so the queue UX shows "your historical Brier in
  //     this bucket is 0.31" without recomputing.
  //   - status enum guards against undefined states.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS take_proposals (
        id                          BIGSERIAL PRIMARY KEY,
        source_id                   TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        page_slug                   TEXT         NOT NULL,
        content_hash                TEXT         NOT NULL,
        prompt_version              TEXT         NOT NULL,
        wave_version                TEXT         NOT NULL DEFAULT 'v0.36.1.0',
        proposed_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
        proposal_run_id             TEXT         NOT NULL,
        status                      TEXT         NOT NULL DEFAULT 'pending'
                                                 CHECK (status IN ('pending','accepted','rejected','superseded')),
        claim_text                  TEXT         NOT NULL,
        kind                        TEXT         NOT NULL,
        holder                      TEXT         NOT NULL,
        weight                      REAL         NOT NULL,
        domain                      TEXT,
        dedup_against_fence_rows    JSONB,
        model_id                    TEXT         NOT NULL,
        acted_at                    TIMESTAMPTZ,
        acted_by                    TEXT,
        promoted_row_num            INTEGER,
        predicted_brier             REAL,
        predicted_brier_bucket_n    INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS take_proposals_idempotency_idx
        ON take_proposals (source_id, page_slug, content_hash, prompt_version);
      CREATE INDEX IF NOT EXISTS take_proposals_pending_idx
        ON take_proposals (source_id, status, proposed_at DESC)
        WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS take_proposals_run_id_idx
        ON take_proposals (proposal_run_id);
    `,
};
