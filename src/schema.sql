-- GBrain Postgres + pgvector schema

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- gen_random_uuid() is core in Postgres 13+; enable pgcrypto as fallback for older versions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
  frontmatter   JSONB   NOT NULL DEFAULT '{}',
  content_hash  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_frontmatter ON pages USING GIN(frontmatter);
CREATE INDEX IF NOT EXISTS idx_pages_trgm ON pages USING GIN(title gin_trgm_ops);
-- v0.13.1 #170: avoids 14.6s seqscan on large brains when listing pages newest-first.
CREATE INDEX IF NOT EXISTS idx_pages_updated_at_desc ON pages (updated_at DESC);

-- ============================================================
-- content_chunks: chunked content with embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS content_chunks (
  id            SERIAL PRIMARY KEY,
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_text    TEXT    NOT NULL,
  chunk_source  TEXT    NOT NULL DEFAULT 'compiled_truth',
  embedding     vector(1536),
  model         TEXT    NOT NULL DEFAULT 'text-embedding-3-large',
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
-- Provenance model (v0.13):
--   link_source       — 'markdown' | 'frontmatter' | 'manual' | NULL
--                       (NULL = legacy row written before v0.13; unknown source)
--   origin_page_id    — for link_source='frontmatter', the page whose YAML
--                       frontmatter created this edge; scopes reconciliation
--   origin_field      — the frontmatter field name (e.g. 'key_people')
--
-- The unique constraint includes link_source + origin_page_id so a manual edge
-- and a frontmatter-derived edge with the same (from, to, type) tuple coexist.
-- Reconciliation on put_page filters by (link_source='frontmatter' AND
-- origin_page_id = written_page) — never touches other pages' edges.
CREATE TABLE IF NOT EXISTS links (
  id             SERIAL PRIMARY KEY,
  from_page_id   INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type      TEXT    NOT NULL DEFAULT '',
  context        TEXT    NOT NULL DEFAULT '',
  link_source    TEXT    CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual')),
  origin_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  origin_field   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT (PG15+) so two rows with link_source IS NULL or
  -- origin_page_id IS NULL collide as expected. Without this, every row with
  -- NULL origin_page_id (markdown/manual edges) would be treated as unique.
  CONSTRAINT links_from_to_type_source_origin_unique
    UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_page_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(link_source);
CREATE INDEX IF NOT EXISTS idx_links_origin ON links(origin_page_id);

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
-- Dedup constraint: same (page, date, summary) treated as same event
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup ON timeline_entries(page_id, date, summary);

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
-- config: brain-level settings
-- ============================================================
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('version', '1'),
  ('embedding_model', 'text-embedding-3-large'),
  ('embedding_dimensions', '1536'),
  ('chunk_strategy', 'semantic')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- access_tokens: bearer tokens for remote MCP access
-- ============================================================
CREATE TABLE IF NOT EXISTS access_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT[],
  created_at   TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens (token_hash) WHERE revoked_at IS NULL;

-- ============================================================
-- mcp_request_log: usage logging for remote MCP requests
-- ============================================================
CREATE TABLE IF NOT EXISTS mcp_request_log (
  id         SERIAL PRIMARY KEY,
  token_name TEXT,
  operation  TEXT NOT NULL,
  latency_ms INTEGER,
  status     TEXT NOT NULL DEFAULT 'success',
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
CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger AS $$
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

-- Note: timeline_entries trigger removed (v0.10.1).
-- Structured timeline_entries power temporal queries (graph layer).
-- The markdown timeline section in pages.timeline still feeds search_vector via
-- the trg_pages_search_vector trigger above. Removing the timeline_entries
-- trigger avoids double-weighting the same content in search and prevents
-- mutation-induced reordering during timeline-extract pagination.
DROP TRIGGER IF EXISTS trg_timeline_search_vector ON timeline_entries;
DROP FUNCTION IF EXISTS update_page_search_vector_from_timeline();

-- ============================================================
-- Minion Jobs: BullMQ-inspired Postgres-native job queue
-- ============================================================
CREATE TABLE IF NOT EXISTS minion_jobs (
  id               SERIAL PRIMARY KEY,
  name             TEXT        NOT NULL,
  queue            TEXT        NOT NULL DEFAULT 'default',
  status           TEXT        NOT NULL DEFAULT 'waiting',
  priority         INTEGER     NOT NULL DEFAULT 0,
  data             JSONB       NOT NULL DEFAULT '{}',
  max_attempts     INTEGER     NOT NULL DEFAULT 3,
  attempts_made    INTEGER     NOT NULL DEFAULT 0,
  attempts_started INTEGER     NOT NULL DEFAULT 0,
  backoff_type     TEXT        NOT NULL DEFAULT 'exponential',
  backoff_delay    INTEGER     NOT NULL DEFAULT 1000,
  backoff_jitter   REAL        NOT NULL DEFAULT 0.2,
  stalled_counter  INTEGER     NOT NULL DEFAULT 0,
  max_stalled      INTEGER     NOT NULL DEFAULT 5,
  lock_token       TEXT,
  lock_until       TIMESTAMPTZ,
  delay_until      TIMESTAMPTZ,
  parent_job_id    INTEGER     REFERENCES minion_jobs(id) ON DELETE SET NULL,
  on_child_fail    TEXT        NOT NULL DEFAULT 'fail_parent',
  tokens_input     INTEGER     NOT NULL DEFAULT 0,
  tokens_output    INTEGER     NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER    NOT NULL DEFAULT 0,
  result           JSONB,
  progress         JSONB,
  error_text       TEXT,
  stacktrace       JSONB       DEFAULT '[]',
  depth            INTEGER     NOT NULL DEFAULT 0,
  max_children     INTEGER,
  timeout_ms       INTEGER,
  timeout_at       TIMESTAMPTZ,
  remove_on_complete BOOLEAN   NOT NULL DEFAULT FALSE,
  remove_on_fail   BOOLEAN     NOT NULL DEFAULT FALSE,
  idempotency_key  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_status CHECK (status IN ('waiting','active','completed','failed','delayed','dead','cancelled','waiting-children','paused')),
  CONSTRAINT chk_backoff_type CHECK (backoff_type IN ('fixed','exponential')),
  CONSTRAINT chk_on_child_fail CHECK (on_child_fail IN ('fail_parent','remove_dep','ignore','continue')),
  CONSTRAINT chk_jitter_range CHECK (backoff_jitter >= 0.0 AND backoff_jitter <= 1.0),
  CONSTRAINT chk_attempts_order CHECK (attempts_made <= attempts_started),
  CONSTRAINT chk_nonnegative CHECK (attempts_made >= 0 AND attempts_started >= 0 AND stalled_counter >= 0 AND max_attempts >= 1 AND max_stalled >= 0),
  CONSTRAINT chk_depth_nonnegative CHECK (depth >= 0),
  CONSTRAINT chk_max_children_positive CHECK (max_children IS NULL OR max_children > 0),
  CONSTRAINT chk_timeout_positive CHECK (timeout_ms IS NULL OR timeout_ms > 0)
);

CREATE INDEX IF NOT EXISTS idx_minion_jobs_claim ON minion_jobs (queue, priority ASC, created_at ASC) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_minion_jobs_status ON minion_jobs(status);
CREATE INDEX IF NOT EXISTS idx_minion_jobs_stalled ON minion_jobs (lock_until) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_minion_jobs_delayed ON minion_jobs (delay_until) WHERE status = 'delayed';
CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent ON minion_jobs(parent_job_id);
CREATE INDEX IF NOT EXISTS idx_minion_jobs_timeout ON minion_jobs (timeout_at) WHERE status = 'active' AND timeout_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent_status ON minion_jobs (parent_job_id, status) WHERE parent_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_minion_jobs_idempotency ON minion_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Inbox table for sidechannel messaging
CREATE TABLE IF NOT EXISTS minion_inbox (
  id          SERIAL PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL,
  payload     JSONB NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_minion_inbox_unread ON minion_inbox (job_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_minion_inbox_child_done ON minion_inbox (job_id, sent_at) WHERE payload->>'type' = 'child_done';

-- Attachments table: per-job binary blobs (manifests, agent outputs, files)
CREATE TABLE IF NOT EXISTS minion_attachments (
  id            SERIAL PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  content       BYTEA,
  storage_uri   TEXT,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_minion_attachments_job_filename UNIQUE (job_id, filename),
  CONSTRAINT chk_attachment_storage CHECK (content IS NOT NULL OR storage_uri IS NOT NULL),
  CONSTRAINT chk_attachment_size CHECK (size_bytes >= 0)
);
CREATE INDEX IF NOT EXISTS idx_minion_attachments_job ON minion_attachments (job_id);
ALTER TABLE minion_attachments ALTER COLUMN content SET STORAGE EXTERNAL;

-- ============================================================
-- Subagent runtime (v0.16.0) — durable LLM loops
-- ============================================================
-- Anthropic-native message blocks, one row per Messages API message. Parallel
-- tool_use blocks in one assistant message live in content_blocks JSONB,
-- not across rows.
CREATE TABLE IF NOT EXISTS subagent_messages (
  id                  BIGSERIAL PRIMARY KEY,
  job_id              BIGINT      NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  message_idx         INTEGER     NOT NULL,
  role                TEXT        NOT NULL,
  content_blocks      JSONB       NOT NULL,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  tokens_cache_read   INTEGER,
  tokens_cache_create INTEGER,
  model               TEXT,
  ended_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_subagent_messages_idx UNIQUE (job_id, message_idx),
  CONSTRAINT chk_subagent_messages_role CHECK (role IN ('user','assistant'))
);
CREATE INDEX IF NOT EXISTS idx_subagent_messages_job ON subagent_messages (job_id, message_idx);

-- Two-phase tool execution ledger. Before tool call: INSERT status='pending'.
-- After success: UPDATE to 'complete' + output. On failure: 'failed' + error.
-- Replay re-runs 'pending' rows only if the tool is idempotent.
CREATE TABLE IF NOT EXISTS subagent_tool_executions (
  id           BIGSERIAL PRIMARY KEY,
  job_id       BIGINT      NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  message_idx  INTEGER     NOT NULL,
  tool_use_id  TEXT        NOT NULL,
  tool_name    TEXT        NOT NULL,
  input        JSONB       NOT NULL,
  status       TEXT        NOT NULL,
  output       JSONB,
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  CONSTRAINT uniq_subagent_tools_use_id UNIQUE (job_id, tool_use_id),
  CONSTRAINT chk_subagent_tools_status CHECK (status IN ('pending','complete','failed'))
);
CREATE INDEX IF NOT EXISTS idx_subagent_tools_job ON subagent_tool_executions (job_id, status);

-- Rate-lease table — concurrency cap on outbound providers (e.g.
-- anthropic:messages). Acquire: INSERT if active < max_concurrent under
-- advisory lock. Release: DELETE. Stale leases (expires_at past) auto-prune
-- on next acquire so crashed workers can't strand capacity.
CREATE TABLE IF NOT EXISTS subagent_rate_leases (
  id            BIGSERIAL PRIMARY KEY,
  key           TEXT        NOT NULL,
  owner_job_id  BIGINT      NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_leases_key_expires ON subagent_rate_leases (key, expires_at);

-- NOTIFY trigger for real-time job events (Postgres only, not PGLite)
CREATE OR REPLACE FUNCTION notify_minion_job_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('minion_jobs', json_build_object(
    'id', NEW.id, 'status', NEW.status, 'name', NEW.name,
    'queue', NEW.queue, 'prev_status', COALESCE(OLD.status, 'new')
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS minion_job_notify ON minion_jobs;
CREATE TRIGGER minion_job_notify AFTER INSERT OR UPDATE OF status ON minion_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_minion_job_change();

-- ============================================================
-- Row Level Security: block anon access, postgres role bypasses
-- ============================================================
-- The postgres role (used by gbrain via pooler) has BYPASSRLS.
-- Enabling RLS with no policies means the anon key can't read anything.
-- Only enable if the current role actually has BYPASSRLS privilege,
-- otherwise we'd lock ourselves out.
DO $$
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
    ALTER TABLE minion_jobs ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE 'RLS enabled on all tables (role % has BYPASSRLS)', current_user;
  ELSE
    RAISE WARNING 'Skipping RLS: role % does not have BYPASSRLS privilege. Run as postgres role to enable.', current_user;
  END IF;
END $$;
