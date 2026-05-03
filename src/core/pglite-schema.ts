/**
 * PGLite schema — derived from schema-embedded.ts (Postgres schema).
 *
 * Differences from Postgres:
 * - No RLS block (no role system in embedded PGLite)
 * - No files table (file attachments require Supabase Storage)
 * - No pg_advisory_lock (single connection)
 *
 * Includes OAuth tables (oauth_clients, oauth_tokens, oauth_codes) and
 * auth infrastructure (access_tokens, mcp_request_log) because
 * `gbrain serve --http` makes PGLite network-accessible.
 *
 * Everything else is identical: same tables, triggers, indexes, pgvector HNSW, tsvector GIN.
 *
 * DRIFT WARNING: When schema-embedded.ts changes, update this file to match.
 * test/edge-bundle.test.ts has a drift detection test.
 */

export const PGLITE_SCHEMA_SQL = `
-- GBrain PGLite schema (local embedded Postgres)

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- sources: multi-brain tenancy (v0.18.0). See src/schema.sql for design notes.
-- ============================================================
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  local_path    TEXT,
  last_commit   TEXT,
  last_sync_at  TIMESTAMPTZ,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO sources (id, name, config)
  VALUES ('default', 'default', '{"federated": true}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- pages: the core content table
-- ============================================================
-- v0.18.0 (Step 2): source_id scopes each page. Slugs are unique per
-- source — see src/schema.sql for the design notes.
CREATE TABLE IF NOT EXISTS pages (
  id            SERIAL PRIMARY KEY,
  source_id     TEXT    NOT NULL DEFAULT 'default'
                REFERENCES sources(id) ON DELETE CASCADE,
  slug          TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  -- v0.19.0: markdown vs code distinction at the DB level.
  page_kind     TEXT    NOT NULL DEFAULT 'markdown'
                CHECK (page_kind IN ('markdown','code')),
  title         TEXT    NOT NULL,
  compiled_truth TEXT   NOT NULL DEFAULT '',
  timeline      TEXT    NOT NULL DEFAULT '',
  frontmatter   JSONB   NOT NULL DEFAULT '{}',
  content_hash  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_frontmatter ON pages USING GIN(frontmatter);
CREATE INDEX IF NOT EXISTS idx_pages_trgm ON pages USING GIN(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);

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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- v0.19.0: code chunk metadata (markdown chunks leave NULL).
  language      TEXT,
  symbol_name   TEXT,
  symbol_type   TEXT,
  start_line    INTEGER,
  end_line      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
-- v0.19.0: partial indexes for code chunk lookups.
CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name ON content_chunks(symbol_name) WHERE symbol_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_language ON content_chunks(language) WHERE language IS NOT NULL;

-- ============================================================
-- links: cross-references between pages
-- ============================================================
-- See src/schema.sql for full design notes on link_source + origin_page_id.
CREATE TABLE IF NOT EXISTS links (
  id             SERIAL PRIMARY KEY,
  from_page_id   INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type      TEXT    NOT NULL DEFAULT '',
  context        TEXT    NOT NULL DEFAULT '',
  link_source    TEXT    CHECK (link_source IS NULL OR link_source IN ('markdown', 'frontmatter', 'manual')),
  origin_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  origin_field   TEXT,
  -- v0.18.0 Step 4: see src/schema.sql.
  resolution_type TEXT   CHECK (resolution_type IS NULL OR resolution_type IN ('qualified', 'unqualified')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
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
-- Dedup constraint: same (page, date, summary) treated as same event
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup ON timeline_entries(page_id, date, summary);

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
-- ingest_log (v0.18.0 Step 1: source_id deferred to v17, see src/schema.sql)
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
  ('engine', 'pglite'),
  ('embedding_model', 'text-embedding-3-large'),
  ('embedding_dimensions', '1536'),
  ('chunk_strategy', 'semantic')
ON CONFLICT (key) DO NOTHING;

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
  depth            INTEGER     NOT NULL DEFAULT 0,
  max_children     INTEGER,
  timeout_ms       INTEGER,
  timeout_at       TIMESTAMPTZ,
  remove_on_complete BOOLEAN   NOT NULL DEFAULT FALSE,
  remove_on_fail   BOOLEAN     NOT NULL DEFAULT FALSE,
  idempotency_key  TEXT,
  result           JSONB,
  progress         JSONB,
  error_text       TEXT,
  stacktrace       JSONB       DEFAULT '[]',
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
CREATE INDEX IF NOT EXISTS idx_minion_jobs_timeout ON minion_jobs (timeout_at)
  WHERE status = 'active' AND timeout_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent_status ON minion_jobs (parent_job_id, status)
  WHERE parent_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_minion_jobs_idempotency ON minion_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

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
CREATE INDEX IF NOT EXISTS idx_minion_inbox_child_done ON minion_inbox (job_id, sent_at)
  WHERE (payload->>'type') = 'child_done';

-- Attachment manifest (BYTEA inline + forward-compat storage_uri)
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
-- NOTE: SET STORAGE EXTERNAL is omitted on PGLite; it's a Postgres TOAST optimization
-- and PGLite may not support it. Postgres path applies it via migration v7.

-- ============================================================
-- Subagent runtime (v0.16.0) — durable LLM loops
-- ============================================================
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

CREATE TABLE IF NOT EXISTS subagent_rate_leases (
  id            BIGSERIAL PRIMARY KEY,
  key           TEXT        NOT NULL,
  owner_job_id  BIGINT      NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_leases_key_expires ON subagent_rate_leases (key, expires_at);

-- ============================================================
-- Cycle coordination lock — v0.17 runCycle primitive
-- ============================================================
-- See src/schema.sql for full rationale. One row per active cycle.
-- PGLite is single-writer, so the lock doubly protects: the DB-level
-- row + the file lock at ~/.gbrain/cycle.lock prevent concurrent
-- CLI invocations from racing.
CREATE TABLE IF NOT EXISTS gbrain_cycle_locks (
  id              TEXT        PRIMARY KEY,
  holder_pid      INT         NOT NULL,
  holder_host     TEXT,
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycle_locks_ttl ON gbrain_cycle_locks(ttl_expires_at);

-- Eval capture (v0.25.0). PGLite ignores RLS — see src/schema.sql for the
-- cross-engine spec.
CREATE TABLE IF NOT EXISTS eval_candidates (
  id                    SERIAL PRIMARY KEY,
  tool_name             TEXT         NOT NULL CHECK (tool_name IN ('query', 'search')),
  query                 TEXT         NOT NULL CHECK (length(query) <= 51200),
  retrieved_slugs       TEXT[]       NOT NULL DEFAULT '{}',
  retrieved_chunk_ids   INTEGER[]    NOT NULL DEFAULT '{}',
  source_ids            TEXT[]       NOT NULL DEFAULT '{}',
  expand_enabled        BOOLEAN,
  detail                TEXT         CHECK (detail IS NULL OR detail IN ('low', 'medium', 'high')),
  detail_resolved       TEXT         CHECK (detail_resolved IS NULL OR detail_resolved IN ('low', 'medium', 'high')),
  vector_enabled        BOOLEAN      NOT NULL,
  expansion_applied     BOOLEAN      NOT NULL,
  latency_ms            INTEGER      NOT NULL,
  remote                BOOLEAN      NOT NULL,
  job_id                INTEGER,
  subagent_id           INTEGER,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eval_candidates_created_at ON eval_candidates(created_at DESC);

CREATE TABLE IF NOT EXISTS eval_capture_failures (
  id      SERIAL       PRIMARY KEY,
  ts      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reason  TEXT         NOT NULL CHECK (reason IN ('db_down', 'rls_reject', 'check_violation', 'scrubber_exception', 'other'))
);
CREATE INDEX IF NOT EXISTS idx_eval_capture_failures_ts ON eval_capture_failures(ts DESC);

-- ============================================================
-- access_tokens: legacy bearer tokens for remote MCP access
-- ============================================================
CREATE TABLE IF NOT EXISTS access_tokens (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT[],
  created_at   TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens (token_hash) WHERE revoked_at IS NULL;

-- ============================================================
-- mcp_request_log: usage logging for MCP requests
-- ============================================================
CREATE TABLE IF NOT EXISTS mcp_request_log (
  id            SERIAL PRIMARY KEY,
  token_name    TEXT,
  agent_name    TEXT,
  operation     TEXT NOT NULL,
  latency_ms    INTEGER,
  status        TEXT NOT NULL DEFAULT 'success',
  params        JSONB,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_log_time_agent ON mcp_request_log(created_at, token_name);
CREATE INDEX IF NOT EXISTS idx_mcp_log_agent_time ON mcp_request_log(agent_name, created_at DESC);

-- ============================================================
-- OAuth 2.1: clients, tokens, authorization codes
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id               TEXT PRIMARY KEY,
  client_secret_hash      TEXT,
  client_name             TEXT NOT NULL,
  redirect_uris           TEXT[],
  grant_types             TEXT[] DEFAULT '{client_credentials}',
  scope                   TEXT,
  token_endpoint_auth_method TEXT,
  client_id_issued_at     BIGINT,
  client_secret_expires_at BIGINT,
  token_ttl               INTEGER,
  deleted_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  token_type   TEXT NOT NULL,
  client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes       TEXT[],
  expires_at   BIGINT,
  resource     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash              TEXT PRIMARY KEY,
  client_id              TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes                 TEXT[],
  code_challenge         TEXT NOT NULL,
  code_challenge_method  TEXT NOT NULL DEFAULT 'S256',
  redirect_uri           TEXT NOT NULL,
  state                  TEXT,
  resource               TEXT,
  expires_at             BIGINT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
-- pages.timeline (markdown) still feeds search_vector via trg_pages_search_vector.
DROP TRIGGER IF EXISTS trg_timeline_search_vector ON timeline_entries;
DROP FUNCTION IF EXISTS update_page_search_vector_from_timeline();
`;
