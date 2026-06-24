// AUTO-GENERATED — do not edit. Run: bun run build:schema
// Source: src/schema.sql

export const SCHEMA_SQL = `
-- MBrain Postgres + pgvector schema

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- pages: the core content table
-- ============================================================
CREATE TABLE IF NOT EXISTS pages (
  id            SERIAL PRIMARY KEY,
  slug          TEXT    NOT NULL UNIQUE,
  type          TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  compiled_truth TEXT   NOT NULL DEFAULT '',
  timeline      TEXT    NOT NULL DEFAULT '',
  search_text   TEXT    NOT NULL DEFAULT '',
  frontmatter   JSONB   NOT NULL DEFAULT '{}',
  page_embedding vector(1024),
  content_hash  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_frontmatter ON pages USING GIN(frontmatter);
CREATE INDEX IF NOT EXISTS idx_pages_trgm ON pages USING GIN(title gin_trgm_ops);

-- ============================================================
-- content_chunks: chunked content with embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS content_chunks (
  id            SERIAL PRIMARY KEY,
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_text    TEXT    NOT NULL,
  chunk_source  TEXT    NOT NULL DEFAULT 'compiled_truth',
  chunk_content_hash TEXT NOT NULL DEFAULT '',
  embedding     vector(1024),
  model         TEXT    NOT NULL DEFAULT 'qwen3-embedding:0.6b',
  token_count   INTEGER,
  embedded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
-- Partial indexes so health/stats embedding-coverage counts avoid full scans
CREATE INDEX IF NOT EXISTS idx_chunks_embedded ON content_chunks(page_id) WHERE embedded_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_missing_embedding ON content_chunks(page_id) WHERE embedded_at IS NULL;

-- ============================================================
-- links: cross-references between pages
-- ============================================================
CREATE TABLE IF NOT EXISTS links (
  id           SERIAL PRIMARY KEY,
  from_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id   INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type    TEXT    NOT NULL DEFAULT '',
  context      TEXT    NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(from_page_id, to_page_id)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_page_id);

-- ============================================================
-- tags
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
  id      SERIAL PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  UNIQUE(page_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);

-- ============================================================
-- raw_data: sidecar data (replaces .raw/ JSON files)
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_data (
  id         SERIAL PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL,
  data       JSONB   NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(page_id, source)
);

CREATE INDEX IF NOT EXISTS idx_raw_data_page ON raw_data(page_id);

-- ============================================================
-- timeline_entries: structured timeline
-- ============================================================
CREATE TABLE IF NOT EXISTS timeline_entries (
  id       SERIAL PRIMARY KEY,
  page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  date     DATE    NOT NULL,
  source   TEXT    NOT NULL DEFAULT '',
  summary  TEXT    NOT NULL,
  detail   TEXT    NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_page ON timeline_entries(page_id);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_entries(date);

-- ============================================================
-- page_versions: snapshot history for compiled_truth
-- ============================================================
CREATE TABLE IF NOT EXISTS page_versions (
  id             SERIAL PRIMARY KEY,
  page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  compiled_truth TEXT    NOT NULL,
  frontmatter    JSONB   NOT NULL DEFAULT '{}',
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_versions_page ON page_versions(page_id);

-- ============================================================
-- ingest_log
-- ============================================================
CREATE TABLE IF NOT EXISTS ingest_log (
  id            SERIAL PRIMARY KEY,
  source_type   TEXT    NOT NULL,
  source_ref    TEXT    NOT NULL,
  pages_updated JSONB   NOT NULL DEFAULT '[]',
  summary       TEXT    NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- source registry and raw ingest provenance
-- ============================================================
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  connector_id  TEXT,
  locator       TEXT,
  consent_state TEXT NOT NULL CHECK (consent_state IN ('not_requested', 'granted', 'denied', 'revoked')),
  enabled       BOOLEAN NOT NULL DEFAULT false,
  paused_at     TIMESTAMPTZ,
  policy_id     TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_kind_locator
  ON sources(kind, locator)
  WHERE locator IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_kind_state
  ON sources(kind, consent_state, enabled);

CREATE TABLE IF NOT EXISTS source_policies (
  id                  TEXT PRIMARY KEY,
  source_kind         TEXT NOT NULL UNIQUE,
  ingest_mode         TEXT NOT NULL,
  index_mode          TEXT NOT NULL,
  extraction_mode     TEXT NOT NULL,
  raw_copy_mode       TEXT NOT NULL,
  chunk_retention     TEXT NOT NULL,
  llm_access          TEXT NOT NULL,
  runner_access       TEXT NOT NULL,
  automatic_canonical_write_authority TEXT NOT NULL,
  candidate_route_conditions JSONB NOT NULL DEFAULT '[]',
  conflict_route_conditions  JSONB NOT NULL DEFAULT '[]',
  forgetting_lifecycle TEXT NOT NULL,
  restore_window       TEXT NOT NULL,
  purge_policy         TEXT NOT NULL,
  export_reconcile_behavior TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_policy_overrides (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  dimension      TEXT NOT NULL,
  override_value JSONB NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  UNIQUE(source_id, dimension)
);

CREATE TABLE IF NOT EXISTS source_authority_rules (
  id             TEXT PRIMARY KEY,
  source_kind    TEXT NOT NULL,
  claim_type     TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('auto_canonical', 'candidate', 'verify_first', 'conflict_check', 'never_canonical', 'quarantine')),
  conditions_json JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_kind, claim_type)
);

CREATE TABLE IF NOT EXISTS source_retention_rules (
  id            TEXT PRIMARY KEY,
  source_kind   TEXT NOT NULL UNIQUE,
  raw_retention TEXT NOT NULL,
  chunk_retention TEXT NOT NULL,
  restore_window TEXT NOT NULL,
  purge_policy TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_llm_rules (
  id            TEXT PRIMARY KEY,
  source_kind   TEXT NOT NULL UNIQUE,
  llm_access    TEXT NOT NULL,
  runner_access TEXT NOT NULL,
  redaction_required BOOLEAN NOT NULL DEFAULT true,
  explicit_grant_required BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credential_refs (
  id              TEXT PRIMARY KEY,
  connector_id    TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK (provider IN ('credential_gateway', 'os_keychain', 'password_manager', 'local_encrypted_vault')),
  reference       TEXT NOT NULL,
  scopes_json     JSONB NOT NULL DEFAULT '[]',
  expires_at      TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  rotation_status TEXT NOT NULL CHECK (rotation_status IN ('current', 'rotation_due', 'rotating', 'revoked')),
  health_status   TEXT NOT NULL CHECK (health_status IN ('healthy', 'unhealthy', 'expired', 'unknown')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(connector_id, account_id, provider, reference)
);

CREATE INDEX IF NOT EXISTS idx_credential_refs_account
  ON credential_refs(connector_id, account_id);
CREATE INDEX IF NOT EXISTS idx_credential_refs_health
  ON credential_refs(health_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS connector_accounts (
  id                TEXT PRIMARY KEY,
  connector_id      TEXT NOT NULL,
  source_id         TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  account_locator   TEXT NOT NULL,
  display_name      TEXT NOT NULL DEFAULT '',
  credential_ref_id TEXT REFERENCES credential_refs(id) ON DELETE SET NULL,
  status            TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked', 'failed')),
  metadata_json     JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(connector_id, account_locator)
);

CREATE INDEX IF NOT EXISTS idx_connector_accounts_source
  ON connector_accounts(source_id);
CREATE INDEX IF NOT EXISTS idx_connector_accounts_status
  ON connector_accounts(connector_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS connector_grants (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,
  grant_state    TEXT NOT NULL CHECK (grant_state IN ('granted', 'denied', 'revoked')),
  granted_at     TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  metadata_json  JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_connector_grants_state
  ON connector_grants(account_id, grant_state);

CREATE TABLE IF NOT EXISTS connector_sync_states (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  connector_id       TEXT NOT NULL,
  cursor_json        JSONB NOT NULL DEFAULT '{}',
  last_sync_started_at  TIMESTAMPTZ,
  last_sync_finished_at TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  last_failure_at       TIMESTAMPTZ,
  health_status      TEXT NOT NULL CHECK (health_status IN ('healthy', 'unhealthy', 'paused', 'revoked', 'unknown')),
  failure_count      INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  last_error         TEXT,
  metadata_json      JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, connector_id)
);

CREATE INDEX IF NOT EXISTS idx_connector_sync_states_health
  ON connector_sync_states(connector_id, health_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS source_status_events (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  previous_state  TEXT,
  next_state      TEXT,
  actor_ref       TEXT NOT NULL DEFAULT '',
  reason          TEXT NOT NULL DEFAULT '',
  metadata_json   JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_source_status_events_source_created
  ON source_status_events(source_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_source_status_event_mutation()
RETURNS trigger AS \$\$
BEGIN
  RAISE EXCEPTION 'source status events are append-only';
END;
\$\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_source_status_events_update ON source_status_events;
CREATE TRIGGER prevent_source_status_events_update
  BEFORE UPDATE ON source_status_events
  FOR EACH ROW EXECUTE FUNCTION prevent_source_status_event_mutation();
DROP TRIGGER IF EXISTS prevent_source_status_events_delete ON source_status_events;
CREATE TRIGGER prevent_source_status_events_delete
  BEFORE DELETE ON source_status_events
  FOR EACH ROW EXECUTE FUNCTION prevent_source_status_event_mutation();

CREATE TABLE IF NOT EXISTS source_items (
  id                  TEXT PRIMARY KEY,
  source_id           TEXT NOT NULL,
  external_id         TEXT NOT NULL,
  origin_event        TEXT NOT NULL CHECK (origin_event IN ('initial_import', 'connector_sync', 'manual_entry', 'user_direct_entry', 'session_capture', 'markdown_edit')),
  locator             TEXT,
  title               TEXT NOT NULL DEFAULT '',
  source_created_at   TIMESTAMPTZ,
  source_updated_at   TIMESTAMPTZ,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash        TEXT NOT NULL,
  metadata_json       JSONB NOT NULL DEFAULT '{}',
  raw_copy_mode       TEXT NOT NULL,
  raw_copy_ref        TEXT,
  sensitivity_level   TEXT NOT NULL DEFAULT 'normal',
  ingest_status       TEXT NOT NULL CHECK (ingest_status IN ('pending', 'ready', 'failed', 'revoked', 'purged')),
  retention_policy_id TEXT,
  UNIQUE(source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_source_items_source_ingested
  ON source_items(source_id, ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_items_hash
  ON source_items(content_hash);

CREATE TABLE IF NOT EXISTS source_chunks (
  id                    TEXT PRIMARY KEY,
  source_item_id        TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  chunk_index           INTEGER NOT NULL,
  chunk_hash            TEXT NOT NULL,
  chunk_text            TEXT NOT NULL,
  redacted_text         TEXT NOT NULL DEFAULT '',
  token_count           INTEGER NOT NULL DEFAULT 0,
  parser_version        TEXT NOT NULL,
  extractor_version     TEXT NOT NULL DEFAULT '',
  sensitivity_flags     JSONB NOT NULL DEFAULT '[]',
  prompt_injection_risk TEXT NOT NULL CHECK (prompt_injection_risk IN ('none', 'flagged', 'quarantined')),
  secret_risk           TEXT NOT NULL CHECK (secret_risk IN ('none', 'flagged', 'detected', 'redacted')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ,
  UNIQUE(source_item_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_source_chunks_item_index
  ON source_chunks(source_item_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_source_chunks_hash
  ON source_chunks(chunk_hash);

CREATE TABLE IF NOT EXISTS source_item_events (
  id             TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  event_type     TEXT NOT NULL,
  metadata_json  JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_source_item_events_item_created
  ON source_item_events(source_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS raw_access_ledger (
  id              TEXT PRIMARY KEY,
  actor_type      TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  session_id      TEXT,
  job_id          TEXT,
  source_id       TEXT NOT NULL,
  source_item_id  TEXT REFERENCES source_items(id) ON DELETE SET NULL,
  chunk_ids       JSONB NOT NULL DEFAULT '[]',
  reason          TEXT NOT NULL,
  policy_decision TEXT NOT NULL,
  policy_reason   TEXT NOT NULL DEFAULT '',
  prompt_hash     TEXT,
  input_hash      TEXT,
  metadata_json   JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raw_access_ledger_source_created
  ON raw_access_ledger(source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_access_ledger_actor_created
  ON raw_access_ledger(actor_type, actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS secret_detections (
  id                TEXT PRIMARY KEY,
  source_item_id    TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  source_chunk_id   TEXT REFERENCES source_chunks(id) ON DELETE CASCADE,
  secret_type       TEXT NOT NULL,
  secret_hash       TEXT NOT NULL,
  confidence        REAL NOT NULL,
  redaction_status  TEXT NOT NULL CHECK (redaction_status IN ('pending', 'redacted', 'purged')),
  purge_plan_status TEXT NOT NULL DEFAULT 'pending' CHECK (purge_plan_status IN ('pending', 'approved', 'purged', 'ignored')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_secret_detections_item
  ON secret_detections(source_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prompt_injection_flags (
  id              TEXT PRIMARY KEY,
  source_item_id  TEXT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  source_chunk_id TEXT REFERENCES source_chunks(id) ON DELETE CASCADE,
  flag_type       TEXT NOT NULL,
  risk            TEXT NOT NULL CHECK (risk IN ('flagged', 'quarantined')),
  evidence_hash   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prompt_injection_flags_item
  ON prompt_injection_flags(source_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ingest_attempts (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL,
  source_item_id TEXT REFERENCES source_items(id) ON DELETE SET NULL,
  status         TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'skipped')),
  error_message  TEXT,
  metadata_json  JSONB NOT NULL DEFAULT '{}',
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ingest_attempts_source_started
  ON ingest_attempts(source_id, started_at DESC);

-- ============================================================
-- assertion pipeline and session graph
-- ============================================================
CREATE TABLE IF NOT EXISTS extracted_claims (
  id                    TEXT PRIMARY KEY,
  source_id             TEXT NOT NULL,
  source_item_id        TEXT NOT NULL,
  source_chunk_id       TEXT NOT NULL,
  extractor_kind        TEXT NOT NULL,
  extractor_version     TEXT NOT NULL,
  runner_job_id         TEXT,
  claim_text            TEXT NOT NULL,
  claim_type            TEXT NOT NULL,
  target_hint           TEXT NOT NULL,
  property_hint         TEXT NOT NULL,
  value_json            JSONB NOT NULL,
  confidence            REAL NOT NULL,
  sensitivity_level     TEXT NOT NULL,
  prompt_injection_flag BOOLEAN NOT NULL DEFAULT false,
  secret_flag           BOOLEAN NOT NULL DEFAULT false,
  status                TEXT NOT NULL CHECK (status IN ('pending', 'pending_resolution', 'resolved', 'rejected')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extracted_claims_source_chunk
  ON extracted_claims(source_chunk_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_extracted_claims_target
  ON extracted_claims(claim_type, target_hint, property_hint);

CREATE TABLE IF NOT EXISTS assertions (
  id                         TEXT PRIMARY KEY,
  scope_id                   TEXT NOT NULL DEFAULT 'workspace:default',
  policy_version             TEXT NOT NULL DEFAULT 'policy:v1',
  authority_scope            TEXT NOT NULL DEFAULT 'work',
  claim_type                 TEXT NOT NULL,
  target_type                TEXT NOT NULL,
  target_id                  TEXT NOT NULL,
  target_slug                TEXT,
  property                   TEXT NOT NULL,
  value_json                 JSONB NOT NULL,
  normalized_claim           TEXT NOT NULL,
  authority_summary          JSONB NOT NULL DEFAULT '{}',
  confidence                 REAL NOT NULL DEFAULT 0,
  evidence_count             INTEGER NOT NULL DEFAULT 0,
  authority_state            TEXT NOT NULL CHECK (authority_state IN ('unresolved', 'candidate', 'canonical', 'conflicted', 'rejected')),
  lifecycle_state            TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'stale', 'expired', 'archived', 'purged')),
  valid_from                 TIMESTAMPTZ,
  valid_until                TIMESTAMPTZ,
  supersedes_assertion_id    TEXT,
  superseded_by_assertion_id TEXT,
  conflict_set_id            TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assertions_target_property
  ON assertions(target_type, target_id, property);
CREATE INDEX IF NOT EXISTS idx_assertions_authority_lifecycle
  ON assertions(authority_state, lifecycle_state);

CREATE TABLE IF NOT EXISTS assertion_events (
  id                   TEXT PRIMARY KEY,
  assertion_id          TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
  event_type            TEXT NOT NULL,
  from_authority_state  TEXT,
  to_authority_state    TEXT,
  from_lifecycle_state  TEXT,
  to_lifecycle_state    TEXT,
  reason                TEXT NOT NULL DEFAULT '',
  source_refs_json      JSONB NOT NULL DEFAULT '[]',
  actor                 TEXT NOT NULL DEFAULT '',
  job_id                TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assertion_events_assertion_created
  ON assertion_events(assertion_id, created_at DESC);

CREATE TABLE IF NOT EXISTS assertion_evidence (
  id                  TEXT PRIMARY KEY,
  assertion_id         TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
  scope_id             TEXT NOT NULL DEFAULT 'workspace:default',
  policy_version       TEXT NOT NULL DEFAULT 'policy:v1',
  authority_scope      TEXT NOT NULL DEFAULT 'work',
  extracted_claim_id   TEXT NOT NULL,
  source_id            TEXT NOT NULL,
  source_item_id       TEXT NOT NULL,
  source_chunk_id      TEXT NOT NULL,
  session_id           TEXT,
  task_event_id        TEXT,
  contribution_type    TEXT NOT NULL CHECK (contribution_type IN ('supports', 'contradicts', 'supersedes', 'superseded_by', 'context', 'audit_only')),
  evidence_authority   TEXT NOT NULL,
  evidence_confidence  REAL NOT NULL,
  valid_from           TIMESTAMPTZ,
  valid_until          TIMESTAMPTZ,
  revocation_state     TEXT NOT NULL DEFAULT 'active',
  forgetting_state     TEXT NOT NULL DEFAULT 'retained',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assertion_evidence_assertion
  ON assertion_evidence(assertion_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assertion_evidence_source
  ON assertion_evidence(source_id, source_item_id, source_chunk_id);

CREATE TABLE IF NOT EXISTS assertion_lineage (
  id                 TEXT PRIMARY KEY,
  assertion_id       TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
  extracted_claim_id TEXT NOT NULL,
  source_id          TEXT NOT NULL,
  source_item_id     TEXT NOT NULL,
  source_chunk_id    TEXT NOT NULL,
  session_id         TEXT,
  task_event_id      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assertion_links (
  id                 TEXT PRIMARY KEY,
  scope_id           TEXT NOT NULL DEFAULT 'workspace:default',
  policy_version     TEXT NOT NULL DEFAULT 'policy:v1',
  from_assertion_id  TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
  to_assertion_id    TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
  link_type          TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(from_assertion_id, to_assertion_id, link_type)
);

CREATE TABLE IF NOT EXISTS conflict_sets (
  id             TEXT PRIMARY KEY,
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  property       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conflict_set_assertions (
  conflict_set_id TEXT NOT NULL REFERENCES conflict_sets(id) ON DELETE CASCADE,
  assertion_id     TEXT NOT NULL REFERENCES assertions(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'member',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(conflict_set_id, assertion_id)
);

-- ============================================================
-- lifecycle forgetting and purge audit
-- ============================================================
CREATE TABLE IF NOT EXISTS forgetting_policies (
  id                      TEXT PRIMARY KEY,
  scope_id                TEXT NOT NULL DEFAULT 'workspace:default',
  entity_type             TEXT NOT NULL,
  source_kind             TEXT,
  claim_type              TEXT,
  sensitivity_level       TEXT,
  importance              TEXT,
  stale_after             TEXT,
  expire_after            TEXT,
  archive_after           TEXT,
  restore_window          TEXT,
  archive_retention       TEXT,
  purge_after             TEXT,
  purge_eligible          BOOLEAN NOT NULL DEFAULT false,
  report_visibility       TEXT NOT NULL DEFAULT 'summary' CHECK (report_visibility IN ('hidden', 'summary', 'audit')),
  policy_json             JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forgetting_policies_scope_entity
  ON forgetting_policies(scope_id, entity_type);

CREATE TABLE IF NOT EXISTS memory_lifecycle_states (
  id                       TEXT PRIMARY KEY,
  scope_id                 TEXT NOT NULL DEFAULT 'workspace:default',
  entity_type              TEXT NOT NULL,
  entity_id                TEXT NOT NULL,
  lifecycle_state          TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'stale', 'expired', 'archived', 'purged')),
  policy_id                TEXT REFERENCES forgetting_policies(id) ON DELETE SET NULL,
  reason                   TEXT NOT NULL DEFAULT '',
  source_id                TEXT,
  sensitivity_level        TEXT,
  importance               TEXT,
  restore_until            TIMESTAMPTZ,
  purge_after              TIMESTAMPTZ,
  last_transition_event_id TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scope_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_states_entity
  ON memory_lifecycle_states(scope_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_states_state
  ON memory_lifecycle_states(scope_id, lifecycle_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_states_purge_after
  ON memory_lifecycle_states(purge_after ASC)
  WHERE purge_after IS NOT NULL;

CREATE TABLE IF NOT EXISTS forgetting_events (
  id                   TEXT PRIMARY KEY,
  scope_id             TEXT NOT NULL DEFAULT 'workspace:default',
  entity_type          TEXT NOT NULL,
  entity_id            TEXT NOT NULL,
  event_type           TEXT NOT NULL,
  from_lifecycle_state TEXT CHECK (from_lifecycle_state IS NULL OR from_lifecycle_state IN ('active', 'stale', 'expired', 'archived', 'purged')),
  to_lifecycle_state   TEXT CHECK (to_lifecycle_state IS NULL OR to_lifecycle_state IN ('active', 'stale', 'expired', 'archived', 'purged')),
  policy_id            TEXT REFERENCES forgetting_policies(id) ON DELETE RESTRICT,
  reason               TEXT NOT NULL DEFAULT '',
  source_refs_json     JSONB NOT NULL DEFAULT '[]',
  actor                TEXT NOT NULL DEFAULT 'mbrain:lifecycle',
  job_id               TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forgetting_events_entity_created
  ON forgetting_events(scope_id, entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS purge_plans (
  id            TEXT PRIMARY KEY,
  scope_id      TEXT NOT NULL DEFAULT 'workspace:default',
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'applied', 'rejected', 'cancelled')),
  reason        TEXT NOT NULL DEFAULT '',
  requested_by  TEXT,
  review_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at   TIMESTAMPTZ,
  applied_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_purge_plans_scope_status
  ON purge_plans(scope_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS purge_plan_items (
  id                 TEXT PRIMARY KEY,
  plan_id            TEXT NOT NULL REFERENCES purge_plans(id) ON DELETE CASCADE,
  entity_type        TEXT NOT NULL,
  entity_id          TEXT NOT NULL,
  lifecycle_state    TEXT NOT NULL CHECK (lifecycle_state IN ('expired', 'archived', 'purged')),
  status             TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'approved', 'purged', 'skipped', 'blocked')),
  purge_after        TIMESTAMPTZ,
  tombstone_id       TEXT,
  before_hash        TEXT,
  evidence_ids_json  JSONB NOT NULL DEFAULT '[]',
  reason             TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purge_plan_items_plan
  ON purge_plan_items(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_purge_plan_items_target
  ON purge_plan_items(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS restore_events (
  id                   TEXT PRIMARY KEY,
  scope_id             TEXT NOT NULL DEFAULT 'workspace:default',
  entity_type          TEXT NOT NULL,
  entity_id            TEXT NOT NULL,
  from_lifecycle_state TEXT NOT NULL CHECK (from_lifecycle_state IN ('stale', 'expired', 'archived')),
  to_lifecycle_state   TEXT NOT NULL CHECK (to_lifecycle_state IN ('active', 'stale')),
  policy_id            TEXT REFERENCES forgetting_policies(id) ON DELETE RESTRICT,
  reason               TEXT NOT NULL DEFAULT '',
  source_refs_json     JSONB NOT NULL DEFAULT '[]',
  actor                TEXT NOT NULL DEFAULT 'mbrain:lifecycle',
  restored_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_restore_events_entity_restored
  ON restore_events(scope_id, entity_type, entity_id, restored_at DESC);

CREATE TABLE IF NOT EXISTS memory_tombstones (
  id             TEXT PRIMARY KEY,
  scope_id       TEXT NOT NULL DEFAULT 'workspace:default',
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  purge_event_id TEXT REFERENCES forgetting_events(id) ON DELETE RESTRICT,
  purge_plan_id  TEXT REFERENCES purge_plans(id) ON DELETE RESTRICT,
  reason         TEXT NOT NULL DEFAULT '',
  content_hash   TEXT,
  metadata_json  JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scope_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_tombstones_entity
  ON memory_tombstones(scope_id, entity_type, entity_id);

CREATE OR REPLACE FUNCTION prevent_lifecycle_audit_mutation()
RETURNS trigger AS \$\$
BEGIN
  RAISE EXCEPTION 'lifecycle audit tables are append-only';
END;
\$\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_forgetting_events_update ON forgetting_events;
CREATE TRIGGER prevent_forgetting_events_update
  BEFORE UPDATE ON forgetting_events
  FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();
DROP TRIGGER IF EXISTS prevent_forgetting_events_delete ON forgetting_events;
CREATE TRIGGER prevent_forgetting_events_delete
  BEFORE DELETE ON forgetting_events
  FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();

DROP TRIGGER IF EXISTS prevent_restore_events_update ON restore_events;
CREATE TRIGGER prevent_restore_events_update
  BEFORE UPDATE ON restore_events
  FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();
DROP TRIGGER IF EXISTS prevent_restore_events_delete ON restore_events;
CREATE TRIGGER prevent_restore_events_delete
  BEFORE DELETE ON restore_events
  FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();

DROP TRIGGER IF EXISTS prevent_memory_tombstones_update ON memory_tombstones;
CREATE TRIGGER prevent_memory_tombstones_update
  BEFORE UPDATE ON memory_tombstones
  FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();
DROP TRIGGER IF EXISTS prevent_memory_tombstones_delete ON memory_tombstones;
CREATE TRIGGER prevent_memory_tombstones_delete
  BEFORE DELETE ON memory_tombstones
  FOR EACH ROW EXECUTE FUNCTION prevent_lifecycle_audit_mutation();

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  realm         TEXT NOT NULL,
  workspace     TEXT NOT NULL DEFAULT '',
  client_kind   TEXT NOT NULL,
  trust_level   TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  close_status  TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT,
  session_id         TEXT,
  event_kind         TEXT NOT NULL,
  actor              TEXT NOT NULL,
  summary            TEXT NOT NULL DEFAULT '',
  payload_hash       TEXT,
  source_refs        JSONB NOT NULL DEFAULT '[]',
  generated_assertion_ids JSONB NOT NULL DEFAULT '[]',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_created
  ON task_events(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_attempts_v2 (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  session_id        TEXT,
  attempt_number    INTEGER NOT NULL,
  goal              TEXT NOT NULL DEFAULT '',
  changed_files     JSONB NOT NULL DEFAULT '[]',
  command_summaries JSONB NOT NULL DEFAULT '[]',
  test_summaries    JSONB NOT NULL DEFAULT '[]',
  result            TEXT NOT NULL,
  failure_class     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS working_sets_v2 (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL,
  file_paths    JSONB NOT NULL DEFAULT '[]',
  source_ids    JSONB NOT NULL DEFAULT '[]',
  assertion_ids JSONB NOT NULL DEFAULT '[]',
  projection_ids JSONB NOT NULL DEFAULT '[]',
  reason        TEXT NOT NULL DEFAULT '',
  expires_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS handoffs (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT,
  session_id         TEXT,
  resume_summary     TEXT NOT NULL,
  pending_decisions  JSONB NOT NULL DEFAULT '[]',
  next_actions       JSONB NOT NULL DEFAULT '[]',
  linked_assertion_ids JSONB NOT NULL DEFAULT '[]',
  linked_projection_ids JSONB NOT NULL DEFAULT '[]',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_grants (
  id                TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  realm              TEXT NOT NULL,
  allowed_tools      JSONB NOT NULL DEFAULT '[]',
  raw_access_policy  JSONB NOT NULL DEFAULT '{}',
  write_policy       JSONB NOT NULL DEFAULT '{}',
  expires_at         TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_source_grants (
  id                  TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL,
  source_id            TEXT,
  source_kind          TEXT,
  raw_scope            TEXT NOT NULL,
  max_chunk_count      INTEGER,
  valid_from           TIMESTAMPTZ,
  valid_until          TIMESTAMPTZ,
  sensitivity_ceiling  TEXT NOT NULL,
  expires_at           TIMESTAMPTZ,
  revoked_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_write_grants (
  id                       TEXT PRIMARY KEY,
  session_id                TEXT NOT NULL,
  target_scope              TEXT NOT NULL,
  allowed_policy_outcomes   JSONB NOT NULL DEFAULT '[]',
  expires_at                TIMESTAMPTZ,
  revoked_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- governed canonical write ledger and projection state
-- ============================================================
CREATE TABLE IF NOT EXISTS canonical_write_attempts (
  id                          TEXT PRIMARY KEY,
  policy_decision             TEXT NOT NULL CHECK (policy_decision IN ('auto_canonical', 'candidate', 'verify_first', 'conflict', 'reject', 'quarantine', 'no_write')),
  policy_explanation          TEXT NOT NULL DEFAULT '',
  policy_explanation_hash     TEXT,
  assertion_ids               JSONB NOT NULL DEFAULT '[]',
  assertion_evidence_ids      JSONB NOT NULL DEFAULT '[]',
  extracted_claim_ids         JSONB NOT NULL DEFAULT '[]',
  source_refs                 JSONB NOT NULL DEFAULT '[]',
  target_projection_ids       JSONB NOT NULL DEFAULT '[]',
  before_db_hash              TEXT,
  after_db_hash               TEXT,
  before_markdown_hash        TEXT,
  after_markdown_hash         TEXT,
  actor                       TEXT NOT NULL DEFAULT '',
  session_id                  TEXT,
  job_id                      TEXT,
  runner_id                   TEXT,
  status                      TEXT NOT NULL CHECK (status IN ('applied', 'pending_reconcile', 'failed_db', 'failed_markdown', 'conflict')),
  error_json                  JSONB NOT NULL DEFAULT '{}',
  metadata_json               JSONB NOT NULL DEFAULT '{}',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_write_attempts_status_created
  ON canonical_write_attempts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_write_attempts_session_created
  ON canonical_write_attempts(session_id, created_at DESC)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_canonical_write_attempts_policy_created
  ON canonical_write_attempts(policy_decision, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_projection_mutations (
  id                          TEXT PRIMARY KEY,
  canonical_write_attempt_id  TEXT REFERENCES canonical_write_attempts(id) ON DELETE CASCADE,
  projection_kind             TEXT NOT NULL,
  projection_slug             TEXT NOT NULL,
  mutation_kind               TEXT NOT NULL,
  assertion_ids               JSONB NOT NULL DEFAULT '[]',
  assertion_evidence_ids      JSONB NOT NULL DEFAULT '[]',
  extracted_claim_ids         JSONB NOT NULL DEFAULT '[]',
  source_refs                 JSONB NOT NULL DEFAULT '[]',
  before_markdown_hash        TEXT,
  after_markdown_hash         TEXT,
  status                      TEXT NOT NULL CHECK (status IN ('planned', 'applied', 'failed_markdown', 'pending_reconcile')),
  error_message               TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_projection_mutations_projection_created
  ON canonical_projection_mutations(projection_kind, projection_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_projection_mutations_status_created
  ON canonical_projection_mutations(status, created_at DESC);

CREATE TABLE IF NOT EXISTS canonical_projection_reconcile_marks (
  id                          TEXT PRIMARY KEY,
  canonical_write_attempt_id  TEXT REFERENCES canonical_write_attempts(id) ON DELETE SET NULL,
  projection_kind             TEXT NOT NULL,
  projection_slug             TEXT NOT NULL,
  assertion_ids               JSONB NOT NULL DEFAULT '[]',
  projection_ids              JSONB NOT NULL DEFAULT '[]',
  status                      TEXT NOT NULL CHECK (status IN ('pending_reconcile', 'reconciled', 'failed')),
  reason                      TEXT NOT NULL CHECK (reason IN ('failed_markdown', 'failed_ledger', 'projection_drift', 'manual_review')),
  error_message               TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_projection_reconcile_marks_status_updated
  ON canonical_projection_reconcile_marks(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_projection_reconcile_marks_projection_updated
  ON canonical_projection_reconcile_marks(projection_kind, projection_slug, updated_at DESC);

CREATE TABLE IF NOT EXISTS canonical_projection_targets (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('markdown_page', 'page_timeline', 'profile_memory', 'personal_episode', 'task_resume', 'project_doc', 'system_doc', 'source_summary', 'daily_report')),
  target_id TEXT NOT NULL,
  locator TEXT NOT NULL,
  source_assertion_ids JSONB NOT NULL DEFAULT '[]',
  projection_hash TEXT NOT NULL,
  rendered_markdown TEXT NOT NULL DEFAULT '',
  last_rendered_at TIMESTAMPTZ,
  last_reconciled_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('applied', 'pending_reconcile', 'reconciled', 'failed', 'conflict')),
  runtime_only BOOLEAN NOT NULL DEFAULT false,
  canonical_changed_since_projection BOOLEAN NOT NULL DEFAULT false,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_projection_targets_target
  ON canonical_projection_targets(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_canonical_projection_targets_status_updated
  ON canonical_projection_targets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_projection_targets_locator
  ON canonical_projection_targets(locator);

-- ============================================================
-- task-memory: operational continuity records
-- ============================================================
CREATE TABLE IF NOT EXISTS task_threads (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  title           TEXT NOT NULL,
  goal            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,
  repo_path       TEXT,
  branch_name     TEXT,
  current_summary TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_threads_status_updated ON task_threads(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_threads_scope_updated ON task_threads(scope, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_working_sets (
  task_id             TEXT PRIMARY KEY REFERENCES task_threads(id) ON DELETE CASCADE,
  active_paths        JSONB NOT NULL DEFAULT '[]',
  active_symbols      JSONB NOT NULL DEFAULT '[]',
  blockers            JSONB NOT NULL DEFAULT '[]',
  open_questions      JSONB NOT NULL DEFAULT '[]',
  next_steps          JSONB NOT NULL DEFAULT '[]',
  verification_notes  JSONB NOT NULL DEFAULT '[]',
  last_verified_at    TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_attempts (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES task_threads(id) ON DELETE CASCADE,
  summary               TEXT NOT NULL,
  outcome               TEXT NOT NULL,
  applicability_context JSONB NOT NULL DEFAULT '{}',
  evidence              JSONB NOT NULL DEFAULT '[]',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_attempts_task_created ON task_attempts(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_decisions (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES task_threads(id) ON DELETE CASCADE,
  summary          TEXT NOT NULL,
  rationale        TEXT NOT NULL DEFAULT '',
  consequences     JSONB NOT NULL DEFAULT '[]',
  validity_context JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_decisions_task_created ON task_decisions(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS retrieval_traces (
  id           TEXT PRIMARY KEY,
  task_id      TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
  scope        TEXT NOT NULL,
  route        JSONB NOT NULL DEFAULT '[]',
  source_refs  JSONB NOT NULL DEFAULT '[]',
  derived_consulted JSONB NOT NULL DEFAULT '[]',
  verification JSONB NOT NULL DEFAULT '[]',
  write_outcome TEXT NOT NULL DEFAULT 'no_durable_write',
  selected_intent TEXT,
  scope_gate_policy TEXT,
  scope_gate_reason TEXT,
  outcome      TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_retrieval_traces_task_created ON retrieval_traces(task_id, created_at DESC);

-- ============================================================
-- note_manifest_entries: deterministic structural extraction cache
-- ============================================================
CREATE TABLE IF NOT EXISTS note_manifest_entries (
  scope_id           TEXT NOT NULL,
  page_id            INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  slug               TEXT NOT NULL,
  path               TEXT NOT NULL,
  page_type          TEXT NOT NULL,
  title              TEXT NOT NULL,
  frontmatter        JSONB NOT NULL DEFAULT '{}',
  aliases            JSONB NOT NULL DEFAULT '[]',
  tags               JSONB NOT NULL DEFAULT '[]',
  outgoing_wikilinks JSONB NOT NULL DEFAULT '[]',
  outgoing_urls      JSONB NOT NULL DEFAULT '[]',
  source_refs        JSONB NOT NULL DEFAULT '[]',
  heading_index      JSONB NOT NULL DEFAULT '[]',
  content_hash       TEXT NOT NULL,
  extractor_version  TEXT NOT NULL,
  last_indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_slug
  ON note_manifest_entries(scope_id, slug);
CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_indexed
  ON note_manifest_entries(scope_id, last_indexed_at DESC);

-- ============================================================
-- note_section_entries: deterministic section-level extraction cache
-- ============================================================
CREATE TABLE IF NOT EXISTS note_section_entries (
  scope_id           TEXT NOT NULL,
  page_id            INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  page_slug          TEXT NOT NULL,
  page_path          TEXT NOT NULL,
  section_id         TEXT NOT NULL,
  parent_section_id  TEXT,
  heading_slug       TEXT NOT NULL,
  heading_path       JSONB NOT NULL DEFAULT '[]',
  heading_text       TEXT NOT NULL,
  depth              INTEGER NOT NULL,
  line_start         INTEGER NOT NULL,
  line_end           INTEGER NOT NULL,
  section_text       TEXT NOT NULL,
  outgoing_wikilinks JSONB NOT NULL DEFAULT '[]',
  outgoing_urls      JSONB NOT NULL DEFAULT '[]',
  source_refs        JSONB NOT NULL DEFAULT '[]',
  content_hash       TEXT NOT NULL,
  extractor_version  TEXT NOT NULL,
  last_indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, section_id)
);

CREATE INDEX IF NOT EXISTS idx_note_sections_scope_page
  ON note_section_entries(scope_id, page_slug, line_start);
CREATE INDEX IF NOT EXISTS idx_note_sections_scope_indexed
  ON note_section_entries(scope_id, last_indexed_at DESC);

-- ============================================================
-- context_map_entries: persisted deterministic structural map artifacts
-- ============================================================
CREATE TABLE IF NOT EXISTS context_map_entries (
  id                TEXT PRIMARY KEY,
  scope_id          TEXT NOT NULL,
  kind              TEXT NOT NULL,
  title             TEXT NOT NULL,
  build_mode        TEXT NOT NULL,
  status            TEXT NOT NULL,
  source_set_hash   TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  node_count        INTEGER NOT NULL,
  edge_count        INTEGER NOT NULL,
  community_count   INTEGER NOT NULL DEFAULT 0,
  graph_json        JSONB NOT NULL DEFAULT '{}',
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  stale_reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_context_map_scope_generated
  ON context_map_entries(scope_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_map_scope_kind
  ON context_map_entries(scope_id, kind);

-- ============================================================
-- context_atlas_entries: persisted registry over context maps
-- ============================================================
CREATE TABLE IF NOT EXISTS context_atlas_entries (
  id           TEXT PRIMARY KEY,
  map_id       TEXT NOT NULL REFERENCES context_map_entries(id) ON DELETE CASCADE,
  scope_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  freshness    TEXT NOT NULL,
  entrypoints  JSONB NOT NULL DEFAULT '[]',
  budget_hint  INTEGER NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_context_atlas_scope_generated
  ON context_atlas_entries(scope_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_atlas_scope_kind
  ON context_atlas_entries(scope_id, kind);

-- ============================================================
-- derived_jobs / derived_index_state: durable derived refresh outbox
-- ============================================================
CREATE TABLE IF NOT EXISTS derived_jobs (
  id                  TEXT PRIMARY KEY,
  scope_id            TEXT NOT NULL,
  slug                TEXT NOT NULL,
  artifact_kind       TEXT NOT NULL CHECK (artifact_kind IN ('page_chunks', 'note_manifest', 'note_sections', 'context_map', 'context_atlas')),
  target_content_hash TEXT NOT NULL,
  manifest_path       TEXT,
  derived_parameters  JSONB NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL CHECK (status IN ('pending', 'running', 'failed', 'superseded')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  lease_owner         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_derived_jobs_pending
  ON derived_jobs(status, updated_at ASC)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_derived_jobs_active_slug_artifact
  ON derived_jobs(scope_id, slug, artifact_kind)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_derived_jobs_scope_slug
  ON derived_jobs(scope_id, slug, updated_at DESC);

CREATE TABLE IF NOT EXISTS derived_index_state (
  scope_id               TEXT NOT NULL,
  slug                   TEXT NOT NULL,
  artifact_kind          TEXT NOT NULL CHECK (artifact_kind IN ('page_chunks', 'note_manifest', 'note_sections', 'context_map', 'context_atlas')),
  target_content_hash    TEXT NOT NULL,
  indexed_content_hash   TEXT,
  status                 TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  extractor_version      TEXT NOT NULL,
  derived_schema_version TEXT NOT NULL,
  last_error             TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, slug, artifact_kind)
);

CREATE INDEX IF NOT EXISTS idx_derived_index_state_status
  ON derived_index_state(scope_id, status, updated_at DESC);

-- ============================================================
-- memory_jobs: durable maintenance runtime job queue
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_jobs (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  queue             TEXT NOT NULL DEFAULT 'maintenance',
  status            TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'completed', 'failed', 'dead', 'cancelled', 'delayed', 'paused', 'waiting_children')),
  priority          INTEGER NOT NULL DEFAULT 0,
  payload_json      JSONB NOT NULL DEFAULT '{}',
  result_json       JSONB,
  progress_json     JSONB NOT NULL DEFAULT '{}',
  max_attempts      INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
  attempts_started  INTEGER NOT NULL DEFAULT 0 CHECK (attempts_started >= 0),
  attempts_finished INTEGER NOT NULL DEFAULT 0 CHECK (attempts_finished >= 0),
  backoff_type      TEXT NOT NULL DEFAULT 'none' CHECK (backoff_type IN ('none', 'fixed', 'exponential')),
  backoff_delay_ms  INTEGER NOT NULL DEFAULT 0 CHECK (backoff_delay_ms >= 0),
  lock_token        TEXT,
  lock_owner        TEXT,
  lock_expires_at   TIMESTAMPTZ,
  timeout_ms        INTEGER CHECK (timeout_ms IS NULL OR timeout_ms > 0),
  timeout_at        TIMESTAMPTZ,
  idempotency_key   TEXT,
  parent_job_id     TEXT REFERENCES memory_jobs(id) ON DELETE SET NULL,
  failure_class     TEXT CHECK (
    failure_class IS NULL OR failure_class IN (
      'database',
      'lock_timeout',
      'runner_unavailable',
      'llm_unavailable',
      'policy_denied',
      'source_unavailable',
      'prompt_injection_quarantine',
      'secret_redaction_required',
      'projection_failed',
      'timeout',
      'cancelled',
      'internal'
    )
  ),
  last_error        TEXT,
  next_run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_jobs_active_idempotency
  ON memory_jobs(idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'dead', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_memory_jobs_claimable
  ON memory_jobs(queue, status, priority DESC, next_run_at ASC, created_at ASC)
  WHERE status IN ('waiting', 'delayed', 'active');
CREATE INDEX IF NOT EXISTS idx_memory_jobs_name_status
  ON memory_jobs(name, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_parent
  ON memory_jobs(parent_job_id)
  WHERE parent_job_id IS NOT NULL;

-- ============================================================
-- memory_job_events/logs/artifacts: append-only runtime audit trail
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_job_events (
  id            TEXT PRIMARY KEY,
  job_id        TEXT REFERENCES memory_jobs(id) ON DELETE SET NULL,
  event_type    TEXT NOT NULL,
  worker_id     TEXT,
  failure_class TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_job_events_job_created
  ON memory_job_events(job_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_memory_job_events_type_created
  ON memory_job_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_job_logs (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,
  level         TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message       TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_job_logs_job_created
  ON memory_job_logs(job_id, created_at ASC);

CREATE TABLE IF NOT EXISTS memory_job_artifacts (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES memory_jobs(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  artifact_ref  TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_job_artifacts_job_kind
  ON memory_job_artifacts(job_id, artifact_kind, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_maintenance_audit_mutation()
RETURNS trigger AS \$\$
BEGIN
  RAISE EXCEPTION 'maintenance audit tables are append-only';
END;
\$\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_memory_job_events_update ON memory_job_events;
CREATE TRIGGER prevent_memory_job_events_update
  BEFORE UPDATE ON memory_job_events
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
DROP TRIGGER IF EXISTS prevent_memory_job_events_delete ON memory_job_events;
CREATE TRIGGER prevent_memory_job_events_delete
  BEFORE DELETE ON memory_job_events
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

DROP TRIGGER IF EXISTS prevent_memory_job_logs_update ON memory_job_logs;
CREATE TRIGGER prevent_memory_job_logs_update
  BEFORE UPDATE ON memory_job_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
DROP TRIGGER IF EXISTS prevent_memory_job_logs_delete ON memory_job_logs;
CREATE TRIGGER prevent_memory_job_logs_delete
  BEFORE DELETE ON memory_job_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

DROP TRIGGER IF EXISTS prevent_memory_job_artifacts_update ON memory_job_artifacts;
CREATE TRIGGER prevent_memory_job_artifacts_update
  BEFORE UPDATE ON memory_job_artifacts
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
DROP TRIGGER IF EXISTS prevent_memory_job_artifacts_delete ON memory_job_artifacts;
CREATE TRIGGER prevent_memory_job_artifacts_delete
  BEFORE DELETE ON memory_job_artifacts
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

-- ============================================================
-- runner_jobs/tool_calls/messages/artifacts: restricted maintenance runners
-- ============================================================
CREATE TABLE IF NOT EXISTS runner_jobs (
  id                               TEXT PRIMARY KEY,
  memory_job_id                    TEXT REFERENCES memory_jobs(id) ON DELETE RESTRICT,
  runner_kind                      TEXT NOT NULL CHECK (runner_kind IN ('claude_code', 'codex', 'local_model', 'remote_model', 'deterministic_fallback')),
  runner_version                   TEXT,
  model                            TEXT,
  provider                         TEXT,
  task_type                        TEXT NOT NULL CHECK (task_type IN ('assertion_extraction', 'consolidation_review', 'contradiction_review', 'forgetting_review', 'source_summary', 'daily_report')),
  source_scope_json                JSONB NOT NULL DEFAULT '{}',
  prompt_hash                      TEXT NOT NULL,
  input_hash                       TEXT NOT NULL,
  output_hash                      TEXT,
  status                           TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'degraded', 'cancelled')),
  failure_class                    TEXT CHECK (
    failure_class IS NULL OR failure_class IN (
      'database',
      'lock_timeout',
      'runner_unavailable',
      'llm_unavailable',
      'policy_denied',
      'source_unavailable',
      'prompt_injection_quarantine',
      'secret_redaction_required',
      'projection_failed',
      'timeout',
      'cancelled',
      'internal'
    )
  ),
  token_usage_json                 JSONB NOT NULL DEFAULT '{}',
  cost_estimate_usd                NUMERIC(12,6),
  can_execute_shell                BOOLEAN NOT NULL DEFAULT false CHECK (can_execute_shell = false),
  can_access_connector_credentials BOOLEAN NOT NULL DEFAULT false CHECK (can_access_connector_credentials = false),
  created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runner_jobs_task_status
  ON runner_jobs(task_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_memory_job
  ON runner_jobs(memory_job_id)
  WHERE memory_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runner_jobs_source_scope
  ON runner_jobs USING GIN(source_scope_json);

CREATE OR REPLACE FUNCTION prevent_runner_job_identity_mutation()
RETURNS trigger AS \$\$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'runner jobs are append-only';
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.memory_job_id IS DISTINCT FROM NEW.memory_job_id
    OR OLD.runner_kind IS DISTINCT FROM NEW.runner_kind
    OR OLD.runner_version IS DISTINCT FROM NEW.runner_version
    OR OLD.model IS DISTINCT FROM NEW.model
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.task_type IS DISTINCT FROM NEW.task_type
    OR OLD.source_scope_json IS DISTINCT FROM NEW.source_scope_json
    OR OLD.prompt_hash IS DISTINCT FROM NEW.prompt_hash
    OR OLD.input_hash IS DISTINCT FROM NEW.input_hash
    OR OLD.can_execute_shell IS DISTINCT FROM NEW.can_execute_shell
    OR OLD.can_access_connector_credentials IS DISTINCT FROM NEW.can_access_connector_credentials
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'runner job identity fields are append-only';
  END IF;

  RETURN NEW;
END;
\$\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_runner_jobs_identity_update ON runner_jobs;
CREATE TRIGGER prevent_runner_jobs_identity_update
  BEFORE UPDATE ON runner_jobs
  FOR EACH ROW EXECUTE FUNCTION prevent_runner_job_identity_mutation();
DROP TRIGGER IF EXISTS prevent_runner_jobs_delete ON runner_jobs;
CREATE TRIGGER prevent_runner_jobs_delete
  BEFORE DELETE ON runner_jobs
  FOR EACH ROW EXECUTE FUNCTION prevent_runner_job_identity_mutation();

CREATE TABLE IF NOT EXISTS runner_tool_calls (
  id                TEXT PRIMARY KEY,
  runner_job_id     TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  tool_name         TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('allowed', 'denied', 'failed', 'succeeded')),
  policy_reason     TEXT NOT NULL DEFAULT '',
  request_hash      TEXT NOT NULL,
  response_hash     TEXT,
  token_usage_json  JSONB NOT NULL DEFAULT '{}',
  cost_estimate_usd NUMERIC(12,6),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runner_tool_calls_job_created
  ON runner_tool_calls(runner_job_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_runner_tool_calls_name_status
  ON runner_tool_calls(tool_name, status, created_at DESC);

CREATE TABLE IF NOT EXISTS runner_messages (
  id               TEXT PRIMARY KEY,
  runner_job_id    TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content_hash     TEXT NOT NULL,
  redacted_preview TEXT NOT NULL DEFAULT '',
  token_count      INTEGER NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runner_messages_job_created
  ON runner_messages(runner_job_id, created_at ASC);

CREATE TABLE IF NOT EXISTS runner_artifacts (
  id             TEXT PRIMARY KEY,
  runner_job_id  TEXT NOT NULL REFERENCES runner_jobs(id) ON DELETE CASCADE,
  artifact_kind  TEXT NOT NULL,
  artifact_ref   TEXT NOT NULL,
  content_hash   TEXT,
  metadata_json  JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runner_artifacts_job_kind
  ON runner_artifacts(runner_job_id, artifact_kind, created_at DESC);

DROP TRIGGER IF EXISTS prevent_runner_tool_calls_update ON runner_tool_calls;
CREATE TRIGGER prevent_runner_tool_calls_update
  BEFORE UPDATE ON runner_tool_calls
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
DROP TRIGGER IF EXISTS prevent_runner_tool_calls_delete ON runner_tool_calls;
CREATE TRIGGER prevent_runner_tool_calls_delete
  BEFORE DELETE ON runner_tool_calls
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

DROP TRIGGER IF EXISTS prevent_runner_messages_update ON runner_messages;
CREATE TRIGGER prevent_runner_messages_update
  BEFORE UPDATE ON runner_messages
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
DROP TRIGGER IF EXISTS prevent_runner_messages_delete ON runner_messages;
CREATE TRIGGER prevent_runner_messages_delete
  BEFORE DELETE ON runner_messages
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

DROP TRIGGER IF EXISTS prevent_runner_artifacts_update ON runner_artifacts;
CREATE TRIGGER prevent_runner_artifacts_update
  BEFORE UPDATE ON runner_artifacts
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();
DROP TRIGGER IF EXISTS prevent_runner_artifacts_delete ON runner_artifacts;
CREATE TRIGGER prevent_runner_artifacts_delete
  BEFORE DELETE ON runner_artifacts
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_audit_mutation();

-- ============================================================
-- memory_cycle_locks / memory_worker_heartbeats: maintenance coordination
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_cycle_locks (
  id             TEXT PRIMARY KEY,
  cycle_name     TEXT NOT NULL UNIQUE,
  holder_pid     INTEGER NOT NULL,
  holder_host    TEXT NOT NULL,
  holder_kind    TEXT NOT NULL,
  acquired_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_cycle_locks_ttl
  ON memory_cycle_locks(ttl_expires_at ASC);

CREATE TABLE IF NOT EXISTS memory_worker_heartbeats (
  worker_id     TEXT PRIMARY KEY,
  worker_host   TEXT NOT NULL,
  worker_pid    INTEGER NOT NULL,
  queues        JSONB NOT NULL DEFAULT '[]',
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata_json JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_memory_worker_heartbeats_seen
  ON memory_worker_heartbeats(last_seen_at DESC);

-- ============================================================
-- memory_realms: control-plane realms for memory access policy
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_realms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL CHECK (scope IN ('work', 'personal', 'mixed')),
  default_access TEXT NOT NULL CHECK (default_access IN ('read_only', 'read_write')),
  retention_policy TEXT NOT NULL DEFAULT 'retain',
  export_policy TEXT NOT NULL DEFAULT 'private',
  agent_instructions TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_realms_scope
  ON memory_realms(scope, updated_at DESC);

-- ============================================================
-- memory_sessions: active agent memory sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'closed')),
  actor_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memory_sessions_status_created
  ON memory_sessions(status, created_at DESC);

-- ============================================================
-- memory_session_attachments: realms attached to sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_session_attachments (
  session_id TEXT NOT NULL REFERENCES memory_sessions(id) ON DELETE CASCADE,
  realm_id TEXT NOT NULL REFERENCES memory_realms(id) ON DELETE CASCADE,
  access TEXT NOT NULL CHECK (access IN ('read_only', 'read_write')),
  instructions TEXT NOT NULL DEFAULT '',
  attached_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, realm_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_session_attachments_realm
  ON memory_session_attachments(realm_id, attached_at DESC);

-- ============================================================
-- memory_redaction_plans: governed redaction lifecycle
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_redaction_plans (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  query TEXT NOT NULL,
  replacement_text TEXT NOT NULL DEFAULT '[REDACTED]',
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'applied', 'rejected')),
  requested_by TEXT,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memory_redaction_plans_scope_status
  ON memory_redaction_plans(scope_id, status, created_at DESC);

-- ============================================================
-- memory_redaction_plan_items: concrete redaction targets
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_redaction_plan_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES memory_redaction_plans(id) ON DELETE CASCADE,
  target_object_type TEXT NOT NULL,
  target_object_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'applied', 'unsupported')),
  preview_text TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_redaction_items_plan
  ON memory_redaction_plan_items(plan_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_redaction_items_target
  ON memory_redaction_plan_items(target_object_type, target_object_id);

-- ============================================================
-- memory_candidate_entries: governed inbox candidates
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_candidate_entries (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  candidate_type TEXT NOT NULL CHECK (candidate_type IN ('fact', 'relationship', 'note_update', 'procedure', 'profile_update', 'open_question', 'rationale')),
  proposed_content TEXT NOT NULL,
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_by TEXT NOT NULL CHECK (generated_by IN ('agent', 'map_analysis', 'dream_cycle', 'manual', 'import')),
  extraction_kind TEXT NOT NULL CHECK (extraction_kind IN ('extracted', 'inferred', 'ambiguous', 'manual')),
  confidence_score REAL NOT NULL,
  importance_score REAL NOT NULL,
  recurrence_score REAL NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'work', 'personal', 'secret', 'unknown')),
  status TEXT NOT NULL CHECK (status IN ('captured', 'candidate', 'staged_for_review', 'rejected', 'promoted', 'superseded')),
  target_object_type TEXT CHECK (target_object_type IS NULL OR target_object_type IN ('curated_note', 'procedure', 'profile_memory', 'personal_episode', 'other')),
  target_object_id TEXT,
  reviewed_at TIMESTAMPTZ,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  patch_target_kind TEXT CONSTRAINT chk_memory_candidate_entries_patch_target_kind CHECK (
    patch_target_kind IS NULL
    OR patch_target_kind IN (
      'page',
      'source_record',
      'task_thread',
      'working_set',
      'task_event',
      'task_episode',
      'attempt',
      'decision',
      'procedure',
      'memory_candidate',
      'memory_patch_candidate',
      'canonical_target_proposal',
      'profile_memory',
      'personal_episode',
      'memory_realm',
      'memory_session',
      'memory_session_attachment',
      'context_map',
      'context_atlas',
      'file_artifact',
      'export_artifact',
      'ledger_event'
    )
  ),
  patch_target_id TEXT,
  patch_base_target_snapshot_hash TEXT,
  patch_body JSONB CONSTRAINT chk_memory_candidate_entries_patch_body_object
    CHECK (patch_body IS NULL OR jsonb_typeof(patch_body) IN ('object', 'array')),
  patch_format TEXT CONSTRAINT chk_memory_candidate_entries_patch_format
    CHECK (patch_format IS NULL OR patch_format IN ('merge_patch', 'json_patch', 'unified_diff', 'whole_record', 'operation')),
  patch_operation_state TEXT CONSTRAINT chk_memory_candidate_entries_patch_operation_state
    CHECK (
      patch_operation_state IS NULL
      OR patch_operation_state IN (
        'proposed',
        'dry_run_validated',
        'approved_for_apply',
        'apply_in_progress',
        'applied',
        'conflicted',
        'failed'
      )
    ),
  patch_risk_class TEXT CONSTRAINT chk_memory_candidate_entries_patch_risk_class
    CHECK (patch_risk_class IS NULL OR patch_risk_class IN ('low', 'medium', 'high', 'critical', 'unknown')),
  patch_expected_resulting_target_snapshot_hash TEXT,
  patch_provenance_summary TEXT,
  patch_actor TEXT,
  patch_originating_session_id TEXT,
  patch_ledger_event_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT chk_memory_candidate_entries_patch_ledger_ids_array
    CHECK (jsonb_typeof(patch_ledger_event_ids) = 'array'),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CONSTRAINT memory_candidate_entries_verification_status_check
    CHECK (verification_status IN ('unverified', 'verified', 'refuted')),
  verification_method TEXT
    CONSTRAINT memory_candidate_entries_verification_method_check
    CHECK (verification_method IS NULL OR verification_method IN ('command_execution', 'db_query', 'file_inspection', 'source_recheck', 'user_confirmation', 'external_lookup')),
  verification_evidence TEXT,
  verification_source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_status
  ON memory_candidate_entries(scope_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_type
  ON memory_candidate_entries(scope_id, candidate_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_target
  ON memory_candidate_entries(target_object_type, target_object_id);
CREATE INDEX IF NOT EXISTS idx_memory_candidates_patch_state
  ON memory_candidate_entries(patch_operation_state, updated_at DESC)
  WHERE patch_operation_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_candidates_patch_target
  ON memory_candidate_entries(patch_target_kind, patch_target_id)
  WHERE patch_target_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_verification
  ON memory_candidate_entries(scope_id, verification_status, updated_at DESC);

-- ============================================================
-- canonical_target_proposals: reviewable homes for targetless candidates
-- ============================================================
CREATE TABLE IF NOT EXISTS canonical_target_proposal_entries (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  source_candidate_id TEXT NOT NULL
    CONSTRAINT fk_canonical_target_proposals_source_candidate
    REFERENCES memory_candidate_entries(id),
  linked_candidate_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(linked_candidate_ids) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')),
  status_reason TEXT,
  proposal_kind TEXT NOT NULL CHECK (proposal_kind IN ('project_root', 'project_doc', 'system_page', 'concept_page', 'idea_page', 'original_page')),
  target_object_type TEXT NOT NULL CHECK (target_object_type IN ('curated_note')),
  proposed_slug TEXT NOT NULL,
  proposed_title TEXT NOT NULL,
  proposed_page_type TEXT NOT NULL CHECK (proposed_page_type IN ('project', 'system', 'concept')),
  proposed_repo_path TEXT,
  confidence_score REAL NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
  importance_score REAL NOT NULL CHECK (importance_score >= 0 AND importance_score <= 1),
  rationale TEXT NOT NULL DEFAULT '',
  filing_basis JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filing_basis) = 'object'),
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_refs) = 'array'),
  candidate_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(candidate_snapshot) = 'object'),
  duplicate_review JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(duplicate_review) = 'object'),
  slug_quality_warnings JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(slug_quality_warnings) = 'array'),
  approval_actor TEXT,
  approved_at TIMESTAMPTZ,
  approval_reason TEXT,
  bound_candidate_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(bound_candidate_ids) = 'array'),
  stub_patch_candidate_id TEXT
    CONSTRAINT fk_canonical_target_proposals_stub_patch_candidate
    REFERENCES memory_candidate_entries(id),
  stub_patch_state TEXT,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  superseded_by TEXT
    CONSTRAINT fk_canonical_target_proposals_superseded_by
    REFERENCES canonical_target_proposal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_target_proposals_scope_status
  ON canonical_target_proposal_entries(scope_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_target_proposals_scope_slug
  ON canonical_target_proposal_entries(scope_id, proposed_slug);
CREATE INDEX IF NOT EXISTS idx_canonical_target_proposals_source_candidate
  ON canonical_target_proposal_entries(source_candidate_id);
CREATE INDEX IF NOT EXISTS idx_canonical_target_proposals_linked_candidates
  ON canonical_target_proposal_entries USING GIN (linked_candidate_ids);

CREATE TABLE IF NOT EXISTS canonical_target_proposal_status_events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL
    CONSTRAINT fk_canonical_target_proposal_status_events_proposal
    REFERENCES canonical_target_proposal_entries(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  from_status TEXT CHECK (
    from_status IS NULL
    OR from_status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')
  ),
  to_status TEXT NOT NULL CHECK (
    to_status IN ('proposed', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')
  ),
  event_kind TEXT NOT NULL CHECK (
    event_kind IN ('created', 'approved', 'patch_staged', 'bound', 'rejected', 'superseded', 'blocked')
  ),
  actor TEXT,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canonical_target_proposal_status_events_proposal_created
  ON canonical_target_proposal_status_events(proposal_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_target_proposal_status_events_scope_created
  ON canonical_target_proposal_status_events(scope_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_canonical_target_proposal_status_events_kind_created
  ON canonical_target_proposal_status_events(event_kind, created_at DESC, id DESC);

-- ============================================================
-- config: brain-level settings
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('version', '1'),
  ('embedding_model', 'qwen3-embedding:0.6b'),
  ('embedding_dimensions', '1024'),
  ('chunk_size_tokens', '768'),
  ('chunk_overlap_tokens', '128'),
  ('chunk_strategy', 'qwen3_token_recursive')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- access_tokens: bearer tokens for remote MCP access
-- ============================================================
CREATE TABLE IF NOT EXISTS access_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT[] DEFAULT ARRAY['mcp']::TEXT[],
  created_at   TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens (token_hash) WHERE revoked_at IS NULL;

-- ============================================================
-- oauth_dcr_clients: dynamic OAuth client registrations
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_dcr_clients (
  client_id                  TEXT PRIMARY KEY,
  client_name                TEXT NOT NULL,
  redirect_uris              TEXT[] NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  issued_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_authorized_at         TIMESTAMPTZ
);

ALTER TABLE oauth_dcr_clients
  ADD COLUMN IF NOT EXISTS last_authorized_at TIMESTAMPTZ;

-- ============================================================
-- oauth_authorization_codes: one-use OAuth authorization grants
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_dcr_clients(client_id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope          TEXT[] NOT NULL DEFAULT ARRAY['mcp'],
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_client
  ON oauth_authorization_codes(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_unexpired
  ON oauth_authorization_codes(expires_at)
  WHERE used_at IS NULL;

-- ============================================================
-- mcp_request_log: usage logging for remote MCP requests
-- ============================================================
CREATE TABLE IF NOT EXISTS mcp_request_log (
  id         SERIAL PRIMARY KEY,
  token_name TEXT,
  operation  TEXT NOT NULL,
  latency_ms INTEGER,
  status     TEXT NOT NULL DEFAULT 'success',
  error_code TEXT,
  error_reason TEXT,
  surface_profile TEXT,
  auth_principal_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- files: binary attachments stored in Supabase Storage
-- ============================================================
CREATE TABLE IF NOT EXISTS files (
  id           SERIAL PRIMARY KEY,
  page_slug    TEXT   REFERENCES pages(slug) ON DELETE SET NULL ON UPDATE CASCADE,
  filename     TEXT   NOT NULL,
  storage_path TEXT   NOT NULL,
  mime_type    TEXT,
  size_bytes   BIGINT,
  content_hash TEXT   NOT NULL,
  metadata     JSONB  NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(storage_path)
);

-- Migration: drop storage_url if it exists (renamed to storage_path only)
ALTER TABLE files DROP COLUMN IF EXISTS storage_url;

CREATE INDEX IF NOT EXISTS idx_files_page ON files(page_slug);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

-- ============================================================
-- Trigger-based search_vector (spans pages + timeline_entries)
-- ============================================================
ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_pages_search ON pages USING GIN(search_vector);

-- Function to rebuild search_vector for a page
CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS \$\$
DECLARE
  timeline_text TEXT;
BEGIN
  -- Gather timeline_entries text for this page
  SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '')
  INTO timeline_text
  FROM timeline_entries
  WHERE page_id = NEW.id;

  -- Build weighted tsvector
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.compiled_truth, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.search_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.timeline, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(timeline_text, '')), 'C');

  RETURN NEW;
END;
\$\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages;
CREATE TRIGGER trg_pages_search_vector
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION update_page_search_vector();

-- When timeline_entries change, update the parent page's search_vector
CREATE OR REPLACE FUNCTION update_page_search_vector_from_timeline() RETURNS trigger AS \$\$
DECLARE
  page_row pages%ROWTYPE;
BEGIN
  -- Touch the page to re-fire its trigger
  UPDATE pages SET updated_at = now()
  WHERE id = coalesce(NEW.page_id, OLD.page_id);
  RETURN NEW;
END;
\$\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_timeline_search_vector ON timeline_entries;
CREATE TRIGGER trg_timeline_search_vector
  AFTER INSERT OR UPDATE OR DELETE ON timeline_entries
  FOR EACH ROW
  EXECUTE FUNCTION update_page_search_vector_from_timeline();

-- ============================================================
-- Row Level Security: block anon access, postgres role bypasses
-- ============================================================
-- The postgres role (used by mbrain via pooler) has BYPASSRLS.
-- Enabling RLS with no policies means the anon key can't read anything.
-- Only enable if the current role actually has BYPASSRLS privilege,
-- otherwise we'd lock ourselves out.
DO \$\$
DECLARE
  has_bypass BOOLEAN;
BEGIN
  SELECT rolbypassrls INTO has_bypass FROM pg_roles WHERE rolname = current_user;
  IF has_bypass THEN
    ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE content_chunks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE links ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
    ALTER TABLE raw_data ENABLE ROW LEVEL SECURITY;
    ALTER TABLE timeline_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE page_versions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ingest_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE config ENABLE ROW LEVEL SECURITY;
    ALTER TABLE files ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE 'RLS enabled on all tables (role % has BYPASSRLS)', current_user;
  ELSE
    RAISE WARNING 'Skipping RLS: role % does not have BYPASSRLS privilege. Run as postgres role to enable.', current_user;
  END IF;
END \$\$;
`;
