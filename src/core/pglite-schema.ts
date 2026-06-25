// AUTO-GENERATED — do not edit. Run: bun run build:schema
// Source: src/schema.sql (PGLite transform)
// Excludes source registry, governed ledger, restricted runner, remote auth/OAuth/files, lifecycle forgetting, and RLS blocks from the Postgres schema.
// PGLite starts from this local baseline and then applies src/core/migrate.ts migrations.

export const PGLITE_SCHEMA_SQL = `
-- MBrain PGLite schema (local embedded Postgres)

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
-- memory_write_sessions: router-issued one-shot canonical write grants
-- ============================================================
CREATE OR REPLACE FUNCTION mbrain_trim_memory_text(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS \$mbrain\$
  SELECT btrim(
    input,
    chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) ||
    chr(160) || chr(5760) ||
    chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) ||
    chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) ||
    chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) ||
    chr(12288) || chr(65279)
  )
\$mbrain\$;

CREATE OR REPLACE FUNCTION mbrain_jsonb_non_empty_string_array(input jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS \$mbrain\$
  SELECT CASE
    WHEN jsonb_typeof(input) IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(input) = 0 THEN false
    ELSE COALESCE((
      SELECT bool_and(
        jsonb_typeof(entry.value) = 'string'
        AND mbrain_trim_memory_text(entry.value #>> '{}') <> ''
      )
      FROM jsonb_array_elements(input) AS entry(value)
    ), false)
  END
\$mbrain\$;

CREATE TABLE IF NOT EXISTS memory_write_sessions (
  id TEXT PRIMARY KEY,
  route_decision_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  memory_session_id TEXT,
  target_slug TEXT NOT NULL CHECK (btrim(target_slug) <> ''),
  target_object_type TEXT NOT NULL,
  expected_content_hash TEXT,
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (mbrain_jsonb_non_empty_string_array(source_refs)),
  route_decision TEXT NOT NULL CHECK (route_decision IN ('canonical_write_allowed')),
  intended_operation TEXT NOT NULL CHECK (intended_operation IN ('put_page')),
  route_reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(route_reasons) = 'array'),
  missing_requirements JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_requirements) = 'array'),
  governance_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(governance_metadata) = 'object'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'superseded', 'expired', 'abandoned')),
  status_reason TEXT,
  consumed_by_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'open' AND consumed_at IS NULL)
    OR (status <> 'open' AND consumed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_memory_write_sessions_scope_status_created
  ON memory_write_sessions(scope_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_memory_write_sessions_status_expires
  ON memory_write_sessions(status, expires_at ASC);
CREATE INDEX IF NOT EXISTS idx_memory_write_sessions_scope_target_created
  ON memory_write_sessions(scope_id, target_slug, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_memory_write_sessions_actor_created
  ON memory_write_sessions(actor, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_memory_write_sessions_consumed_event
  ON memory_write_sessions(consumed_by_event_id)
  WHERE consumed_by_event_id IS NOT NULL;

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
-- config: brain-level settings
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('version', '1'),
  ('engine', 'pglite'),
  ('embedding_model', 'qwen3-embedding:0.6b'),
  ('embedding_dimensions', '1024'),
  ('chunk_size_tokens', '768'),
  ('chunk_overlap_tokens', '128'),
  ('chunk_strategy', 'qwen3_token_recursive')
ON CONFLICT (key) DO NOTHING;

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
`;
