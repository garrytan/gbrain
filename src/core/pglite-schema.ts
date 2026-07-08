/**
 * PGLite schema — derived from schema-embedded.ts (Postgres schema).
 *
 * Differences from Postgres:
 * - No RLS block (no role system in embedded PGLite)
 * - No pg_advisory_lock (single connection)
 *
 * As of v0.27.1 the `files` table mirrors the Postgres shape on PGLite —
 * v0.18 originally omitted it because file attachments required Supabase
 * Storage, but v0.27.1 multimodal ingestion stores image bytes on disk in
 * the brain repo and only indexes metadata. Path-referenced binary asset
 * tracking works fine on PGLite. Migration v36 adds it for existing brains.
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

import { applyChunkEmbeddingIndexPolicy } from './vector-index.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';

const PGLITE_SCHEMA_SQL_TEMPLATE = `
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
  -- v0.26.5: soft-delete + recovery window (mirrors src/schema.sql).
  archived            BOOLEAN NOT NULL DEFAULT false,
  archived_at         TIMESTAMPTZ,
  archive_expires_at  TIMESTAMPTZ,
  -- v0.40.3.0: per-source CR mode override + mount-frontmatter trust gate
  -- (mirrors src/schema.sql). NULL falls through to global mode; trust
  -- FALSE for mounts by default; host is always trusted regardless.
  contextual_retrieval_mode   TEXT,
  trust_frontmatter_overrides BOOLEAN NOT NULL DEFAULT false,
  -- v0.41.32.0 (supersedes #1623): newest COMMIT timestamp at last sync
  -- (mirrors src/schema.sql). REMOTE staleness reads this; NULL → wall-clock.
  newest_content_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO sources (id, name, config)
  VALUES ('default', 'default', '{"federated": true}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

-- v0.40 Federated Sync v2: partial expression index on config->>'github_repo'
-- (mirror of src/schema.sql; migration v92 backfills legacy brains).
CREATE INDEX IF NOT EXISTS sources_github_repo_idx
  ON sources ((config->>'github_repo'))
  WHERE config ? 'github_repo';

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
                CHECK (page_kind IN ('markdown','code','image')),
  title         TEXT    NOT NULL,
  compiled_truth TEXT   NOT NULL DEFAULT '',
  timeline      TEXT    NOT NULL DEFAULT '',
  frontmatter   JSONB   NOT NULL DEFAULT '{}',
  content_hash  TEXT,
  -- v0.29: deterministic 0..1 score (tag emotion + take density + user-as-holder ratio).
  -- Populated by the recompute_emotional_weight cycle phase.
  emotional_weight REAL NOT NULL DEFAULT 0.0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- v0.26.5: soft-delete + recovery window (mirrors src/schema.sql).
  deleted_at    TIMESTAMPTZ,
  -- v0.29.1: salience-and-recency, additive opt-in (mirrors src/schema.sql).
  effective_date        TIMESTAMPTZ,
  effective_date_source TEXT,
  import_filename       TEXT,
  salience_touched_at   TIMESTAMPTZ,
  -- v0.37.0 (migration v79): real stale-page signal for gbrain lsd
  -- (mirrors src/schema.sql). NULL = never retrieved.
  last_retrieved_at     TIMESTAMPTZ,
  -- v0.42.7 (migration v112): link-extraction freshness watermark
  -- (mirrors src/schema.sql). NULL = never extracted. Powers
  -- gbrain extract --stale + the links_extraction_lag doctor check.
  links_extracted_at    TIMESTAMPTZ,
  -- v0.40.3.0 contextual retrieval (renumbered from v81 to v90 on master
  -- merge; mirrors src/schema.sql).
  -- contextual_retrieval_mode is the tier the page was last embedded under;
  -- corpus_generation is the composite document-side provenance hash used by
  -- query_cache.page_generations invalidation.
  contextual_retrieval_mode  TEXT,
  corpus_generation          TEXT,
  -- v0.40.3.0 cache invalidation gate (migration v91; mirrors src/schema.sql).
  -- Bumped by bump_page_generation_trg on INSERT (initial) and on UPDATE
  -- when content columns IS DISTINCT FROM. Read by the per-page snapshot
  -- check in query-cache-gate.ts.
  generation     BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug)
);

-- v0.40.3.0 cache invalidation trigger (migration v91; mirrors src/schema.sql).
-- BEFORE INSERT OR UPDATE so every write path bumps generation per D6 /
-- codex #4. INSERT: pages get COALESCE(MAX(generation), 0) + 1 so the
-- bookmark gate fires for any cache row stored before the new page existed.
-- UPDATE: bumps only when content columns IS DISTINCT FROM (allow-list of
-- 10 widened per D6) so read-time mutations don't invalidate every cache.
CREATE OR REPLACE FUNCTION bump_page_generation_fn() RETURNS trigger SET search_path = pg_catalog, public AS $func$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    NEW.generation := COALESCE((SELECT MAX(generation) FROM pages), 0) + 1;
  ELSIF (OLD.compiled_truth IS DISTINCT FROM NEW.compiled_truth)
     OR (OLD.timeline IS DISTINCT FROM NEW.timeline)
     OR (OLD.frontmatter IS DISTINCT FROM NEW.frontmatter)
     OR (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
     OR (OLD.contextual_retrieval_mode IS DISTINCT FROM NEW.contextual_retrieval_mode)
     OR (OLD.title IS DISTINCT FROM NEW.title)
     OR (OLD.type IS DISTINCT FROM NEW.type)
     OR (OLD.page_kind IS DISTINCT FROM NEW.page_kind)
     OR (OLD.corpus_generation IS DISTINCT FROM NEW.corpus_generation)
     OR (OLD.content_hash IS DISTINCT FROM NEW.content_hash)
  THEN
    NEW.generation := OLD.generation + 1;
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_page_generation_trg ON pages;
CREATE TRIGGER bump_page_generation_trg
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION bump_page_generation_fn();

-- v0.41.19.0 (D18/D19, mirror of src/schema.sql): global page-generation
-- clock + statement-level trigger. See src/schema.sql for the full
-- rationale comment. Layer 1 bookmark reads page_generation_clock.value;
-- per-row pages.generation above stays as the Layer 2 (per-page snapshot)
-- substrate.
CREATE TABLE IF NOT EXISTS page_generation_clock (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value BIGINT  NOT NULL DEFAULT 0
);
INSERT INTO page_generation_clock (id, value)
  VALUES (1, COALESCE((SELECT MAX(generation) FROM pages), 0))
  ON CONFLICT (id) DO NOTHING;

-- v0.42.x: contention-free clock. nextval() takes a microsecond LWLock, not a
-- transaction-length row lock. Load-bearing setval (2-arg -> is_called=true) so
-- the first write strictly exceeds the seed; floor 1 (sequence MINVALUE).
-- Layer-1 reads last_value. Table + trigger names retained.
CREATE SEQUENCE IF NOT EXISTS page_generation_clock_seq;
-- Monotonic seed: GREATEST over the sequence's OWN last_value too, so replaying
-- this blob on an already-upgraded brain (initSchema is re-runnable) can never
-- move last_value BACKWARD below a stored query_cache bookmark.
SELECT setval('page_generation_clock_seq', GREATEST(
  1,
  COALESCE((SELECT last_value FROM page_generation_clock_seq), 0),
  COALESCE((SELECT value FROM page_generation_clock WHERE id = 1), 0),
  COALESCE((SELECT MAX(generation) FROM pages), 0)
));

CREATE OR REPLACE FUNCTION bump_page_generation_clock_fn() RETURNS trigger SET search_path = pg_catalog, public AS $func$
BEGIN
  PERFORM nextval('page_generation_clock_seq');
  RETURN NULL;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_page_generation_clock_trg ON pages;
CREATE TRIGGER bump_page_generation_clock_trg
  AFTER INSERT OR UPDATE OR DELETE ON pages
  FOR EACH STATEMENT
  EXECUTE FUNCTION bump_page_generation_clock_fn();

CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_frontmatter ON pages USING GIN(frontmatter);
CREATE INDEX IF NOT EXISTS idx_pages_trgm ON pages USING GIN(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
-- v0.26.5: partial index supports the autopilot purge sweep (mirrors src/schema.sql).
CREATE INDEX IF NOT EXISTS pages_deleted_at_purge_idx
  ON pages (deleted_at) WHERE deleted_at IS NOT NULL;
-- v0.29.1: expression index for since/until date-range filters.
CREATE INDEX IF NOT EXISTS pages_coalesce_date_idx
  ON pages ((COALESCE(effective_date, updated_at)));
-- v0.37.0: full B-tree index on last_retrieved_at supports LSD's stale-page
-- query (mirrors src/schema.sql). Postgres handles NULL in B-tree indexes.
CREATE INDEX IF NOT EXISTS pages_last_retrieved_at_idx
  ON pages (last_retrieved_at);
-- v0.42.7 (migration v112): composite B-tree backing extract --stale and the
-- links_extraction_lag doctor check (mirrors src/schema.sql). source_id leads so
-- source-scoped staleness scans are indexed; NOT partial-NULL (predicate has a
-- NULL arm AND a version-timestamp arm).
CREATE INDEX IF NOT EXISTS pages_links_extracted_at_idx
  ON pages (source_id, links_extracted_at);

-- ============================================================
-- content_chunks: chunked content with embeddings
-- ============================================================
CREATE TABLE IF NOT EXISTS content_chunks (
  id              SERIAL PRIMARY KEY,
  page_id         INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  chunk_text      TEXT    NOT NULL,
  chunk_source    TEXT    NOT NULL DEFAULT 'compiled_truth',
  embedding       vector(__EMBEDDING_DIMS__),
  model           TEXT    NOT NULL DEFAULT '__EMBEDDING_MODEL__',
  token_count     INTEGER,
  embedded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- v0.19.0: code chunk metadata (markdown chunks leave NULL).
  language        TEXT,
  symbol_name     TEXT,
  symbol_type     TEXT,
  start_line      INTEGER,
  end_line        INTEGER,
  -- v0.27.1 multimodal. modality discriminates text vs image rows; image
  -- chunks carry their 1024-dim Voyage multimodal vector in embedding_image
  -- (independent of the brain primary embedding column dim).
  modality        TEXT NOT NULL DEFAULT 'text',
  embedding_image vector(1024),
  -- v0.36 Phase 3 cross-modal: unified column populated by reindex
  -- (search.unified_multimodal=true routes here). Migration v75 adds it
  -- on upgrade; fresh installs land at head with the column present.
  embedding_multimodal vector(1024)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
-- v0.27.1: partial HNSW for multimodal images. Footprint stays proportional
-- to image-chunk count, not table size.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_image
  ON content_chunks USING hnsw (embedding_image vector_cosine_ops)
  WHERE embedding_image IS NOT NULL;
-- v0.19.0: partial indexes for code chunk lookups.
CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name ON content_chunks(symbol_name) WHERE symbol_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_language ON content_chunks(language) WHERE language IS NOT NULL;
-- v0.41.18.0 (codex finding #9): partial index for gbrain embed --stale
-- and --priority recent. See src/schema.sql for full rationale.
CREATE INDEX IF NOT EXISTS content_chunks_stale_idx
  ON content_chunks(page_id, chunk_index) WHERE embedding IS NULL;

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
  -- v114 (#1941): open kebab-case provenance (not a closed allowlist) so
  -- external derivers stamp their own tag. Format gate only: lowercase kebab,
  -- <=64 chars. Managed built-ins still satisfy this; see src/schema.sql for
  -- full rationale + the add_link op-layer guard against forging them.
  link_source    TEXT    CHECK (link_source IS NULL OR (link_source ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(link_source) <= 64)),
  -- v0.41.18.0 (codex finding #12): nullable link_kind distinguishes
  -- "plain body mention" from "verb-pattern-derived typed link" within
  -- link_source='mentions'. See src/schema.sql for full rationale.
  link_kind      TEXT    CHECK (link_kind IS NULL OR link_kind IN ('plain', 'typed_ner')),
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

-- v0.38: page_links is the alias the engine queries use (pglite-engine.ts +
-- postgres-engine.ts both JOIN page_links pl ON pl.to_page_id = p.id). The
-- alias predates the table-name standardization; the canonical table is
-- links. Brainstorm domain-bank connection_count tiebreaker and the
-- doctor link-density score read through this view.
--
-- The projection is intentionally NARROW (id, from_page_id, to_page_id only).
-- Engine queries only reference pl.id (via COUNT(*)) and pl.to_page_id.
-- Including link_source / origin_page_id / etc. in the view would couple
-- the alias to columns that didn't exist in pre-v0.13 brains AND would
-- block ALTER TABLE DROP COLUMN on those columns during upgrades.
CREATE OR REPLACE VIEW page_links AS
  SELECT id, from_page_id, to_page_id FROM links;

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
-- files: binary asset metadata (v0.27.1 — PGLite parity for multimodal)
-- Image bytes never enter the DB; storage_path references a path in the
-- brain repo. Identity is (source_id, storage_path) via the UNIQUE
-- constraint on storage_path; upserts replace metadata in place.
-- ============================================================
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

CREATE INDEX IF NOT EXISTS idx_files_page ON files(page_slug);
CREATE INDEX IF NOT EXISTS idx_files_page_id ON files(page_id);
CREATE INDEX IF NOT EXISTS idx_files_source_id ON files(source_id);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(content_hash);

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
  -- v0.42.x (Life Chronicle #2390): event-projection pointer. NULL for
  -- ordinary rows. See src/schema.sql for the full rationale.
  event_page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_page ON timeline_entries(page_id);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_entries(date);
-- Dedup constraint: same (page, date, summary) treated as same event
-- v0.41.18.0 (codex finding #11): widened to include source so distinct
-- meeting provenance survives. Legacy rows have source='' (schema default).
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup ON timeline_entries(page_id, date, summary, source);
-- v0.42.x (Life Chronicle): event-projection lookup + dedup (partial).
CREATE INDEX IF NOT EXISTS idx_timeline_event_page ON timeline_entries(event_page_id) WHERE event_page_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_event_dedup ON timeline_entries(event_page_id, date) WHERE event_page_id IS NOT NULL;

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
-- ingest_log (v0.31.2: source_id added — codex P1 #3, migration v50)
-- ============================================================
CREATE TABLE IF NOT EXISTS ingest_log (
  id            SERIAL PRIMARY KEY,
  source_id     TEXT    NOT NULL DEFAULT 'default',
  source_type   TEXT    NOT NULL,
  source_ref    TEXT    NOT NULL,
  pages_updated JSONB   NOT NULL DEFAULT '[]',
  summary       TEXT    NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingest_log_source_type_created
  ON ingest_log (source_id, source_type, created_at DESC);

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
  ('embedding_model', '__EMBEDDING_MODEL__'),
  ('embedding_dimensions', '__EMBEDDING_DIMS__'),
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
  -- v0.27+ stores provider-neutral ChatBlock[] when schema_version=2; legacy
  -- Anthropic-shape blocks when schema_version=1.
  content_blocks      JSONB       NOT NULL,
  schema_version      INTEGER     NOT NULL DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS subagent_tool_executions (
  id                  BIGSERIAL PRIMARY KEY,
  job_id              BIGINT      NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  message_idx         INTEGER     NOT NULL,
  tool_use_id         TEXT        NOT NULL,
  tool_name           TEXT        NOT NULL,
  input               JSONB       NOT NULL,
  status              TEXT        NOT NULL,
  output              JSONB,
  error               TEXT,
  schema_version      INTEGER     NOT NULL DEFAULT 1,
  provider_id         TEXT,
  -- v0.38 D11: gbrain-owned stable IDs (ordinal assigned at first observation;
  -- gbrain_tool_use_id is uuid v7). Reconciliation on crash-replay uses
  -- (job_id, message_idx, ordinal) as the unique key. Legacy rows (pre-v82)
  -- have ordinal=NULL and resolve via the read-time D5 shim.
  ordinal             INTEGER,
  gbrain_tool_use_id  UUID,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
  CONSTRAINT uniq_subagent_tools_use_id UNIQUE (job_id, tool_use_id),
  CONSTRAINT subagent_tool_executions_stable_id UNIQUE (job_id, message_idx, ordinal),
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
  id                 TEXT        PRIMARY KEY,
  holder_pid         INT         NOT NULL,
  holder_host        TEXT,
  acquired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_expires_at     TIMESTAMPTZ NOT NULL,
  -- v0.41.13.0 (migration v97 + D-V3-4): bumped on every withRefreshingLock
  -- refresh tick. Used by gbrain sync --break-lock --max-age <s> to identify
  -- wedged-but-alive holders without stealing healthy long-running holders
  -- that are actively refreshing.
  last_refreshed_at  TIMESTAMPTZ
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
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- v0.29.1 — agent-explicit recency + salience capture for replay (mirrors src/schema.sql).
  as_of_ts              TIMESTAMPTZ,
  salience_param        TEXT,
  recency_param         TEXT,
  salience_resolved     TEXT,
  recency_resolved      TEXT,
  salience_source       TEXT,
  recency_source        TEXT,
  -- v0.36.3.0 (D16 / CDX-10) — embedding column that ran at capture time.
  -- Nullable; pre-v0.36 rows have NULL and replay falls back to current
  -- default. See src/core/migrate.ts migration v68 for the matching ALTER
  -- on upgrade brains.
  embedding_column      TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_candidates_created_at ON eval_candidates(created_at DESC);

CREATE TABLE IF NOT EXISTS eval_capture_failures (
  id      SERIAL       PRIMARY KEY,
  ts      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reason  TEXT         NOT NULL CHECK (reason IN ('db_down', 'rls_reject', 'check_violation', 'scrubber_exception', 'other'))
);
CREATE INDEX IF NOT EXISTS idx_eval_capture_failures_ts ON eval_capture_failures(ts DESC);

-- ============================================================
-- eval_takes_quality_runs (v0.32 — EXP-5): DB-authoritative receipts for
-- the takes-quality eval CLI. Schema mirrors src/schema.sql + migration v49.
-- ============================================================
CREATE TABLE IF NOT EXISTS eval_takes_quality_runs (
  id                    BIGSERIAL    PRIMARY KEY,
  receipt_sha8_corpus   TEXT         NOT NULL,
  receipt_sha8_prompt   TEXT         NOT NULL,
  receipt_sha8_models   TEXT         NOT NULL,
  receipt_sha8_rubric   TEXT         NOT NULL,
  rubric_version        TEXT         NOT NULL,
  verdict               TEXT         NOT NULL CHECK (verdict IN ('pass','fail','inconclusive')),
  overall_score         REAL         NOT NULL,
  dim_scores            JSONB        NOT NULL,
  cost_usd              REAL         NOT NULL,
  receipt_json          JSONB        NOT NULL,
  receipt_disk_path     TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (receipt_sha8_corpus, receipt_sha8_prompt, receipt_sha8_models, receipt_sha8_rubric)
);
CREATE INDEX IF NOT EXISTS eval_takes_quality_runs_trend_idx
  ON eval_takes_quality_runs (rubric_version, created_at DESC);

-- ============================================================
-- eval_contradictions_cache (v0.32.6): persistent judge verdicts for the
-- contradiction probe. Composite key includes prompt_version + truncation_
-- policy so prompt edits cleanly invalidate prior verdicts (Codex fix).
-- TTL via expires_at; sweep runs periodically from cache.ts.
-- ============================================================
CREATE TABLE IF NOT EXISTS eval_contradictions_cache (
  chunk_a_hash       TEXT         NOT NULL,
  chunk_b_hash       TEXT         NOT NULL,
  model_id           TEXT         NOT NULL,
  prompt_version     TEXT         NOT NULL,
  truncation_policy  TEXT         NOT NULL,
  verdict            JSONB        NOT NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ  NOT NULL,
  PRIMARY KEY (chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy)
);
CREATE INDEX IF NOT EXISTS eval_contradictions_cache_expires_idx
  ON eval_contradictions_cache (expires_at);

-- ============================================================
-- eval_contradictions_runs (v0.32.6): time-series tracking for the probe.
-- One row per 'gbrain eval suspected-contradictions' run; source for the
-- 'trend' sub-subcommand and the doctor 'contradictions' check.
-- ============================================================
CREATE TABLE IF NOT EXISTS eval_contradictions_runs (
  run_id                       TEXT         PRIMARY KEY,
  ran_at                       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  schema_version               INTEGER      NOT NULL DEFAULT 1,
  judge_model                  TEXT         NOT NULL,
  prompt_version               TEXT         NOT NULL,
  queries_evaluated            INTEGER      NOT NULL,
  queries_with_contradiction   INTEGER      NOT NULL,
  total_contradictions_flagged INTEGER      NOT NULL,
  wilson_ci_lower              REAL         NOT NULL,
  wilson_ci_upper              REAL         NOT NULL,
  judge_errors_total           INTEGER      NOT NULL,
  cost_usd_total               REAL         NOT NULL,
  duration_ms                  INTEGER      NOT NULL,
  source_tier_breakdown        JSONB        NOT NULL,
  report_json                  JSONB        NOT NULL
);
CREATE INDEX IF NOT EXISTS eval_contradictions_runs_ran_at_idx
  ON eval_contradictions_runs (ran_at DESC);

-- ============================================================
-- v0.36.1.0 Hindsight calibration wave (PGLite parity)
-- See src/core/migrate.ts v67-v71 for full design notes.
-- ============================================================
CREATE TABLE IF NOT EXISTS calibration_profiles (
  id                      BIGSERIAL PRIMARY KEY,
  source_id               TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  holder                  TEXT         NOT NULL,
  wave_version            TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  generated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  published               BOOLEAN      NOT NULL DEFAULT false,
  total_resolved          INTEGER      NOT NULL,
  brier                   REAL,
  accuracy                REAL,
  partial_rate            REAL,
  grade_completion        REAL         NOT NULL DEFAULT 1.0,
  domain_scorecards       JSONB        NOT NULL,
  pattern_statements      TEXT[]       NOT NULL,
  voice_gate_passed       BOOLEAN      NOT NULL,
  voice_gate_attempts     SMALLINT     NOT NULL,
  active_bias_tags        TEXT[]       NOT NULL,
  model_id                TEXT         NOT NULL,
  cost_usd                NUMERIC(10,4),
  judge_model_agreement   REAL
);
CREATE INDEX IF NOT EXISTS calibration_profiles_holder_recent_idx
  ON calibration_profiles (source_id, holder, generated_at DESC);
CREATE INDEX IF NOT EXISTS calibration_profiles_bias_tags_gin
  ON calibration_profiles USING GIN (active_bias_tags);
CREATE INDEX IF NOT EXISTS calibration_profiles_published_idx
  ON calibration_profiles (source_id, published, holder)
  WHERE published = true;

CREATE TABLE IF NOT EXISTS take_proposals (
  id                          BIGSERIAL PRIMARY KEY,
  source_id                   TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page_slug                   TEXT         NOT NULL,
  content_hash                TEXT         NOT NULL,
  prompt_version              TEXT         NOT NULL,
  wave_version                TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  proposed_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  proposal_run_id             TEXT         NOT NULL,
  status                      TEXT         NOT NULL DEFAULT 'pending'
                                           CHECK (status IN ('pending','accepted','rejected','superseded')),
  claim_text                  TEXT         NOT NULL,
  kind                        TEXT         NOT NULL,
  holder                      TEXT         NOT NULL,
  weight                      REAL         NOT NULL,
  domain                      TEXT,
  dedup_against_fence_rows    JSONB,
  model_id                    TEXT         NOT NULL,
  acted_at                    TIMESTAMPTZ,
  acted_by                    TEXT,
  promoted_row_num            INTEGER,
  predicted_brier             REAL,
  predicted_brier_bucket_n    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS take_proposals_idempotency_idx
  ON take_proposals (source_id, page_slug, content_hash, prompt_version);
CREATE INDEX IF NOT EXISTS take_proposals_pending_idx
  ON take_proposals (source_id, status, proposed_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS take_proposals_run_id_idx
  ON take_proposals (proposal_run_id);

CREATE TABLE IF NOT EXISTS take_grade_cache (
  take_id            BIGINT       NOT NULL,
  prompt_version     TEXT         NOT NULL,
  judge_model_id     TEXT         NOT NULL,
  evidence_signature TEXT         NOT NULL,
  wave_version       TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  graded_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  verdict            TEXT         NOT NULL
                                  CHECK (verdict IN ('correct','incorrect','partial','unresolvable')),
  confidence         REAL         NOT NULL,
  applied            BOOLEAN      NOT NULL DEFAULT false,
  cost_usd           NUMERIC(10,4),
  PRIMARY KEY (take_id, prompt_version, judge_model_id, evidence_signature)
);
CREATE INDEX IF NOT EXISTS take_grade_cache_applied_idx
  ON take_grade_cache (take_id, applied);
CREATE INDEX IF NOT EXISTS take_grade_cache_wave_idx
  ON take_grade_cache (wave_version, graded_at DESC);

CREATE TABLE IF NOT EXISTS take_nudge_log (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  take_id         BIGINT,
  proposal_id     BIGINT       REFERENCES take_proposals(id) ON DELETE CASCADE,
  nudge_pattern   TEXT         NOT NULL,
  fired_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  channel         TEXT         NOT NULL DEFAULT 'stderr',
  wave_version    TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  CONSTRAINT take_nudge_log_target_xor
    CHECK ((take_id IS NOT NULL) <> (proposal_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS take_nudge_log_take_cooldown_idx
  ON take_nudge_log (take_id, nudge_pattern, fired_at DESC)
  WHERE take_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS take_nudge_log_proposal_cooldown_idx
  ON take_nudge_log (proposal_id, nudge_pattern, fired_at DESC)
  WHERE proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS take_nudge_log_wave_idx
  ON take_nudge_log (wave_version, fired_at DESC);

-- think_ab_results (v0.36.1.0 T18 / D19): A/B harness data.
CREATE TABLE IF NOT EXISTS think_ab_results (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT         NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  wave_version    TEXT         NOT NULL DEFAULT 'v0.36.1.0',
  ran_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  question        TEXT         NOT NULL,
  baseline_answer TEXT         NOT NULL,
  with_calibration_answer TEXT NOT NULL,
  preferred       TEXT         NOT NULL CHECK (preferred IN ('baseline','with_calibration','neither','tie')),
  model_id        TEXT,
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS think_ab_results_recent_idx
  ON think_ab_results (source_id, ran_at DESC);

-- ============================================================
-- access_tokens: legacy bearer tokens for remote MCP access
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
  source_id               TEXT REFERENCES sources(id) ON DELETE RESTRICT,
  federated_read          TEXT[] NOT NULL DEFAULT '{}',
  -- v0.38 Slice 2 + 3: per-OAuth-client budget cap (v84) + agent binding (v85).
  -- bound_* columns are NULL on legacy clients (no agent scope by default).
  budget_usd_per_day      NUMERIC(10, 2) NULL,
  bound_tools             TEXT[] NULL,
  bound_source_id         TEXT NULL,
  bound_brain_id          TEXT NULL,
  bound_slug_prefixes     TEXT[] NULL,
  bound_max_concurrent    INTEGER NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- v0.34.1 (#861, D13 + #876): source_id is the OAuth client's write-source
-- scope; federated_read is its read-source array (a federated client can
-- read sources beyond its source_id). Migration v60 adds source_id;
-- v61-v65 add federated_read + GIN index + flip FK to RESTRICT. Fresh
-- installs land in the post-migration shape via the inline columns above.
CREATE INDEX IF NOT EXISTS idx_oauth_clients_source_id
  ON oauth_clients(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_clients_federated_read
  ON oauth_clients USING GIN (federated_read);

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
-- op_checkpoints (v0.36+ autonomous-remediation wave, migration v67)
-- Shared checkpoint table for long-running ops. See migrate.ts:67 for
-- the design rationale; PGLite engine can also fall back to file-backed
-- storage per src/core/op-checkpoint.ts.
-- ============================================================
CREATE TABLE IF NOT EXISTS op_checkpoints (
  op             TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  -- v0.42.x: must be a JSONB array. The loader runs jsonb_array_elements_text
  -- over it; a scalar would throw and wipe the whole checkpoint load. CHECK is
  -- the DB-enforced always-on guard (mirrors migration v119).
  completed_keys JSONB NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT op_checkpoints_completed_keys_array CHECK (jsonb_typeof(completed_keys) = 'array'),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (op, fingerprint)
);
CREATE INDEX IF NOT EXISTS op_checkpoints_updated_at_idx
  ON op_checkpoints (updated_at);

-- #1794: append-only delta storage (one row per completed path). FK cascade
-- drops children with the parent. PK prefix (op,fingerprint) serves all reads.
-- Mirrors migration v115 + src/schema.sql. Placed after op_checkpoints so the
-- FK target exists in the top-to-bottom replay.
CREATE TABLE IF NOT EXISTS op_checkpoint_paths (
  op          TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  path        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (op, fingerprint, path),
  CONSTRAINT op_checkpoint_paths_parent_fk
    FOREIGN KEY (op, fingerprint) REFERENCES op_checkpoints (op, fingerprint) ON DELETE CASCADE
);

-- #2095 push-based context: feedback-loop log of volunteered pages.
-- Mirrors migration v117 + src/schema.sql. "Used" derives from
-- pages.last_retrieved_at > volunteered_at; 90-day prune in the dream
-- cycle's purge phase.
CREATE TABLE IF NOT EXISTS context_volunteer_events (
  id             BIGSERIAL PRIMARY KEY,
  source_id      TEXT NOT NULL,
  slug           TEXT NOT NULL,
  confidence     DOUBLE PRECISION NOT NULL,
  match_arm      TEXT NOT NULL,
  rationale      TEXT NOT NULL DEFAULT '',
  channel        TEXT NOT NULL DEFAULT 'op',
  session_id     TEXT,
  turn           INTEGER,
  volunteered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS context_volunteer_events_src_time_idx
  ON context_volunteer_events (source_id, volunteered_at DESC);
CREATE INDEX IF NOT EXISTS context_volunteer_events_src_slug_idx
  ON context_volunteer_events (source_id, slug);

-- ============================================================
-- migration_impact_log (v0.41.18.0 — gbrain onboard wave)
-- ============================================================
-- See src/schema.sql for full rationale.
CREATE TABLE IF NOT EXISTS migration_impact_log (
  id              BIGSERIAL PRIMARY KEY,
  remediation_id  TEXT      NOT NULL,
  metric_name     TEXT      NOT NULL,
  metric_before   NUMERIC,
  metric_after    NUMERIC,
  job_id          BIGINT    REFERENCES minion_jobs(id) ON DELETE SET NULL,
  source_id       TEXT,
  brain_id        TEXT,
  started_at      TIMESTAMPTZ,
  idempotency_key TEXT,
  applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by      TEXT,
  details         JSONB     DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS migration_impact_log_remediation_idx
  ON migration_impact_log(remediation_id, applied_at DESC);
CREATE INDEX IF NOT EXISTS migration_impact_log_attribution_idx
  ON migration_impact_log(job_id, source_id) WHERE job_id IS NOT NULL;

-- ============================================================
-- Trigger-based search_vector (spans pages + timeline_entries)
-- ============================================================
ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_pages_search ON pages USING GIN(search_vector);

CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS $$
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

-- v0.42 type-unification (T1, plan D1+D11+D17): slug_aliases backs the
-- concept-redirect → alias-table migration. Wikilinks like
-- [[old-redirect-slug]] resolve to canonical via engine.resolveSlugWithAlias
-- short-circuit. Source-scoped throughout (codex F12: dangling_aliases
-- doctor check joins on (source_id, alias_slug)).
CREATE TABLE IF NOT EXISTS slug_aliases (
  id             BIGSERIAL PRIMARY KEY,
  source_id      TEXT NOT NULL,
  alias_slug     TEXT NOT NULL,
  canonical_slug TEXT NOT NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT slug_aliases_no_self CHECK (alias_slug <> canonical_slug),
  CONSTRAINT slug_aliases_uniq UNIQUE (source_id, alias_slug)
);
CREATE INDEX IF NOT EXISTS slug_aliases_canonical_idx
  ON slug_aliases (source_id, canonical_slug);

-- T3 retrieval-cathedral (retrieval-maxpool incident): free-text alias
-- resolution for SEARCH. Distinct from slug_aliases (slug->slug wikilink
-- redirect): page_aliases maps a normalized free-text name ("hall of light",
-- "明堂") to a canonical slug so a query that is a chosen name surfaces the
-- page. alias_norm is normalizeAlias() output; the (source_id, alias_norm,
-- slug) triple is unique so re-ingest is idempotent without blocking a second
-- page claiming the same alias (collisions reported + resolved at query time).
CREATE TABLE IF NOT EXISTS page_aliases (
  id          BIGSERIAL PRIMARY KEY,
  source_id   TEXT NOT NULL,
  alias_norm  TEXT NOT NULL,
  slug        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT page_aliases_uniq UNIQUE (source_id, alias_norm, slug)
);
CREATE INDEX IF NOT EXISTS page_aliases_lookup_idx
  ON page_aliases (source_id, alias_norm);
CREATE INDEX IF NOT EXISTS page_aliases_slug_idx
  ON page_aliases (source_id, slug);
`;

/**
 * Return the PGLite schema SQL with embedding vector dim + model name substituted.
 * Defaults come from the AI gateway (v0.36+: zeroentropyai:zembed-1 / 1280d).
 *
 * v0.37.x fix wave: defaults track gateway constants instead of stale v0.13
 * OpenAI literals so the pre-computed `PGLITE_SCHEMA_SQL` constant doesn't
 * size the column to 1536 while the runtime default model emits 1280.
 */
export function getPGLiteSchema(
  dims: number = DEFAULT_EMBEDDING_DIMENSIONS,
  model: string = DEFAULT_EMBEDDING_MODEL,
): string {
  const parsedDims = Number(dims);
  if (!Number.isInteger(parsedDims) || parsedDims <= 0) {
    throw new Error(`Invalid embedding dimensions: ${dims}`);
  }
  const sanitizedModel = String(model).replace(/'/g, "''");
  return applyChunkEmbeddingIndexPolicy(PGLITE_SCHEMA_SQL_TEMPLATE, parsedDims)
    .replace(/__EMBEDDING_DIMS__/g, String(parsedDims))
    .replace(/__EMBEDDING_MODEL__/g, sanitizedModel);
}

/** Back-compat: pre-computed default-1536 schema for existing callers. */
export const PGLITE_SCHEMA_SQL = getPGLiteSchema();
