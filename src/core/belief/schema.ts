/**
 * Belief ledger DDL (W1, docs/designs/BELIEF_LEDGER.md section 8), shared by
 * the migration and both schema blobs (src/schema.sql region; `bun run build:schema`).
 *
 * `sources.purge_epoch` is migration-only (BELIEF_SOURCE_COLUMNS_SQL), like the
 * trust-tier columns, so fresh and upgraded brains share column ordinals.
 */

const RLS = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;


export const BELIEF_LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS belief_events (
  id                 BIGSERIAL PRIMARY KEY,
  event_key          BYTEA NOT NULL UNIQUE,
  source_id          TEXT NOT NULL,
  source_incarnation UUID NOT NULL,
  page_lifetime      UUID,
  slug               TEXT NOT NULL,
  subject_kind       TEXT NOT NULL CHECK (subject_kind IN ('page','fact','take','link','link_transition','coverage')),
  subject_key        TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  origin             TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live','unmanaged','baseline','backfill','reconcile')),
  trust_tier         TEXT NOT NULL,
  writer_tier        TEXT,
  tier_basis         TEXT NOT NULL DEFAULT 'row' CHECK (tier_basis IN ('row','writer','unknown')),
  visibility         TEXT NOT NULL,
  publication_id     UUID NOT NULL,
  ord                INTEGER NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  source_time        TIMESTAMPTZ,
  valid_from         TIMESTAMPTZ,
  valid_until        TIMESTAMPTZ,
  value              JSONB,
  value_hash         TEXT,
  prior_hash         TEXT,
  state_hash         TEXT NOT NULL,
  cause              JSONB NOT NULL,
  claim_fp           TEXT,
  purged             BOOLEAN NOT NULL DEFAULT false,
  redacted_fields    TEXT[]
);
CREATE INDEX IF NOT EXISTS belief_events_page ON belief_events (source_id, slug, id);
CREATE INDEX IF NOT EXISTS belief_events_subject ON belief_events (source_id, subject_kind, subject_key, id);
CREATE INDEX IF NOT EXISTS belief_events_recorded ON belief_events (recorded_at);
CREATE INDEX IF NOT EXISTS belief_events_claim_fp ON belief_events (source_id, claim_fp) WHERE claim_fp IS NOT NULL;
CREATE INDEX IF NOT EXISTS belief_events_lifetime ON belief_events (page_lifetime, id) WHERE page_lifetime IS NOT NULL;
CREATE INDEX IF NOT EXISTS belief_events_publication ON belief_events (publication_id);
${RLS('belief_events')}
CREATE TABLE IF NOT EXISTS belief_page_lifetimes (
  page_lifetime      UUID PRIMARY KEY,
  source_id          TEXT NOT NULL,
  source_incarnation UUID NOT NULL,
  slug               TEXT NOT NULL,
  page_id            INTEGER,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ended_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS belief_page_lifetimes_open ON belief_page_lifetimes (source_incarnation, slug) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS belief_page_lifetimes_slug ON belief_page_lifetimes (source_id, slug);
${RLS('belief_page_lifetimes')}
CREATE TABLE IF NOT EXISTS belief_commit_marks (
  publication_id UUID PRIMARY KEY,
  observed_at    TIMESTAMPTZ NOT NULL
);
${RLS('belief_commit_marks')}
CREATE TABLE IF NOT EXISTS belief_retier_manifest (
  summary_event BIGINT NOT NULL,
  source_id     TEXT NOT NULL,
  subject_kind  TEXT NOT NULL,
  subject_key   TEXT NOT NULL,
  from_tier     TEXT,
  to_tier       TEXT NOT NULL,
  PRIMARY KEY (summary_event, subject_kind, subject_key)
);
${RLS('belief_retier_manifest')}
CREATE TABLE IF NOT EXISTS belief_redactions (
  id            BIGSERIAL PRIMARY KEY,
  source_id     TEXT NOT NULL,
  subject_key   TEXT NOT NULL,
  field         TEXT NOT NULL,
  purge_request UUID NOT NULL,
  field_hash    TEXT NOT NULL,
  released_by   UUID,
  released_hash TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS belief_redactions_subject ON belief_redactions (source_id, subject_key, field);
CREATE INDEX IF NOT EXISTS belief_redactions_field_hash ON belief_redactions (source_id, field_hash);
${RLS('belief_redactions')}
`;

/** Migration-only: purge serializes on this counter; the ledger refuses a payload prepared under an older epoch. */
export const BELIEF_SOURCE_COLUMNS_SQL = `ALTER TABLE sources ADD COLUMN IF NOT EXISTS purge_epoch BIGINT NOT NULL DEFAULT 0;`;

/**
 * The batch state read selects a stream's active facts by `source_markdown_slug` (the fence facts and file-less
 * facts filed on a page); without this index that is a scan of the source's facts on every write. Built online by
 * v249's handler (Postgres CONCURRENTLY).
 */
export const BELIEF_FACTS_STREAM_INDEX = {
  name: 'idx_facts_belief_stream',
  table: 'facts',
  sql: 'CREATE INDEX IF NOT EXISTS idx_facts_belief_stream ON facts (source_id, source_markdown_slug) WHERE expired_at IS NULL',
};
