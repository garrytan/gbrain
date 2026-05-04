-- GBrain Postgres + pgvector schema

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- gen_random_uuid() is core in Postgres 13+; enable pgcrypto as fallback for older versions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- sources: multi-repo / multi-brain tenancy (v0.18.0)
-- ============================================================
-- A source is a logical brain-within-the-DB: wiki, gstack, yc-media, etc.
-- Every page/file/ingest_log row carries source_id.
--
-- id:         immutable citation key. [a-z0-9-]{1,32} enforced at app layer.
--             Used in [source:slug] citations, --source flag, wikilink syntax.
-- name:       mutable display label. Rename via `gbrain sources rename`.
-- local_path: optional git checkout root for filesystem-backed sources.
-- config:     forward-compat JSONB. Currently used for federation + ACL slot.
--             { "federated": bool, "access_policy": {...} }
--             - federated=true (or missing-but-explicit on 'default'):
--               participates in cross-source default search.
--             - federated=false (default for new sources):
--               only searched when explicitly named via --source.
--             - access_policy: forward-compat slot, no enforcement in v0.17.
--               Write-side lockdown: mutated only when ctx.remote=false.
CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  local_path      TEXT,
  last_commit     TEXT,
  last_sync_at    TIMESTAMPTZ,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- v0.20.0 Cathedral II (SP-1): chunker version last used to sync this source.
  -- performSync forces a full walk when this mismatches CURRENT_CHUNKER_VERSION,
  -- bypassing the git-HEAD up_to_date early-return so CHUNKER_VERSION bumps
  -- actually trigger re-chunking on upgrade.
  chunker_version TEXT,
  -- v0.26.5: soft-delete + recovery window. `archive` flips archived=true and
  -- sets archive_expires_at = now() + 72h. The autopilot purge phase
  -- hard-deletes rows where archive_expires_at <= now(). Promoted from a
  -- JSONB key to real columns to avoid reserved-key footguns and to make the
  -- search visibility filter (`NOT s.archived`) a column lookup.
  archived            BOOLEAN NOT NULL DEFAULT false,
  archived_at         TIMESTAMPTZ,
  archive_expires_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the default source. 'default' is federated=true for backward compat
