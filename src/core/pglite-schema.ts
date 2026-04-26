/**
 * PGLite schema — derived from schema-embedded.ts (Postgres schema).
 *
 * Differences from Postgres:
 * - No RLS block (no role system in embedded PGLite)
 * - No access_tokens / mcp_request_log (local-only, no remote auth)
 * - No files table (file attachments require Supabase Storage)
 * - No pg_advisory_lock (single connection)
 *
 * Everything else is identical: same tables, triggers, indexes, pgvector HNSW, tsvector GIN.
 *
 * DRIFT WARNING: When schema-embedded.ts changes, update this file to match.
 * test/edge-bundle.test.ts has a drift detection test.
 */

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
  page_embedding vector(768),
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
  embedding     vector(768),
  model         TEXT    NOT NULL DEFAULT 'nomic-embed-text',
  token_count   INTEGER,
  embedded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);

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
-- raw_data: sidecar data
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
-- page_versions: snapshot history
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
-- config: brain-level settings
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('version', '1'),
  ('engine', 'pglite'),
  ('embedding_model', 'nomic-embed-text'),
  ('embedding_dimensions', '768'),
  ('chunk_strategy', 'semantic')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Trigger-based search_vector (spans pages + timeline_entries)
-- ============================================================
ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_pages_search ON pages USING GIN(search_vector);

CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS $$
DECLARE
  timeline_text TEXT;
BEGIN
  SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '')
  INTO timeline_text
  FROM timeline_entries
  WHERE page_id = NEW.id;

  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.compiled_truth, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.search_text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.timeline, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(timeline_text, '')), 'C');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages;
CREATE TRIGGER trg_pages_search_vector
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION update_page_search_vector();

CREATE OR REPLACE FUNCTION update_page_search_vector_from_timeline() RETURNS trigger AS $$
DECLARE
  page_row pages%ROWTYPE;
BEGIN
  UPDATE pages SET updated_at = now()
  WHERE id = coalesce(NEW.page_id, OLD.page_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_timeline_search_vector ON timeline_entries;
CREATE TRIGGER trg_timeline_search_vector
  AFTER INSERT OR UPDATE OR DELETE ON timeline_entries
  FOR EACH ROW
  EXECUTE FUNCTION update_page_search_vector_from_timeline();
`;
