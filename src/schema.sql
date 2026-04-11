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

-- When timeline_entries change, update the parent page's search_vector
CREATE OR REPLACE FUNCTION update_page_search_vector_from_timeline() RETURNS trigger AS $$
DECLARE
  page_row pages%ROWTYPE;
BEGIN
  -- Touch the page to re-fire its trigger
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
    RAISE NOTICE 'RLS enabled on all tables (role % has BYPASSRLS)', current_user;
  ELSE
    RAISE WARNING 'Skipping RLS: role % does not have BYPASSRLS privilege. Run as postgres role to enable.', current_user;
  END IF;
END $$;