-- (pre-v0.17 brains behave exactly as before — every page appears in search).
-- Pre-existing sync.repo_path / sync.last_commit are copied in by the v16
-- migration, not here; fresh installs have no local_path until `sources add`
-- or the first `sync`.
INSERT INTO sources (id, name, config)
  VALUES ('default', 'default', '{"federated": true}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- pages: the core content table
-- ============================================================
-- v0.18.0 (Step 2): pages.source_id scopes each row to a sources(id) row.
-- Slugs are unique per source, NOT globally. The default source is
-- seeded in the sources block above so the DEFAULT 'default' FK is
-- always valid at INSERT time.
CREATE TABLE IF NOT EXISTS pages (
  id            SERIAL PRIMARY KEY,
  source_id     TEXT    NOT NULL DEFAULT 'default'
                REFERENCES sources(id) ON DELETE CASCADE,
  slug          TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  -- v0.19.0: distinguishes markdown vs code pages at the DB level.
  -- Drives orphans filter, auto-link bypass, and `query --lang`.
  page_kind     TEXT    NOT NULL DEFAULT 'markdown'
                CHECK (page_kind IN ('markdown','code')),
  title         TEXT    NOT NULL,
  compiled_truth TEXT   NOT NULL DEFAULT '',
  timeline      TEXT    NOT NULL DEFAULT '',
  frontmatter   JSONB   NOT NULL DEFAULT '{}',
  content_hash  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- v0.26.5: soft-delete + recovery window. `delete_page` sets deleted_at = now()
  -- instead of issuing DELETE. The autopilot purge phase hard-deletes pages
  -- where deleted_at < now() - 72h. Search and `get_page` filter
  -- `WHERE deleted_at IS NULL` by default; `include_deleted: true` opts in.
  deleted_at    TIMESTAMPTZ,
  CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_frontmatter ON pages USING GIN(frontmatter);
CREATE INDEX IF NOT EXISTS idx_pages_trgm ON pages USING GIN(title gin_trgm_ops);
-- v0.13.1 #170: avoids 14.6s seqscan on large brains when listing pages newest-first.
CREATE INDEX IF NOT EXISTS idx_pages_updated_at_desc ON pages (updated_at DESC);
-- v0.18.0: source-scoped scans (per /plan-eng-review Section 4).
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
-- v0.26.5: partial index supports the autopilot purge sweep
-- (`WHERE deleted_at IS NOT NULL AND deleted_at < now() - INTERVAL '72 hours'`).
-- Search filters (`WHERE deleted_at IS NULL`) do not benefit from this index
-- (predicate doesn't match) and don't need their own — soft-deleted cardinality
-- stays low. Don't add a regular `(deleted_at)` index without measuring.
CREATE INDEX IF NOT EXISTS pages_deleted_at_purge_idx
  ON pages (deleted_at) WHERE deleted_at IS NOT NULL;

-- ============================================================
-- content_chunks: chunked content with embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS content_chunks (
  id                    SERIAL PRIMARY KEY,
  page_id               INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index           INTEGER NOT NULL,
  chunk_text            TEXT    NOT NULL,
  chunk_source          TEXT    NOT NULL DEFAULT 'compiled_truth',
  embedding             vector(1536),
  model                 TEXT    NOT NULL DEFAULT 'text-embedding-3-large',
  token_count           INTEGER,
  embedded_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- v0.19.0: code chunk metadata. Nullable — markdown chunks leave these NULL.
  -- Powers `query --lang`, `code-def <symbol>`, and `code-refs <symbol>`.
  language              TEXT,
  symbol_name           TEXT,
  symbol_type           TEXT,
  start_line            INTEGER,
  end_line              INTEGER,
  -- v0.20.0 Cathedral II: qualified symbol identity + parent scope + doc-comment
  -- + chunk-grain FTS. All nullable — markdown chunks leave these NULL.
  parent_symbol_path    TEXT[],
  doc_comment           TEXT,
  symbol_name_qualified TEXT,
  search_vector         TSVECTOR
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
-- v0.19.0: partial indexes — only code chunks populate these columns.
CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name ON content_chunks(symbol_name) WHERE symbol_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_language ON content_chunks(language) WHERE language IS NOT NULL;
-- v0.20.0 Cathedral II: GIN index on the new chunk-grain FTS vector.
CREATE INDEX IF NOT EXISTS idx_chunks_search_vector ON content_chunks USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol_qualified
  ON content_chunks(symbol_name_qualified) WHERE symbol_name_qualified IS NOT NULL;

-- v0.20.0 Cathedral II: chunk-grain FTS trigger.
-- Weight 'A' on doc_comment + symbol_name_qualified; weight 'B' on chunk_text.
-- NL queries ("how do we handle errors") rank doc-comment hits above body text.
-- BEFORE INSERT OR UPDATE OF specific columns — only refires when those change,
-- not on every chunk update (e.g., embedding refresh doesn't trigger rebuild).
CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER AS $fn$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.doc_comment, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.symbol_name_qualified, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.chunk_text, '')), 'B');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunk_search_vector_trigger ON content_chunks;
CREATE TRIGGER chunk_search_vector_trigger
  BEFORE INSERT OR UPDATE OF chunk_text, doc_comment, symbol_name_qualified
  ON content_chunks
  FOR EACH ROW EXECUTE FUNCTION update_chunk_search_vector();

-- ============================================================
-- code_edges_chunk + code_edges_symbol: v0.20.0 Cathedral II structural edges
-- ============================================================
-- Two-table design (codex F4 + SP-7):
--   - code_edges_chunk: resolved edges (both endpoints = known chunk IDs)
--   - code_edges_symbol: unresolved refs (target known by qualified name,
--     defining chunk not yet imported)
-- Readers UNION both tables; no promotion step.
-- Source scoping: from_chunk_id -> content_chunks -> pages.source_id
-- determines the source. Resolution logic MUST scope on source (codex SP-3);
-- only --all-sources callers bypass this. UNIQUE keys don't include source_id
-- because from_chunk_id already pins it.
CREATE TABLE IF NOT EXISTS code_edges_chunk (
  id                    SERIAL PRIMARY KEY,
  from_chunk_id         INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  to_chunk_id           INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT NOT NULL,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type             TEXT NOT NULL,
  edge_metadata         JSONB NOT NULL DEFAULT '{}',
  source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT code_edges_chunk_unique UNIQUE (from_chunk_id, to_chunk_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_from
  ON code_edges_chunk(from_chunk_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_to
  ON code_edges_chunk(to_chunk_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_to_symbol
  ON code_edges_chunk(to_symbol_qualified, edge_type);

CREATE TABLE IF NOT EXISTS code_edges_symbol (
  id                    SERIAL PRIMARY KEY,
  from_chunk_id         INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT NOT NULL,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type             TEXT NOT NULL,
  edge_metadata         JSONB NOT NULL DEFAULT '{}',
  source_id             TEXT REFERENCES sources(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT code_edges_symbol_unique UNIQUE (from_chunk_id, to_symbol_qualified, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_from
  ON code_edges_symbol(from_chunk_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_to
  ON code_edges_symbol(to_symbol_qualified, edge_type);

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
  -- v0.18.0 Step 4: 'qualified' when the link was written as
  -- [[source:slug]] (target source pinned). 'unqualified' when written
  -- as bare [[slug]] and resolved via local-first fallback at
  -- extraction time. NULL for legacy/manual/frontmatter edges.
  resolution_type TEXT   CHECK (resolution_type IS NULL OR resolution_type IN ('qualified', 'unqualified')),
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
-- NOTE (v0.18.0 Step 1): ingest_log.source_id is NOT added yet — lands
-- in v17 alongside the sync rewrite (Step 5), which starts writing
-- source-scoped entries.
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

-- ============================================================
-- OAuth 2.1: clients, tokens, authorization codes
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id               TEXT PRIMARY KEY,
  client_secret_hash      TEXT,
  client_name             TEXT NOT NULL,
  redirect_uris           TEXT[],
  grant_types             TEXT[] DEFAULT '{"client_credentials"}',
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

-- Composite indexes for admin dashboard request log queries
CREATE INDEX IF NOT EXISTS idx_mcp_log_time_agent ON mcp_request_log(created_at, token_name);
CREATE INDEX IF NOT EXISTS idx_mcp_log_agent_time ON mcp_request_log(agent_name, created_at DESC);

-- ============================================================
-- files: binary attachments stored in Supabase Storage
-- ============================================================
-- v0.18.0 Step 7: files gains source_id + page_id alongside the
-- legacy page_slug (kept for backward compat until a later release).
-- The file_migration_ledger below drives the storage object rewrite.
-- page_slug FK had ON UPDATE CASCADE — removed because slugs are no
-- longer global (composite UNIQUE) so CASCADE on-update is ambiguous.
-- ON DELETE SET NULL is preserved via both page_slug and page_id.
CREATE TABLE IF NOT EXISTS files (
  id           SERIAL PRIMARY KEY,
  source_id    TEXT   NOT NULL DEFAULT 'default'
               REFERENCES sources(id) ON DELETE CASCADE,
  page_slug    TEXT,
  page_id      INTEGER REFERENCES pages(id) ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS idx_files_page_id ON files(page_id);
CREATE INDEX IF NOT EXISTS idx_files_source_id ON files(source_id);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

-- ============================================================
-- file_migration_ledger (v0.18.0 Step 7)
-- Drives the storage-object rewrite performed by the v0_18_0
-- orchestrator's phase B. Keyed on file_id so two sources can share
-- an old path during migration without PK collision (Codex second-
-- pass caught this).
-- Status state machine: pending → copy_done → db_updated → complete
-- ============================================================
CREATE TABLE IF NOT EXISTS file_migration_ledger (
  file_id           INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  storage_path_old  TEXT   NOT NULL,
  storage_path_new  TEXT   NOT NULL,
  status            TEXT   NOT NULL DEFAULT 'pending',
  error             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ledger_status CHECK (status IN ('pending','copy_done','db_updated','complete','failed'))
);
CREATE INDEX IF NOT EXISTS idx_file_migration_ledger_status
  ON file_migration_ledger(status) WHERE status != 'complete';

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
  -- v0.27+ stores provider-neutral ChatBlock[] when schema_version=2; legacy
  -- Anthropic-shape blocks when schema_version=1 (pre-v0.27 jobs replay).
  content_blocks      JSONB       NOT NULL,
  schema_version      INTEGER     NOT NULL DEFAULT 1,
  -- Recipe id of the provider that produced this turn (e.g. 'anthropic',
  -- 'openai', 'deepseek'). NULL on legacy v1 rows; set on v2.
  provider_id         TEXT,
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
CREATE INDEX IF NOT EXISTS idx_subagent_messages_provider ON subagent_messages (job_id, provider_id);

-- Two-phase tool execution ledger. Before tool call: INSERT status='pending'.
-- After success: UPDATE to 'complete' + output. On failure: 'failed' + error.
-- Replay re-runs 'pending' rows only if the tool is idempotent.
CREATE TABLE IF NOT EXISTS subagent_tool_executions (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT      NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  message_idx     INTEGER     NOT NULL,
  tool_use_id     TEXT        NOT NULL,
  tool_name       TEXT        NOT NULL,
  input           JSONB       NOT NULL,
  status          TEXT        NOT NULL,
  output          JSONB,
  error           TEXT,
  schema_version  INTEGER     NOT NULL DEFAULT 1,
  provider_id     TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
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

-- ============================================================
-- Dream-cycle significance verdict cache — v0.21 synthesize phase
-- ============================================================
-- Caches the cheap Haiku "is this transcript worth processing?" verdict
-- per (file_path, content_hash) so backfill re-runs skip already-judged
-- files. Distinct from raw_data (which is page-scoped); transcripts
-- aren't pages.
CREATE TABLE IF NOT EXISTS dream_verdicts (
  file_path        TEXT        NOT NULL,
  content_hash     TEXT        NOT NULL,
  worth_processing BOOLEAN     NOT NULL,
  reasons          JSONB,
  judged_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (file_path, content_hash)
);

-- ============================================================
-- Cycle coordination lock — v0.17 runCycle primitive
-- ============================================================
-- One row per active cycle. Any caller (autopilot daemon, Minions
-- autopilot-cycle handler, gbrain dream CLI) tries to acquire this
-- row before running a DB-write phase. Holders refresh ttl_expires_at
-- between phases; crashed holders auto-release once TTL expires.
-- Works through PgBouncer transaction pooling, unlike session-scoped
-- pg_try_advisory_lock.
CREATE TABLE IF NOT EXISTS gbrain_cycle_locks (
  id              TEXT        PRIMARY KEY,
  holder_pid      INT         NOT NULL,
  holder_host     TEXT,
  acquired_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycle_locks_ttl ON gbrain_cycle_locks(ttl_expires_at);

-- ============================================================
-- Eval capture (v0.25.0 — BrainBench-Real substrate)
-- ============================================================
-- eval_candidates: captured query/search calls from the op-layer wrapper
-- in src/core/operations.ts. PII is scrubbed before insert by
-- src/core/eval-capture-scrub.ts. query is CHECK-capped at 50KB.
-- eval_capture_failures: cross-process audit of insert failures, surfaced
-- by `gbrain doctor` (in-process counters can't bridge MCP server + doctor
-- CLI process boundaries).
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
    ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
    ALTER TABLE file_migration_ledger ENABLE ROW LEVEL SECURITY;
    ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
    ALTER TABLE mcp_request_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE minion_inbox ENABLE ROW LEVEL SECURITY;
    ALTER TABLE minion_attachments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subagent_messages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subagent_tool_executions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE subagent_rate_leases ENABLE ROW LEVEL SECURITY;
    ALTER TABLE gbrain_cycle_locks ENABLE ROW LEVEL SECURITY;
    ALTER TABLE dream_verdicts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE eval_candidates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE eval_capture_failures ENABLE ROW LEVEL SECURITY;
    -- v0.26 OAuth 2.1 tables
    ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
    ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
    ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
    RAISE NOTICE 'RLS enabled on all tables (role % has BYPASSRLS)', current_user;
  ELSE
    RAISE WARNING 'Skipping RLS: role % does not have BYPASSRLS privilege. Run as postgres role to enable.', current_user;
  END IF;
END $$;
