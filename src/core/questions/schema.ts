/**
 * Pinned questions storage DDL: one canonical copy used by the pinned_questions schema migration and,
 * through scripts/build-schema.ts FRAGMENTS, by fresh-install DDL.
 *
 * The answer lives here, never in `pages`: question pages hold the question
 * and the owner's notes only, so search, chunks, page history, export and git
 * sync never carry answer text. `question_evidence` stores pointers (kind, id,
 * page generation and knowledge revision, content hash) with no foreign key,
 * so a hard delete or cascade leaves a dangling pointer that reads as stale
 * instead of erasing the dependency.
 */

const rls = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;

export const PINNED_QUESTIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pinned_questions (
  id                        BIGSERIAL PRIMARY KEY,
  source_id                 TEXT NOT NULL,
  slug                      TEXT NOT NULL,
  question                  TEXT NOT NULL,
  scope_slug_prefix         TEXT,
  scope_entity              TEXT,
  state                     TEXT NOT NULL DEFAULT 'active',
  inactive_reason           TEXT,
  publish_mode              TEXT NOT NULL DEFAULT 'publish',
  model                     TEXT,
  cooldown_days             REAL,
  origin                    TEXT NOT NULL DEFAULT 'pin',
  created_by                TEXT NOT NULL,
  revision                  BIGINT NOT NULL DEFAULT 1,
  answer_revision           INTEGER NOT NULL DEFAULT 0,
  answer                    TEXT,
  answer_model              TEXT,
  last_refresh_at           TIMESTAMPTZ,
  last_attempt_at           TIMESTAMPTZ,
  last_error                TEXT,
  watermark_generation      BIGINT,
  watermark_fact_id         BIGINT,
  watermark_at              TIMESTAMPTZ,
  lease_token               TEXT,
  lease_owner               TEXT,
  lease_expires_at          TIMESTAMPTZ,
  refresh_attempts          INTEGER NOT NULL DEFAULT 0,
  spend_usd                 DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at               TIMESTAMPTZ,
  CONSTRAINT pinned_questions_source_slug_key UNIQUE (source_id, slug)
);
CREATE INDEX IF NOT EXISTS pinned_questions_state_idx ON pinned_questions (state, source_id);
CREATE TABLE IF NOT EXISTS question_evidence (
  id                        BIGSERIAL PRIMARY KEY,
  question_id               BIGINT NOT NULL,
  answer_revision           INTEGER NOT NULL,
  sentence_id               TEXT NOT NULL,
  kind                      TEXT NOT NULL,
  source_id                 TEXT NOT NULL,
  page_id                   INTEGER,
  page_slug                 TEXT,
  page_generation           BIGINT,
  page_revision             TEXT,
  item_id                   BIGINT,
  content_hash              TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_evidence_question_idx ON question_evidence (question_id, answer_revision);
${rls('pinned_questions')}
${rls('question_evidence')}
`;
