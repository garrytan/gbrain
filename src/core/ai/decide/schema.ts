/**
 * decide storage DDL: one canonical copy used by the schema migrations and,
 * through scripts/build-schema.ts FRAGMENTS, by fresh-install DDL.
 *
 * No JSONB columns (structured values are text); no CHECK constraint on the
 * outcome vocabulary (outcomes.ts is the one enforced list). Receipts carry
 * hashes only: no query, prompt, page or transcript text is stored.
 */

const rls = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;

/** decision_receipts (per-question receipts), decide_spend (per-request ledger), decide_state (internal keys). */
export const DECIDE_RECEIPTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decision_receipts (
  id                 BIGSERIAL PRIMARY KEY,
  decision_id        TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id          TEXT,
  slot               TEXT NOT NULL,
  mode               TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model_alias        TEXT,
  model_resolved     TEXT,
  question_kind      TEXT,
  state_hash         TEXT,
  question_hash      TEXT,
  answer_value       REAL,
  answer_choice      TEXT,
  confidence         REAL,
  threshold          REAL,
  outcome            TEXT NOT NULL,
  subject_ref        TEXT,
  call_site          TEXT NOT NULL,
  lane               TEXT NOT NULL,
  policy_fingerprint TEXT,
  calibration_ref    TEXT,
  latency_ms         INTEGER,
  input_tokens       INTEGER,
  error_reason       TEXT,
  protected          BOOLEAN NOT NULL DEFAULT false,
  min_keep           INTEGER,
  rank               INTEGER,
  k_used             INTEGER,
  remote             BOOLEAN NOT NULL DEFAULT false,
  run_meta           TEXT
);
CREATE INDEX IF NOT EXISTS decision_receipts_slot_created_idx ON decision_receipts (slot, created_at);
CREATE INDEX IF NOT EXISTS decision_receipts_model_slot_idx ON decision_receipts (model_resolved, slot);
CREATE INDEX IF NOT EXISTS decision_receipts_decision_idx ON decision_receipts (decision_id);
CREATE TABLE IF NOT EXISTS decide_spend (
  request_id     TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id      TEXT,
  slot           TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model_resolved TEXT,
  lane           TEXT NOT NULL,
  remote         BOOLEAN NOT NULL DEFAULT false,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
  outcome        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decide_spend_created_idx ON decide_spend (created_at);
CREATE TABLE IF NOT EXISTS decide_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
${rls('decision_receipts')}
${rls('decide_spend')}
${rls('decide_state')}
`;

/** decide_calibrations: thresholds, reliability, stability and qualification per (slot, call site, provider, model). */
export const DECIDE_CALIBRATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decide_calibrations (
  id                  BIGSERIAL PRIMARY KEY,
  slot                TEXT NOT NULL,
  call_site           TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model_resolved      TEXT NOT NULL,
  threshold           REAL NOT NULL,
  min_keep            INTEGER,
  metric              TEXT NOT NULL,
  metric_value        REAL,
  ece                 REAL,
  retest_sd           REAL,
  repack_sd           REAL,
  action_precision_lb REAL,
  qualification       TEXT,
  qualified_at        TIMESTAMPTZ,
  policy_fingerprint  TEXT,
  n                   INTEGER NOT NULL,
  dataset_hash        TEXT,
  split_hash          TEXT,
  calibrate_ids_hash  TEXT,
  calibrate_only      BOOLEAN NOT NULL DEFAULT true,
  pack_shape          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at          TIMESTAMPTZ,
  notes               TEXT
);
CREATE INDEX IF NOT EXISTS decide_calibrations_lookup_idx ON decide_calibrations (slot, provider, model_resolved, created_at DESC);
${rls('decide_calibrations')}
`;

/**
 * decide_proposals (S9 pending supersedes with before/after state for undo)
 * and decide_sweep_deferred (transient sweep skips retried with an attempt cap).
 */
export const DECIDE_PROPOSALS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decide_proposals (
  id             BIGSERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id      TEXT NOT NULL,
  sweep_id       TEXT NOT NULL,
  pair_index     INTEGER NOT NULL,
  new_fact_id    BIGINT NOT NULL,
  old_fact_id    BIGINT NOT NULL,
  direction      TEXT NOT NULL DEFAULT 'new_supersedes_old',
  p_supersede    REAL NOT NULL,
  threshold      REAL,
  proposal_floor REAL NOT NULL,
  model_resolved TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  decided_at     TIMESTAMPTZ,
  before_state   TEXT,
  after_state    TEXT,
  UNIQUE (sweep_id, pair_index)
);
CREATE INDEX IF NOT EXISTS decide_proposals_status_created_idx ON decide_proposals (status, created_at);
CREATE TABLE IF NOT EXISTS decide_sweep_deferred (
  source_id       TEXT NOT NULL,
  fact_id         BIGINT NOT NULL,
  slot            TEXT NOT NULL,
  reason          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slot, source_id, fact_id)
);
${rls('decide_proposals')}
${rls('decide_sweep_deferred')}
`;

/**
 * The ambiguous-band review lane: decide_review_queue holds durable review work
 * (a withdrawn fact to compare against its neighbours, or a candidate pair
 * another subsystem enqueued); decide_review_proposals holds owner-reviewed
 * outcomes per kind (withdraw | duplicate_page | duplicate_entity). Separate
 * from decide_proposals so a binary that predates review kinds never reads them.
 */
export const DECIDE_REVIEW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decide_review_queue (
  kind            TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  a_ref           TEXT NOT NULL,
  b_ref           TEXT NOT NULL DEFAULT '*',
  evidence        TEXT,
  reason          TEXT NOT NULL DEFAULT 'queued',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, source_id, a_ref, b_ref)
);
CREATE TABLE IF NOT EXISTS decide_review_proposals (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind             TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  sweep_id         TEXT NOT NULL,
  a_ref            TEXT NOT NULL,
  b_ref            TEXT NOT NULL,
  subject          TEXT NOT NULL DEFAULT '*',
  visibility       TEXT,
  p_action         REAL NOT NULL,
  threshold        REAL,
  model_resolved   TEXT,
  question_version TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  decided_at       TIMESTAMPTZ,
  receipt          TEXT,
  UNIQUE (kind, source_id, a_ref, b_ref, subject)
);
CREATE INDEX IF NOT EXISTS decide_review_proposals_status_idx ON decide_review_proposals (status, created_at);
${rls('decide_review_queue')}
${rls('decide_review_proposals')}
`;

export const DECIDE_SCHEMA_SQL = `${DECIDE_RECEIPTS_SCHEMA_SQL}${DECIDE_CALIBRATIONS_SCHEMA_SQL}${DECIDE_PROPOSALS_SCHEMA_SQL}${DECIDE_REVIEW_SCHEMA_SQL}`;
