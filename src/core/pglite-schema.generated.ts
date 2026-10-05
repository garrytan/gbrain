// AUTO-GENERATED — do not edit. Run: bun run build:schema
// Sources: src/schema.sql + the TS fragment modules, transformed by the PGLite
// capability rules in scripts/build-schema.ts (docs/ENGINES.md#canonical-schema-sources).
// A template: __EMBEDDING_DIMS__ / __EMBEDDING_MODEL__ and the chunk-index and
// FTS-language policies are applied at runtime by getPGLiteSchema(dims, model).

import { applyChunkEmbeddingIndexPolicy } from './vector-index.ts';
import { applyFtsLanguagePolicy } from './fts-language.ts';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_DIMENSIONS } from './ai/defaults.ts';

export const PGLITE_SCHEMA_SQL_TEMPLATE = `
-- GBrain PGLite schema (local embedded Postgres), generated from src/schema.sql
-- and the TS schema fragments by scripts/build-schema.ts.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  local_path      TEXT,
  last_commit     TEXT,
  last_sync_at    TIMESTAMPTZ,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  archived            BOOLEAN NOT NULL DEFAULT false,
  archived_at         TIMESTAMPTZ,
  archive_expires_at  TIMESTAMPTZ,
  contextual_retrieval_mode   TEXT,
  trust_frontmatter_overrides BOOLEAN NOT NULL DEFAULT false,
  newest_content_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO sources (id, name, config)
  SELECT 'default', 'default', '{"federated": true}'::jsonb
  WHERE NOT EXISTS (SELECT 1 FROM sources WHERE id = 'default')
  ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS sources_github_repo_idx
  ON sources ((config->>'github_repo'))
  WHERE config ? 'github_repo';

CREATE TABLE IF NOT EXISTS pages (
  id            SERIAL PRIMARY KEY,
  source_id     TEXT    NOT NULL DEFAULT 'default'
                REFERENCES sources(id) ON DELETE CASCADE,
  slug          TEXT    NOT NULL,
  type          TEXT    NOT NULL,
  page_kind     TEXT    NOT NULL DEFAULT 'markdown'
                CHECK (page_kind IN ('markdown','code','image')),
  title         TEXT    NOT NULL,
  compiled_truth TEXT   NOT NULL DEFAULT '',
  timeline      TEXT    NOT NULL DEFAULT '',
  frontmatter   JSONB   NOT NULL DEFAULT '{}',
  content_hash  TEXT,
  emotional_weight REAL NOT NULL DEFAULT 0.0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  effective_date        TIMESTAMPTZ,
  effective_date_source TEXT,
  import_filename       TEXT,
  salience_touched_at   TIMESTAMPTZ,
  last_retrieved_at     TIMESTAMPTZ,
  links_extracted_at    TIMESTAMPTZ,
  database_only_reason  TEXT,
  contextual_retrieval_mode  TEXT,
  corpus_generation          TEXT,
  generation     BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT pages_source_slug_key UNIQUE (source_id, slug)
);

CREATE OR REPLACE FUNCTION bump_page_generation_fn() RETURNS trigger SET search_path = pg_catalog, public AS \$func\$
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
\$func\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_page_generation_trg ON pages;
CREATE TRIGGER bump_page_generation_trg
  BEFORE INSERT OR UPDATE ON pages
  FOR EACH ROW
  EXECUTE FUNCTION bump_page_generation_fn();

CREATE TABLE IF NOT EXISTS page_generation_clock (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value BIGINT  NOT NULL DEFAULT 0
);
INSERT INTO page_generation_clock (id, value)
  VALUES (1, COALESCE((SELECT MAX(generation) FROM pages), 0))
  ON CONFLICT (id) DO NOTHING;

CREATE SEQUENCE IF NOT EXISTS page_generation_clock_seq;
SELECT setval('page_generation_clock_seq', GREATEST(
  1,
  COALESCE((SELECT last_value FROM page_generation_clock_seq), 0),
  COALESCE((SELECT value FROM page_generation_clock WHERE id = 1), 0),
  COALESCE((SELECT MAX(generation) FROM pages), 0)
));

CREATE OR REPLACE FUNCTION bump_page_generation_clock_fn() RETURNS trigger SET search_path = pg_catalog, public AS \$func\$
BEGIN
  PERFORM nextval('page_generation_clock_seq');
  RETURN NULL;
END;
\$func\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bump_page_generation_clock_trg ON pages;
CREATE TRIGGER bump_page_generation_clock_trg
  AFTER INSERT OR UPDATE OR DELETE ON pages
  FOR EACH STATEMENT
  EXECUTE FUNCTION bump_page_generation_clock_fn();

CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);
CREATE INDEX IF NOT EXISTS idx_pages_frontmatter ON pages USING GIN(frontmatter);
CREATE INDEX IF NOT EXISTS idx_pages_trgm ON pages USING GIN(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_pages_source_id ON pages(source_id);
CREATE INDEX IF NOT EXISTS pages_deleted_at_purge_idx
  ON pages (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pages_last_retrieved_at_idx
  ON pages (last_retrieved_at);
CREATE INDEX IF NOT EXISTS pages_links_extracted_at_idx
  ON pages (source_id, links_extracted_at);
CREATE INDEX IF NOT EXISTS pages_coalesce_date_idx
  ON pages ((COALESCE(effective_date, updated_at)));

CREATE TABLE IF NOT EXISTS content_chunks (
  id                    SERIAL PRIMARY KEY,
  page_id               INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index           INTEGER NOT NULL,
  chunk_text            TEXT    NOT NULL,
  chunk_source          TEXT    NOT NULL DEFAULT 'compiled_truth',
  embedding             vector(__EMBEDDING_DIMS__),
  model                 TEXT    NOT NULL DEFAULT '__EMBEDDING_MODEL__',
  token_count           INTEGER,
  embedded_at           TIMESTAMPTZ,
  embedded_text_hash    TEXT,
  embedding_input_hash  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  language              TEXT,
  symbol_name           TEXT,
  symbol_type           TEXT,
  start_line            INTEGER,
  end_line              INTEGER,
  modality              TEXT NOT NULL DEFAULT 'text',
  embedding_image       vector(1024),
  embedding_multimodal  vector(1024)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name ON content_chunks(symbol_name) WHERE symbol_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_language ON content_chunks(language) WHERE language IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_image
  ON content_chunks USING hnsw (embedding_image vector_cosine_ops)
  WHERE embedding_image IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_chunks_stale_idx
  ON content_chunks(page_id, chunk_index) WHERE embedding IS NULL;

CREATE TABLE IF NOT EXISTS links (
  id             SERIAL PRIMARY KEY,
  from_page_id   INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type      TEXT    NOT NULL DEFAULT '',
  context        TEXT    NOT NULL DEFAULT '',
  link_source    TEXT    CHECK (link_source IS NULL OR (link_source ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*\$' AND char_length(link_source) <= 64)),
  link_kind      TEXT    CHECK (link_kind IS NULL OR link_kind IN ('plain', 'typed_ner')),
  origin_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  origin_field   TEXT,
  resolution_type TEXT   CHECK (resolution_type IS NULL OR resolution_type IN ('qualified', 'unqualified')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  assertion_tense TEXT   CONSTRAINT links_assertion_tense_check CHECK (assertion_tense IS NULL OR assertion_tense IN ('present', 'past')),
  CONSTRAINT links_from_to_type_source_origin_unique
    UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_page_id);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(link_source);
CREATE INDEX IF NOT EXISTS idx_links_origin ON links(origin_page_id);
CREATE OR REPLACE VIEW page_links AS
  SELECT id, from_page_id, to_page_id FROM links;


CREATE TABLE IF NOT EXISTS tags (
  id      SERIAL PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  tag_source TEXT,
  UNIQUE(page_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);

CREATE TABLE IF NOT EXISTS raw_data (
  id         SERIAL PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL,
  data       JSONB   NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(page_id, source)
);

CREATE INDEX IF NOT EXISTS idx_raw_data_page ON raw_data(page_id);

CREATE TABLE IF NOT EXISTS timeline_entries (
  id       SERIAL PRIMARY KEY,
  page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  date     DATE    NOT NULL,
  source   TEXT    NOT NULL DEFAULT '',
  summary  TEXT    NOT NULL,
  detail   TEXT    NOT NULL DEFAULT '',
  event_page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_timeline_page ON timeline_entries(page_id);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_entries(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup ON timeline_entries(page_id, date, md5(summary), source);
CREATE INDEX IF NOT EXISTS idx_timeline_event_page ON timeline_entries(event_page_id) WHERE event_page_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_event_dedup ON timeline_entries(event_page_id, date) WHERE event_page_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS page_versions (
  id             SERIAL PRIMARY KEY,
  page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  compiled_truth TEXT    NOT NULL,
  frontmatter    JSONB   NOT NULL DEFAULT '{}',
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_versions_page ON page_versions(page_id);

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
  source_id               TEXT REFERENCES sources(id) ON DELETE RESTRICT,
  federated_read          TEXT[] NOT NULL DEFAULT '{}',
  budget_usd_per_day      NUMERIC(10, 2) NULL,
  bound_tools             TEXT[] NULL,
  bound_source_id         TEXT NULL,
  bound_brain_id          TEXT NULL,
  bound_slug_prefixes     TEXT[] NULL,
  bound_max_concurrent    INTEGER NOT NULL DEFAULT 1,
  surface                 TEXT NULL,
  surface_set_by          TEXT NULL,
  allowed_operations      TEXT[] NULL,
  delegated_slug_prefixes TEXT[] NULL,
  delegated_namespace    TEXT NOT NULL DEFAULT 'prefixes',
  grant_profile           TEXT NULL,
  grant_revision          INTEGER NOT NULL DEFAULT 0,
  grant_repair_reasons    TEXT[] NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_grant            TEXT NULL CHECK (source_grant IN ('none')),
  takes_holders           TEXT[] NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_clients_source_id
  ON oauth_clients(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_oauth_clients_federated_read
  ON oauth_clients USING GIN (federated_read);


CREATE TABLE IF NOT EXISTS oauth_grant_audit (
  id BIGSERIAL PRIMARY KEY,
  client_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  revision INTEGER NOT NULL,
  before_grant JSONB,
  after_grant JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_grant_audit_client ON oauth_grant_audit(client_id, created_at);

-- The facts index and withdrawal trigger are installed by migrations 60/148.
CREATE TABLE IF NOT EXISTS fact_withdrawals (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','world')),
    subject TEXT NOT NULL DEFAULT '*',
    fact_hash TEXT NOT NULL,
    withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, visibility, subject, fact_hash)
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

CREATE INDEX IF NOT EXISTS idx_mcp_log_time_agent ON mcp_request_log(created_at, token_name);
CREATE INDEX IF NOT EXISTS idx_mcp_log_agent_time ON mcp_request_log(agent_name, created_at DESC);

CREATE TABLE IF NOT EXISTS op_checkpoints (
  op             TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  completed_keys JSONB NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT op_checkpoints_completed_keys_array CHECK (jsonb_typeof(completed_keys) = 'array'),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (op, fingerprint)
);
CREATE INDEX IF NOT EXISTS op_checkpoints_updated_at_idx
  ON op_checkpoints (updated_at);
CREATE INDEX IF NOT EXISTS op_checkpoints_sync_hold_page_idx
  ON op_checkpoints ((completed_keys->0->>'page_id')) WHERE op = 'sync-hold';

CREATE TABLE IF NOT EXISTS op_checkpoint_paths (
  op          TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  path        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (op, fingerprint, path),
  CONSTRAINT op_checkpoint_paths_parent_fk
    FOREIGN KEY (op, fingerprint) REFERENCES op_checkpoints (op, fingerprint) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS retrieval_events (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL DEFAULT 'local',
  op          TEXT NOT NULL CHECK (op IN ('query','search','think','synthesize','recall')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retrieval_events_time_idx ON retrieval_events (created_at);
CREATE TABLE IF NOT EXISTS retrieval_event_pages (
  event_id      TEXT NOT NULL REFERENCES retrieval_events(id) ON DELETE CASCADE,
  source_id     TEXT NOT NULL,
  slug          TEXT NOT NULL,
  content_hash  TEXT,
  rank          INTEGER NOT NULL,
  cited         BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (event_id, source_id, slug)
);
CREATE TABLE IF NOT EXISTS retrieval_event_links (
  event_id   TEXT NOT NULL REFERENCES retrieval_events(id) ON DELETE CASCADE,
  source_id  TEXT NOT NULL,
  edge_key   TEXT NOT NULL,
  to_slug    TEXT NOT NULL,
  PRIMARY KEY (event_id, source_id, edge_key, to_slug)
);
CREATE TABLE IF NOT EXISTS retrieval_feedback (
  event_id       TEXT NOT NULL REFERENCES retrieval_events(id) ON DELETE CASCADE,
  signal         TEXT NOT NULL CHECK (signal IN ('explicit','cited')),
  element_kind   TEXT NOT NULL CHECK (element_kind IN ('page','link')),
  source_id      TEXT NOT NULL,
  element_key    TEXT NOT NULL,
  client_id      TEXT NOT NULL DEFAULT 'local',
  rating         SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  weight_before  REAL NOT NULL,
  weight_after   REAL NOT NULL,
  applied_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, signal, element_kind, source_id, element_key)
);
CREATE INDEX IF NOT EXISTS retrieval_feedback_client_time_idx
  ON retrieval_feedback (client_id, applied_at DESC);
CREATE TABLE IF NOT EXISTS retrieval_weights (
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  element_kind  TEXT NOT NULL CHECK (element_kind IN ('page','link')),
  element_key   TEXT NOT NULL,
  weight        REAL NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
  content_hash  TEXT,
  updates       INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, element_kind, element_key)
);

CREATE TABLE IF NOT EXISTS session_context_state (
  source_id           TEXT NOT NULL,
  client_id           TEXT NOT NULL DEFAULT 'local',
  session_id          TEXT NOT NULL,
  standing_entities   JSONB NOT NULL DEFAULT '[]'::jsonb,
  surfaced_slugs      JSONB NOT NULL DEFAULT '[]'::jsonb,
  checkpoint_manifest JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_wake_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  facts_cursor_at     TIMESTAMPTZ,
  facts_cursor_id     BIGINT,
  degraded_wakes      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, client_id, session_id)
);
CREATE INDEX IF NOT EXISTS session_context_state_updated_idx
  ON session_context_state (updated_at);

CREATE TABLE IF NOT EXISTS extract_atoms_transcript_state (
  source_id    TEXT        NOT NULL DEFAULT 'default',
  file_path    TEXT        NOT NULL,
  content_hash TEXT        NOT NULL,
  fail_count   INTEGER     NOT NULL DEFAULT 0,
  tombstoned   BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, file_path, content_hash)
);
CREATE INDEX IF NOT EXISTS extract_atoms_transcript_state_tombstoned_idx
  ON extract_atoms_transcript_state (source_id, content_hash)
  WHERE tombstoned;

CREATE TABLE IF NOT EXISTS chat_usage_log (
  id                 BIGSERIAL PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  model              TEXT NOT NULL,
  provider           TEXT,
  phase              TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_chat_usage_log_created
  ON chat_usage_log (created_at);
CREATE INDEX IF NOT EXISTS idx_chat_usage_log_model
  ON chat_usage_log (model, created_at);

CREATE TABLE IF NOT EXISTS open_loops (
  id                 BIGSERIAL PRIMARY KEY,
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  dedup_key          TEXT NOT NULL,
  loop_type          TEXT NOT NULL CHECK (loop_type IN (
                       'commitment_owed_by_me','commitment_owed_to_me',
                       'unanswered_inbound','unanswered_outbound','decision_pending')),
  counterparty_slug  TEXT,
  counterparty_email TEXT,
  summary            TEXT NOT NULL,
  evidence           JSONB NOT NULL DEFAULT '[]'::jsonb,
  thread_id          TEXT,
  page_slug          TEXT,
  due_at             TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped','stale')),
  detector           TEXT NOT NULL CHECK (detector IN ('deterministic_thread','llm_extract','manual')),
  confidence         REAL NOT NULL DEFAULT 1.0,
  fact_id            BIGINT,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ,
  closed_by          TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT open_loops_dedup UNIQUE (source_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS open_loops_status_idx
  ON open_loops (source_id, status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS open_loops_counterparty_idx
  ON open_loops (source_id, counterparty_slug) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS open_loops_thread_idx
  ON open_loops (source_id, thread_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS loop_suppressions (
  id         BIGSERIAL PRIMARY KEY,
  source_id  TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('sender','thread')),
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT loop_suppressions_uniq UNIQUE (source_id, kind, value)
);


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

ALTER TABLE pages ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_pages_search ON pages USING GIN(search_vector);

CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS \$\$
DECLARE
  timeline_text TEXT;
BEGIN
  SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '')
  INTO timeline_text
  FROM timeline_entries
  WHERE page_id = NEW.id;

  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.timeline, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(timeline_text, '')), 'C');

  RETURN NEW;
END;
\$\$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages;
CREATE TRIGGER trg_pages_search_vector
  BEFORE INSERT OR UPDATE OF title,timeline ON pages
  FOR EACH ROW
  EXECUTE FUNCTION update_page_search_vector();

DROP TRIGGER IF EXISTS trg_timeline_search_vector ON timeline_entries;
DROP FUNCTION IF EXISTS update_page_search_vector_from_timeline();
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


CREATE TABLE IF NOT EXISTS minion_jobs (
  id               SERIAL PRIMARY KEY,
  name             TEXT        NOT NULL,
  queue            TEXT        NOT NULL DEFAULT 'default',
  status           TEXT        NOT NULL DEFAULT 'waiting',
  priority         INTEGER     NOT NULL DEFAULT 0,
  submission_authority JSONB,
  claim_generation BIGINT NOT NULL DEFAULT 0,
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
  lock_duration_ms INTEGER,
  timeout_at       TIMESTAMPTZ,
  remove_on_complete BOOLEAN   NOT NULL DEFAULT FALSE,
  remove_on_fail   BOOLEAN     NOT NULL DEFAULT FALSE,
  idempotency_key  TEXT,
  private_queue_owner_job_id INTEGER REFERENCES minion_jobs(id) ON DELETE SET NULL,
  private_queue_owner_token TEXT,
  private_queue_lease_until TIMESTAMPTZ,
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
  CONSTRAINT chk_timeout_positive CHECK (timeout_ms IS NULL OR timeout_ms > 0),
  CONSTRAINT chk_lock_duration_positive CHECK (lock_duration_ms IS NULL OR (lock_duration_ms >= 5000 AND lock_duration_ms <= 3600000))
);

CREATE INDEX IF NOT EXISTS idx_minion_jobs_claim ON minion_jobs (queue, priority ASC, created_at ASC) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS idx_minion_jobs_status ON minion_jobs(status);
CREATE INDEX IF NOT EXISTS idx_minion_jobs_stalled ON minion_jobs (lock_until) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_minion_jobs_delayed ON minion_jobs (delay_until) WHERE status = 'delayed';
CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent ON minion_jobs(parent_job_id);
CREATE INDEX IF NOT EXISTS idx_minion_jobs_timeout ON minion_jobs (timeout_at) WHERE status = 'active' AND timeout_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent_status ON minion_jobs (parent_job_id, status) WHERE parent_job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_minion_jobs_idempotency ON minion_jobs (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_minion_jobs_queue_status_updated ON minion_jobs (queue, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_minion_jobs_private_queue_recovery
  ON minion_jobs (queue, private_queue_lease_until)
  WHERE queue LIKE 'dream-inline-%'
    AND status IN ('waiting','active','delayed','waiting-children','paused');
CREATE INDEX IF NOT EXISTS idx_minion_jobs_private_queue_owner
  ON minion_jobs (private_queue_owner_job_id)
  WHERE private_queue_owner_job_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS subagent_messages (
  id                  BIGSERIAL PRIMARY KEY,
  job_id              BIGINT      NOT NULL REFERENCES minion_jobs(id) ON DELETE CASCADE,
  message_idx         INTEGER     NOT NULL,
  role                TEXT        NOT NULL,
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
  ordinal             INTEGER,
  gbrain_tool_use_id  UUID,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at            TIMESTAMPTZ,
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

CREATE TABLE IF NOT EXISTS gbrain_cycle_locks (
  id                 TEXT        PRIMARY KEY,
  holder_pid         INT         NOT NULL,
  holder_host        TEXT,
  acquired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ttl_expires_at     TIMESTAMPTZ NOT NULL,
  last_refreshed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cycle_locks_ttl ON gbrain_cycle_locks(ttl_expires_at);
ALTER TABLE gbrain_cycle_locks
  ADD COLUMN IF NOT EXISTS acquisition_token UUID NOT NULL DEFAULT gen_random_uuid();

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
  as_of_ts              TIMESTAMPTZ,
  salience_param        TEXT,
  recency_param         TEXT,
  salience_resolved     TEXT,
  recency_resolved      TEXT,
  salience_source       TEXT,
  recency_source        TEXT,
  embedding_column      TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_candidates_created_at ON eval_candidates(created_at DESC);

CREATE TABLE IF NOT EXISTS eval_capture_failures (
  id      SERIAL       PRIMARY KEY,
  ts      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  reason  TEXT         NOT NULL CHECK (reason IN ('db_down', 'rls_reject', 'check_violation', 'scrubber_exception', 'other'))
);
CREATE INDEX IF NOT EXISTS idx_eval_capture_failures_ts ON eval_capture_failures(ts DESC);

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
  ON take_proposals (source_id, page_slug, content_hash, prompt_version, md5(claim_text));
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


CREATE OR REPLACE FUNCTION enforce_minion_queue_protocol() RETURNS trigger SET search_path = pg_catalog, public AS \$protocol\$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.submission_authority IS NULL OR NEW.claim_generation <> 0 THEN
      RAISE EXCEPTION 'Minion queue protocol 1 required: upgrade every producer and worker before restart';
    END IF;
  ELSIF NEW.status = 'active' AND (OLD.status <> 'active' OR NEW.lock_token IS DISTINCT FROM OLD.lock_token) THEN
    IF NEW.submission_authority IS NULL OR NEW.claim_generation IS DISTINCT FROM OLD.claim_generation + 1 THEN
      RAISE EXCEPTION 'Minion queue protocol 1 required: old workers cannot claim upgraded queue jobs';
    END IF;
    IF NEW.spend_authorization IS NOT NULL AND NEW.spend_claim_token IS DISTINCT FROM NEW.claim_generation THEN
      RAISE EXCEPTION 'Minion spend protocol 1 required: only upgraded workers can claim spend-authorized jobs; restart workers on the upgraded binary';
    END IF;
  ELSIF NEW.claim_generation IS DISTINCT FROM OLD.claim_generation THEN
    RAISE EXCEPTION 'Minion queue claim generation may advance only with a claim';
  END IF;
  RETURN NEW;
END;
\$protocol\$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS minion_queue_protocol ON minion_jobs;
CREATE TRIGGER minion_queue_protocol BEFORE INSERT OR UPDATE ON minion_jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_minion_queue_protocol();

-- Canonical page state (migration 150).
DO \$do\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'sources'::regclass AND attname = 'incarnation' AND NOT attisdropped) THEN
      ALTER TABLE sources ADD COLUMN IF NOT EXISTS incarnation UUID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'sources'::regclass AND attname = 'incarnation' AND atthasdef) THEN
      ALTER TABLE sources ALTER COLUMN incarnation SET DEFAULT gen_random_uuid();
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'sources'::regclass AND attname = 'incarnation' AND NOT attnotnull) THEN
      UPDATE sources SET incarnation = gen_random_uuid() WHERE incarnation IS NULL;
      ALTER TABLE sources ALTER COLUMN incarnation SET NOT NULL;
    END IF;
  END \$do\$;
CREATE UNIQUE INDEX IF NOT EXISTS sources_incarnation_key ON sources(incarnation);
DO \$do\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'pages'::regclass AND attname = 'knowledge_revision' AND NOT attisdropped) THEN
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS knowledge_revision UUID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'pages'::regclass AND attname = 'knowledge_revision' AND atthasdef) THEN
      ALTER TABLE pages ALTER COLUMN knowledge_revision SET DEFAULT gen_random_uuid();
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'pages'::regclass AND attname = 'knowledge_revision' AND NOT attnotnull)
       AND NOT EXISTS (SELECT 1 FROM pages) THEN
      ALTER TABLE pages ALTER COLUMN knowledge_revision SET NOT NULL;
    END IF;
  END \$do\$;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS text_projection_revision UUID;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS knowledge_revision UUID;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS timeline TEXT;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS tags JSONB;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN;;
CREATE TABLE IF NOT EXISTS page_write_guards (
    source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    PRIMARY KEY (source_incarnation, slug)
  );
CREATE OR REPLACE FUNCTION gbrain_advance_page_revision() RETURNS trigger LANGUAGE plpgsql AS \$fn\$
    BEGIN
      IF OLD.knowledge_revision IS NULL THEN
        NEW.knowledge_revision := COALESCE(NEW.knowledge_revision, gen_random_uuid());
        NEW.text_projection_revision := NULL;
        RETURN NEW;
      END IF;
      IF (NEW.source_id, NEW.slug, NEW.type, NEW.page_kind, NEW.title, NEW.compiled_truth,
          NEW.timeline, NEW.frontmatter, NEW.deleted_at)
         IS DISTINCT FROM
         (OLD.source_id, OLD.slug, OLD.type, OLD.page_kind, OLD.title, OLD.compiled_truth,
          OLD.timeline, OLD.frontmatter, OLD.deleted_at) THEN
        IF NEW.knowledge_revision = OLD.knowledge_revision AND NOT (
          COALESCE(current_setting('gbrain.materializing_revision', true), '') = OLD.knowledge_revision::text
          AND (NEW.source_id, NEW.slug, NEW.type, NEW.page_kind, NEW.title, NEW.frontmatter, NEW.deleted_at)
            IS NOT DISTINCT FROM
            (OLD.source_id, OLD.slug, OLD.type, OLD.page_kind, OLD.title, OLD.frontmatter, OLD.deleted_at)
        ) THEN
          NEW.knowledge_revision := gen_random_uuid();
        END IF;
      END IF;
      IF NEW.knowledge_revision IS DISTINCT FROM OLD.knowledge_revision THEN
        NEW.text_projection_revision := NULL;
      END IF;
      RETURN NEW;
    END \$fn\$;
DROP TRIGGER IF EXISTS pages_knowledge_revision ON pages;
CREATE TRIGGER pages_knowledge_revision BEFORE UPDATE ON pages
    FOR EACH ROW EXECUTE FUNCTION gbrain_advance_page_revision();
CREATE OR REPLACE FUNCTION gbrain_advance_tag_revision() RETURNS trigger LANGUAGE plpgsql AS \$fn\$
    BEGIN
      IF TG_OP = 'UPDATE' AND (NEW.page_id, NEW.tag) IS NOT DISTINCT FROM (OLD.page_id, OLD.tag) THEN
        RETURN NULL;
      END IF;
      IF TG_OP <> 'INSERT' THEN
        UPDATE pages SET knowledge_revision = gen_random_uuid() WHERE id = OLD.page_id;
      END IF;
      IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR (NEW.page_id, NEW.tag) IS DISTINCT FROM (OLD.page_id, OLD.tag)) THEN
        UPDATE pages SET knowledge_revision = gen_random_uuid() WHERE id = NEW.page_id;
      END IF;
      RETURN NULL;
    END \$fn\$;
DROP TRIGGER IF EXISTS tags_knowledge_revision ON tags;
CREATE TRIGGER tags_knowledge_revision AFTER INSERT OR DELETE OR UPDATE ON tags
    FOR EACH ROW EXECUTE FUNCTION gbrain_advance_tag_revision();
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS source_path TEXT;
CREATE TABLE IF NOT EXISTS extract_atoms_page_state (
  source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  fail_count INTEGER NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
  tombstoned BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_incarnation, page_id, content_hash)
);
CREATE INDEX IF NOT EXISTS extract_atoms_page_state_tombstoned_idx
  ON extract_atoms_page_state (source_incarnation, content_hash, page_id) WHERE tombstoned;
CREATE INDEX IF NOT EXISTS extract_atoms_page_state_page_idx ON extract_atoms_page_state (page_id);
CREATE TABLE IF NOT EXISTS chronicle_page_state (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  slug TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','skipped','extracted','failed')),
  reason TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('auto','backfill')),
  principal_kind TEXT,
  principal_id TEXT,
  request_id UUID,
  no_extract BOOLEAN NOT NULL DEFAULT false,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ,
  cost_usd NUMERIC,
  unpriced BOOLEAN NOT NULL DEFAULT false,
  event_slugs TEXT[] NOT NULL DEFAULT '{}',
  event_hashes TEXT[] NOT NULL DEFAULT '{}',
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, page_id, content_hash, extractor_version)
);
CREATE INDEX IF NOT EXISTS chronicle_page_state_work_idx
  ON chronicle_page_state (source_id, state, next_attempt_at);
CREATE INDEX IF NOT EXISTS chronicle_page_state_page_idx ON chronicle_page_state (page_id);
CREATE TABLE IF NOT EXISTS chronicle_judge_reservations (
  id BIGSERIAL PRIMARY KEY,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chronicle_judge_reservations_at_idx ON chronicle_judge_reservations (reserved_at);
CREATE TABLE IF NOT EXISTS dream_synthesis_completions (
  source_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, idempotency_key)
);

-- Durable concurrent persistence (migration 151).
CREATE TABLE IF NOT EXISTS persistence_brain (
    singleton integer PRIMARY KEY CHECK (singleton = 1),
    brain_id uuid NOT NULL DEFAULT gen_random_uuid(),
    enabled boolean NOT NULL DEFAULT false,
    activated_at timestamptz
  );
INSERT INTO persistence_brain(singleton) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS persistence_worktrees (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_host_id uuid,
    owner_epoch bigint NOT NULL DEFAULT 0,
    topology_generation bigint NOT NULL DEFAULT 1,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','draining','recovering')),
    manifest jsonb,
    heartbeat_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
CREATE TABLE IF NOT EXISTS persistence_source_bindings (
    source_id text PRIMARY KEY,
    source_incarnation uuid NOT NULL,
    worktree_id uuid NOT NULL REFERENCES persistence_worktrees(id),
    relative_path text NOT NULL DEFAULT '',
    topology_generation bigint NOT NULL DEFAULT 1
  );
CREATE TABLE IF NOT EXISTS persistence_host_bindings (
    worktree_id uuid NOT NULL REFERENCES persistence_worktrees(id),
    host_id uuid NOT NULL,
    local_path text NOT NULL,
    coordination_path text NOT NULL,
    PRIMARY KEY(worktree_id,host_id)
  );
CREATE TABLE IF NOT EXISTS persistence_local_writers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lane text NOT NULL CHECK (lane IN ('cli','stdio')),
    credential_hash text NOT NULL UNIQUE,
    grant_ceiling jsonb NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
CREATE TABLE IF NOT EXISTS persistence_counters (
    key text PRIMARY KEY,
    outstanding_count bigint NOT NULL DEFAULT 0 CHECK (outstanding_count >= 0),
    intent_bytes bigint NOT NULL DEFAULT 0 CHECK (intent_bytes >= 0),
    lifetime_ids bigint NOT NULL DEFAULT 0 CHECK (lifetime_ids >= 0),
    terminal_bytes bigint NOT NULL DEFAULT 0 CHECK (terminal_bytes >= 0),
    recovery_bytes bigint NOT NULL DEFAULT 0 CHECK (recovery_bytes >= 0)
  );
CREATE TABLE IF NOT EXISTS persistence_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_kind text NOT NULL CHECK (principal_kind IN ('oauth_client','legacy_token','local_cli','local_stdio','application')),
    principal_id text NOT NULL,
    request_id uuid NOT NULL,
    operation text NOT NULL,
    source_id text NOT NULL,
    source_incarnation uuid NOT NULL,
    page_id integer,
    slug text NOT NULL,
    worktree_id uuid REFERENCES persistence_worktrees(id),
    topology_generation bigint,
    digest text NOT NULL,
    intent jsonb,
    authority jsonb NOT NULL,
    sequence bigserial NOT NULL UNIQUE,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','recovering','committed','conflict','failed','cancelled')),
    execution_token uuid,
    claim_expires_at timestamptz,
    recovery jsonb,
    recovery_bytes bigint NOT NULL DEFAULT 0,
    intent_bytes bigint NOT NULL,
    terminal_reservation bigint NOT NULL,
    outcome jsonb,
    error_code text,
    error_message text,
    blocked_reason text,
    compacted boolean NOT NULL DEFAULT false,
    publication_started boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE(principal_kind,principal_id,request_id)
  );
CREATE INDEX IF NOT EXISTS persistence_requests_pending ON persistence_requests(worktree_id,sequence)
    WHERE state IN ('queued','running','recovering');
CREATE INDEX IF NOT EXISTS persistence_requests_recovery
  ON persistence_requests(worktree_id,sequence) WHERE recovery IS NOT NULL;
CREATE INDEX IF NOT EXISTS persistence_requests_database_pending
  ON persistence_requests(source_incarnation,sequence) WHERE worktree_id IS NULL AND state IN ('queued','running','recovering');
CREATE INDEX IF NOT EXISTS persistence_requests_sync_run_open
  ON persistence_requests(worktree_id,(intent->>'runId')) WHERE state<>'committed' AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete');
CREATE INDEX IF NOT EXISTS persistence_requests_sync_run_committed
  ON persistence_requests(source_id,(intent->>'runId'),(intent->>'index')) WHERE state='committed' AND intent ? 'runId';
CREATE INDEX IF NOT EXISTS persistence_requests_principal ON persistence_requests(principal_kind,principal_id,sequence DESC);
CREATE TABLE IF NOT EXISTS persistence_effects (
    id bigserial PRIMARY KEY,
    request_id uuid NOT NULL REFERENCES persistence_requests(id),
    kind text NOT NULL,
    revision uuid,
    data jsonb NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','committed','failed')),
    execution_token uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(request_id,kind)
  );

CREATE OR REPLACE FUNCTION gbrain_require_managed_writer() RETURNS trigger LANGUAGE plpgsql AS \$fn\$
DECLARE target_source text; old_source text; row_data jsonb; old_data jsonb; allowed jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM persistence_brain WHERE singleton=1 AND enabled) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_OP='UPDATE' THEN old_data := to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='pages' AND TG_OP='UPDATE' THEN
    IF (NEW.source_id,NEW.slug,NEW.type,NEW.page_kind,NEW.title,NEW.compiled_truth,NEW.timeline,NEW.frontmatter,NEW.deleted_at,NEW.knowledge_revision)
      IS NOT DISTINCT FROM
       (OLD.source_id,OLD.slug,OLD.type,OLD.page_kind,OLD.title,OLD.compiled_truth,OLD.timeline,OLD.frontmatter,OLD.deleted_at,OLD.knowledge_revision) THEN RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME='sources' THEN
    IF TG_OP='UPDATE' AND (NEW.id,NEW.incarnation,NEW.local_path,NEW.archived)
      IS NOT DISTINCT FROM (OLD.id,OLD.incarnation,OLD.local_path,OLD.archived) THEN
      IF (NEW.last_commit,NEW.last_sync_at,NEW.newest_content_at)
        IS NOT DISTINCT FROM (OLD.last_commit,OLD.last_sync_at,OLD.newest_content_at) THEN RETURN NEW; END IF;
      allowed := COALESCE(NULLIF(current_setting('gbrain.write_sources',true),''),'[]')::jsonb;
      IF NOT (allowed ? NEW.id) THEN
        RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: source checkpoints require canonical owner publication',
          TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='managed_writer_guard:checkpoint',
          DETAIL=jsonb_build_object('op',TG_OP,'relationship','checkpoint_outside_owner','target_source',NEW.id,'old_source',OLD.id,'allowed',allowed)::text;
      END IF;
      RETURN NEW;
    END IF;
    IF COALESCE(current_setting('gbrain.topology_change',true),'') <> 'on' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: source topology must be drained and changed through writer administration',
        TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='managed_writer_guard:topology',
        DETAIL=jsonb_build_object('op',TG_OP,'relationship','topology_outside_administration','target_source',row_data->>'id','old_source',old_data->>'id')::text;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  ELSIF TG_TABLE_NAME IN ('facts','takes') AND TG_OP='UPDATE' THEN
    row_data := row_data - ARRAY['embedding_model','embedded_text_hash'] - ARRAY['write_request_id','write_principal_kind','write_principal_id','last_write_request_id','last_write_principal_kind','last_write_principal_id','last_written_at'];
    old_data := old_data - ARRAY['embedding_model','embedded_text_hash'] - ARRAY['write_request_id','write_principal_kind','write_principal_id','last_write_request_id','last_write_principal_kind','last_write_principal_id','last_written_at'];
    -- Embedding completion, retrieval telemetry and write attribution
    -- (attribution-schema.ts; a journal backfill fills it) are physical projections.
    IF (row_data - ARRAY['embedding','embedded_at','last_retrieved_at','retrieval_count','updated_at'])
      = (old_data - ARRAY['embedding','embedded_at','last_retrieved_at','retrieval_count','updated_at']) THEN RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME NOT IN ('tags','timeline_entries','takes') THEN
    target_source := row_data->>'source_id'; old_source := old_data->>'source_id';
  END IF;
  IF target_source IS NULL THEN SELECT source_id INTO target_source FROM pages WHERE id=(row_data->>'page_id')::integer; END IF;
  IF TG_OP='UPDATE' AND old_source IS NULL THEN
    SELECT source_id INTO old_source FROM pages WHERE id=(old_data->>'page_id')::integer;
  END IF;
  -- Cascaded projection removal after the already-guarded parent deletion.
  IF target_source IS NULL AND TG_OP='DELETE' THEN RETURN OLD; END IF;
  allowed := COALESCE(NULLIF(current_setting('gbrain.write_sources',true),''),'[]')::jsonb;
  IF target_source IS NULL OR NOT (allowed ? target_source) OR (old_source IS NOT NULL AND NOT (allowed ? old_source)) THEN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='writer_coordinator_required: canonical writer must use the persistence coordinator',
      TABLE=TG_TABLE_NAME, SCHEMA=TG_TABLE_SCHEMA, CONSTRAINT='managed_writer_guard:allowlist',
      DETAIL=jsonb_build_object('op',TG_OP,'relationship',CASE WHEN target_source IS NULL THEN 'missing_source'
        WHEN NOT (allowed ? target_source) THEN 'different_source' ELSE 'old_source_outside' END,
        'target_source',target_source,'old_source',old_source,'allowed',allowed)::text;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END \$fn\$;

DO \$body\$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['pages','tags','slug_aliases','page_aliases','facts','takes','timeline_entries','sources'] LOOP
    IF to_regclass(target) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS managed_writer_guard ON %I',target);
      EXECUTE format('CREATE TRIGGER managed_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION gbrain_require_managed_writer()',target);
    END IF;
  END LOOP;
END \$body\$;
;
-- Verified text projection work (migration 153).
DROP TRIGGER IF EXISTS trg_pages_search_vector ON pages;
CREATE TRIGGER trg_pages_search_vector BEFORE INSERT OR UPDATE OF title,timeline ON pages
    FOR EACH ROW EXECUTE FUNCTION update_page_search_vector();
CREATE TABLE IF NOT EXISTS page_projection_jobs (
    source_incarnation UUID NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    revision UUID NOT NULL,
    reason TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(source_incarnation,slug)
  );
CREATE OR REPLACE FUNCTION gbrain_queue_page_projection() RETURNS trigger LANGUAGE plpgsql AS \$fn\$
    DECLARE incarnation UUID;
    BEGIN
      IF TG_OP='DELETE' THEN
        DELETE FROM page_projection_jobs j USING sources s
          WHERE s.id=OLD.source_id AND j.source_incarnation=s.incarnation AND j.slug=OLD.slug;
        RETURN NULL;
      END IF;
      IF TG_OP='UPDATE' AND (OLD.source_id,OLD.slug) IS DISTINCT FROM (NEW.source_id,NEW.slug) THEN
        DELETE FROM page_projection_jobs j USING sources s
          WHERE s.id=OLD.source_id AND j.source_incarnation=s.incarnation AND j.slug=OLD.slug;
      END IF;
      SELECT s.incarnation INTO incarnation FROM sources s WHERE s.id=NEW.source_id;
      IF NEW.deleted_at IS NOT NULL OR NEW.text_projection_revision=NEW.knowledge_revision THEN
        DELETE FROM page_projection_jobs j WHERE j.source_incarnation=incarnation AND j.slug=NEW.slug;
      ELSIF TG_OP='INSERT' OR NEW.knowledge_revision IS DISTINCT FROM OLD.knowledge_revision THEN
        INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
          VALUES (incarnation,NEW.slug,NEW.knowledge_revision,'canonical_change')
          ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now();
      END IF;
      RETURN NULL;
    END \$fn\$;
DROP TRIGGER IF EXISTS pages_projection_queue ON pages;
CREATE TRIGGER pages_projection_queue AFTER INSERT OR UPDATE OR DELETE ON pages
    FOR EACH ROW EXECUTE FUNCTION gbrain_queue_page_projection();


CREATE TABLE IF NOT EXISTS persistence_topology_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL,
  request_id uuid NOT NULL,
  digest text NOT NULL,
  operation text NOT NULL,
  source_id text NOT NULL,
  source_incarnation uuid,
  worktree_ids uuid[] NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK(state IN ('recovering','committed','failed')),
  recovery jsonb,
  recovery_bytes bigint NOT NULL DEFAULT 0 CHECK(recovery_bytes>=0),
  intent_bytes bigint NOT NULL DEFAULT 0 CHECK(intent_bytes>=0),
  terminal_bytes bigint NOT NULL DEFAULT 2048 CHECK(terminal_bytes>=0),
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(principal_id,request_id)
);
ALTER TABLE persistence_topology_changes ADD COLUMN IF NOT EXISTS intent_bytes bigint NOT NULL DEFAULT 0 CHECK(intent_bytes>=0);
CREATE INDEX IF NOT EXISTS persistence_topology_recovering ON persistence_topology_changes(created_at) WHERE state='recovering';

CREATE TABLE IF NOT EXISTS persistence_worktree_refreshes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worktree_id uuid NOT NULL REFERENCES persistence_worktrees(id),
  source_ids text[] NOT NULL,
  principal_id uuid NOT NULL,
  owner_epoch bigint NOT NULL,
  topology_generation bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('draining','fenced','merged','syncing','completed','aborted','recovery_required')),
  old_head text NOT NULL,
  target_head text NOT NULL,
  upstream_ref text NOT NULL,
  preserved_uncommitted text[] NOT NULL DEFAULT '{}',
  outcome jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS persistence_worktree_refreshes_active
  ON persistence_worktree_refreshes(worktree_id)
  WHERE state IN ('draining','fenced','merged','syncing','recovery_required');

CREATE TABLE IF NOT EXISTS source_ingestion_receipts (
  id uuid PRIMARY KEY,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_incarnation uuid NOT NULL REFERENCES sources(incarnation) ON DELETE CASCADE,
  approved_revision text NOT NULL CHECK (approved_revision ~ '^([a-f0-9]{40}|[a-f0-9]{64})\$'),
  profile text NOT NULL CHECK (length(profile) BETWEEN 1 AND 128),
  schema_fingerprint text NOT NULL CHECK (schema_fingerprint ~ '^[a-f0-9]{64}\$'),
  extractor_version text NOT NULL CHECK (length(extractor_version) BETWEEN 1 AND 128),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  phase text NOT NULL DEFAULT 'ADMITTED' CHECK (phase IN ('ADMITTED','CONTENT','GRAPH','VERIFY','COMPLETE')),
  outcome text NOT NULL DEFAULT 'incomplete' CHECK (outcome IN ('incomplete','complete','discarded')),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object' AND octet_length(counts::text) <= 4096),
  lifecycle_request_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(lifecycle_request_ids) <= 128),
  checkpoint_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checkpoint_refs) = 'array' AND jsonb_array_length(checkpoint_refs) <= 32 AND octet_length(checkpoint_refs::text) <= 16384),
  diagnostic text CHECK (diagnostic IN ('interrupted','content_incomplete','graph_incomplete','verification_failed','pending_writes','source_changed','checkpoint_missing','operation_failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  discarded_at timestamptz,
  CHECK ((phase = 'COMPLETE') = (outcome = 'complete')),
  CHECK ((completed_at IS NOT NULL) = (outcome = 'complete')),
  CHECK ((discarded_at IS NOT NULL) = (outcome = 'discarded'))
);
ALTER TABLE source_ingestion_receipts ADD COLUMN IF NOT EXISTS policy_fingerprint text
  CHECK (policy_fingerprint ~ '^[a-f0-9]{64}\$');
CREATE INDEX IF NOT EXISTS source_ingestion_receipts_source
  ON source_ingestion_receipts(source_id, source_incarnation, created_at DESC);
CREATE INDEX IF NOT EXISTS source_ingestion_receipts_retention
  ON source_ingestion_receipts(source_id, source_incarnation, completed_at DESC, id DESC) WHERE outcome = 'complete';
CREATE INDEX IF NOT EXISTS source_ingestion_receipts_active
  ON source_ingestion_receipts(id) WHERE outcome = 'incomplete';

CREATE TABLE IF NOT EXISTS shared_skill_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    token_secret TEXT NOT NULL DEFAULT (replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
    serving_epoch UUID NOT NULL DEFAULT gen_random_uuid()
  );
INSERT INTO shared_skill_state(singleton) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS shared_skill_policies (
    source_id TEXT NOT NULL, source_incarnation UUID NOT NULL,
    epoch UUID NOT NULL DEFAULT gen_random_uuid(), policy JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(source_id,source_incarnation)
  );
CREATE TABLE IF NOT EXISTS shared_skill_packs (
    source_id TEXT NOT NULL, source_incarnation UUID NOT NULL, pack_id TEXT NOT NULL,
    revision UUID NOT NULL, manifest JSONB NOT NULL, manifest_hash TEXT NOT NULL,
    PRIMARY KEY(source_id,source_incarnation),
    UNIQUE(source_id,source_incarnation,pack_id)
  );
CREATE TABLE IF NOT EXISTS shared_skill_policy_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), source_id TEXT NOT NULL, source_incarnation UUID NOT NULL,
    principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL, previous_epoch TEXT NOT NULL,
    epoch UUID NOT NULL, policy JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
CREATE INDEX IF NOT EXISTS shared_skill_policy_audit_source_idx ON shared_skill_policy_audit(source_id,source_incarnation,created_at);
CREATE TABLE IF NOT EXISTS shared_skill_heads (
    source_id TEXT NOT NULL, source_incarnation UUID NOT NULL, pack_id TEXT NOT NULL, name TEXT NOT NULL,
    revision UUID NOT NULL, metadata JSONB NOT NULL, deleted BOOLEAN NOT NULL DEFAULT false,
    policy_epoch TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(source_id,source_incarnation,pack_id,name)
  );
CREATE TABLE IF NOT EXISTS shared_skill_revisions (
    source_id TEXT NOT NULL, source_incarnation UUID NOT NULL, pack_id TEXT NOT NULL, name TEXT NOT NULL,
    revision UUID NOT NULL, metadata JSONB NOT NULL, files JSONB NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT false, policy_epoch TEXT NOT NULL,
    request_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    stored_bytes BIGINT GENERATED ALWAYS AS (octet_length(files::text)+octet_length(metadata::text)) STORED,
    PRIMARY KEY(source_id,source_incarnation,pack_id,name,revision)
  );
CREATE INDEX IF NOT EXISTS shared_skill_revision_request_idx ON shared_skill_revisions(request_id);
CREATE INDEX IF NOT EXISTS shared_skill_heads_active_idx ON shared_skill_heads(source_id,source_incarnation,pack_id,name) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS shared_skill_revision_retention_idx ON shared_skill_revisions(source_id,source_incarnation,name,created_at DESC);
CREATE INDEX IF NOT EXISTS shared_skill_revision_uuid_idx ON shared_skill_revisions(revision);
CREATE TABLE IF NOT EXISTS shared_skill_revision_leases (
    lease_kind TEXT NOT NULL CHECK(lease_kind IN ('delivery','pin')), lease_id UUID NOT NULL,
    source_id TEXT NOT NULL, source_incarnation UUID NOT NULL, pack_id TEXT NOT NULL, name TEXT NOT NULL, revision UUID NOT NULL,
    principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(lease_kind,lease_id,source_id,source_incarnation,pack_id,name,revision),
    FOREIGN KEY(source_id,source_incarnation,pack_id,name,revision)
      REFERENCES shared_skill_revisions(source_id,source_incarnation,pack_id,name,revision) ON DELETE RESTRICT
  );
CREATE INDEX IF NOT EXISTS shared_skill_revision_lease_expiry_idx ON shared_skill_revision_leases(source_id,source_incarnation,expires_at);
CREATE INDEX IF NOT EXISTS shared_skill_revision_lease_target_idx ON shared_skill_revision_leases(source_id,source_incarnation,pack_id,name,revision,expires_at);
CREATE TABLE IF NOT EXISTS shared_skill_members (
    installation_id UUID PRIMARY KEY,
    principal_kind TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    adapter TEXT NOT NULL,
    brain_id UUID NOT NULL,
    epoch BIGINT NOT NULL DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT true,
    follow_policy JSONB NOT NULL,
    issued_sequence BIGINT NOT NULL DEFAULT 0,
    acknowledged_sequence BIGINT NOT NULL DEFAULT 0,
    desired_view TEXT,
    acknowledged_view TEXT,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    join_window TIMESTAMPTZ NOT NULL DEFAULT now(),
    join_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(principal_kind, principal_id, adapter)
  );
CREATE TABLE IF NOT EXISTS shared_skill_delivery_batches (
    token UUID PRIMARY KEY,
    installation_id UUID NOT NULL REFERENCES shared_skill_members(installation_id) ON DELETE CASCADE,
    epoch BIGINT NOT NULL,
    sequence BIGINT NOT NULL,
    view_token TEXT NOT NULL,
    authority_digest TEXT NOT NULL,
    revisions JSONB NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acknowledged_at TIMESTAMPTZ,
    evidence JSONB,
    UNIQUE(installation_id, epoch, sequence)
  );
CREATE INDEX IF NOT EXISTS shared_skill_delivery_member_idx ON shared_skill_delivery_batches(installation_id, epoch, issued_at);
ALTER TABLE persistence_brain ADD COLUMN IF NOT EXISTS writer_protocol_floor integer NOT NULL DEFAULT 1 CHECK (writer_protocol_floor IN (1,2));
ALTER TABLE persistence_brain ADD COLUMN IF NOT EXISTS skill_bundles_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS target_kind text NOT NULL DEFAULT 'page' CHECK (target_kind IN ('page','skill_bundle'));
ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS protocol_version integer NOT NULL DEFAULT 1 CHECK (protocol_version IN (1,2));
CREATE TABLE IF NOT EXISTS persistence_writer_protocols (
    worktree_id uuid NOT NULL REFERENCES persistence_worktrees(id),
    host_id uuid NOT NULL,
    owner_epoch bigint NOT NULL,
    protocol_version integer NOT NULL CHECK (protocol_version=2),
    registered_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(worktree_id,host_id)
  );
CREATE OR REPLACE FUNCTION gbrain_require_persistence_protocol(required integer) RETURNS void LANGUAGE plpgsql AS \$\$
  BEGIN
    IF required >= 2 AND COALESCE(current_setting('gbrain.persistence_protocol',true),'') <> '2' THEN
      RAISE EXCEPTION 'writer_upgrade_required: this mutation requires persistence protocol 2' USING ERRCODE='42501';
    END IF;
  END \$\$;
CREATE OR REPLACE FUNCTION gbrain_guard_request_protocol() RETURNS trigger LANGUAGE plpgsql AS \$\$
  DECLARE target text; version integer; floor integer; active boolean; record jsonb;
  BEGIN
    IF TG_OP='DELETE' THEN target:=OLD.target_kind; version:=OLD.protocol_version;
    ELSE target:=NEW.target_kind; version:=NEW.protocol_version; END IF;
    SELECT writer_protocol_floor,skill_bundles_enabled INTO floor,active FROM persistence_brain WHERE singleton=1 FOR SHARE;
    PERFORM gbrain_require_persistence_protocol(GREATEST(floor,version,CASE WHEN target='skill_bundle' THEN 2 ELSE 1 END));
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    IF TG_OP='UPDATE' AND (NEW.target_kind<>OLD.target_kind OR NEW.protocol_version<>OLD.protocol_version) THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: a request target is immutable' USING ERRCODE='42501';
    END IF;
    IF NEW.operation IN ('put_skill','delete_skill','adopt_skillpack') AND target<>'skill_bundle' THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: skill operations require a typed target' USING ERRCODE='42501';
    END IF;
    IF target='skill_bundle' THEN
      IF version<>2 OR NEW.page_id IS NOT NULL OR NEW.worktree_id IS NULL THEN
        RAISE EXCEPTION 'unsupported_mutation_protocol: invalid skill target' USING ERRCODE='42501';
      END IF;
      IF TG_OP='INSERT' AND NOT active THEN
        RAISE EXCEPTION 'writer_not_quiesced: shared publication is disabled' USING ERRCODE='42501';
      END IF;
      IF (TG_OP='INSERT' OR (NEW.state='running' AND OLD.state IS DISTINCT FROM 'running')) AND NOT EXISTS (SELECT 1 FROM persistence_worktrees w JOIN persistence_writer_protocols p
        ON p.worktree_id=w.id AND p.host_id=w.owner_host_id AND p.owner_epoch=w.owner_epoch AND p.protocol_version=2
        WHERE w.id=NEW.worktree_id AND w.state='active') THEN
        RAISE EXCEPTION 'writer_not_quiesced: canonical owner capability must be revalidated' USING ERRCODE='42501';
      END IF;
    ELSIF version<>1 THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: invalid page target' USING ERRCODE='42501';
    END IF;
    record:=NEW.recovery;
    IF record IS NOT NULL AND ((target='page' AND record->>'version' IS DISTINCT FROM '1')
      OR (target='skill_bundle' AND (record->>'version' IS DISTINCT FROM '2' OR record->>'target' IS DISTINCT FROM 'skill_bundle'
        OR jsonb_typeof(record->'files') IS DISTINCT FROM 'array'))) THEN
      RAISE EXCEPTION 'unsupported_mutation_protocol: recovery target mismatch' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END \$\$;
DROP TRIGGER IF EXISTS gbrain_request_protocol ON persistence_requests;
CREATE TRIGGER gbrain_request_protocol BEFORE INSERT OR UPDATE OR DELETE ON persistence_requests
    FOR EACH ROW EXECUTE FUNCTION gbrain_guard_request_protocol();
CREATE OR REPLACE FUNCTION gbrain_guard_effect_protocol() RETURNS trigger LANGUAGE plpgsql AS \$\$
  DECLARE floor integer;
  BEGIN
    SELECT writer_protocol_floor INTO floor FROM persistence_brain WHERE singleton=1 FOR SHARE;
    PERFORM gbrain_require_persistence_protocol(floor);
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END \$\$;
DROP TRIGGER IF EXISTS gbrain_effect_protocol ON persistence_effects;
CREATE TRIGGER gbrain_effect_protocol BEFORE INSERT OR UPDATE OR DELETE ON persistence_effects
    FOR EACH ROW EXECUTE FUNCTION gbrain_guard_effect_protocol();
CREATE OR REPLACE FUNCTION gbrain_guard_protocol_activation() RETURNS trigger LANGUAGE plpgsql AS \$\$
  BEGIN
    IF NEW.writer_protocol_floor<OLD.writer_protocol_floor THEN
      RAISE EXCEPTION 'writer_upgrade_required: the protocol floor cannot be lowered' USING ERRCODE='42501';
    END IF;
    IF NEW.writer_protocol_floor>OLD.writer_protocol_floor OR (NEW.skill_bundles_enabled AND NOT OLD.skill_bundles_enabled) THEN
      PERFORM gbrain_require_persistence_protocol(2);
      IF COALESCE(current_setting('gbrain.writer_quiesced',true),'')<>'true' OR NOT NEW.enabled OR NEW.writer_protocol_floor<>2
        OR EXISTS (SELECT 1 FROM persistence_requests WHERE state IN ('queued','running','recovering') OR recovery IS NOT NULL)
        OR EXISTS (SELECT 1 FROM persistence_effects WHERE state='running' OR recovery IS NOT NULL)
        OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE EXISTS
          (SELECT 1 FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation
            WHERE b.worktree_id=w.id AND NOT s.archived) AND (w.state<>'active' OR NOT EXISTS
          (SELECT 1 FROM persistence_writer_protocols p WHERE p.worktree_id=w.id AND p.host_id=w.owner_host_id
            AND p.owner_epoch=w.owner_epoch AND p.protocol_version=2))) THEN
        RAISE EXCEPTION 'writer_not_quiesced: drain and verify all canonical owners before activation' USING ERRCODE='42501';
      END IF;
    END IF;
    RETURN NEW;
  END \$\$;
DROP TRIGGER IF EXISTS gbrain_protocol_activation ON persistence_brain;
CREATE TRIGGER gbrain_protocol_activation BEFORE UPDATE ON persistence_brain
    FOR EACH ROW EXECUTE FUNCTION gbrain_guard_protocol_activation();
CREATE OR REPLACE FUNCTION gbrain_guard_skill_publication() RETURNS trigger LANGUAGE plpgsql AS \$\$
  DECLARE permitted jsonb;
  BEGIN
    PERFORM gbrain_require_persistence_protocol(2);
    IF NOT EXISTS (SELECT 1 FROM persistence_brain WHERE singleton=1 AND enabled AND skill_bundles_enabled AND writer_protocol_floor=2) THEN
      RAISE EXCEPTION 'writer_not_quiesced: shared publication is disabled' USING ERRCODE='42501';
    END IF;
    BEGIN permitted:=COALESCE(NULLIF(current_setting('gbrain.write_sources',true),''),'[]')::jsonb;
    EXCEPTION WHEN OTHERS THEN permitted:='[]'::jsonb; END;
    IF jsonb_typeof(permitted)<>'array'
      OR (TG_OP<>'INSERT' AND NOT permitted @> jsonb_build_array(OLD.source_id))
      OR (TG_OP<>'DELETE' AND NOT permitted @> jsonb_build_array(NEW.source_id)) THEN
      RAISE EXCEPTION 'writer_coordinator_required: canonical skill writes require a coordinated source capability' USING ERRCODE='42501';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END \$\$;
DROP TRIGGER IF EXISTS gbrain_skill_publication ON shared_skill_packs;
CREATE TRIGGER gbrain_skill_publication BEFORE INSERT OR UPDATE OR DELETE ON shared_skill_packs
      FOR EACH ROW EXECUTE FUNCTION gbrain_guard_skill_publication();
DROP TRIGGER IF EXISTS gbrain_skill_publication ON shared_skill_heads;
CREATE TRIGGER gbrain_skill_publication BEFORE INSERT OR UPDATE OR DELETE ON shared_skill_heads
      FOR EACH ROW EXECUTE FUNCTION gbrain_guard_skill_publication();
DROP TRIGGER IF EXISTS gbrain_skill_publication ON shared_skill_revisions;
CREATE TRIGGER gbrain_skill_publication BEFORE INSERT OR UPDATE OR DELETE ON shared_skill_revisions
      FOR EACH ROW EXECUTE FUNCTION gbrain_guard_skill_publication();
CREATE OR REPLACE FUNCTION gbrain_lease_shared_skill_delivery() RETURNS trigger LANGUAGE plpgsql AS \$\$
  DECLARE item text; found_revision shared_skill_revisions%ROWTYPE; brain text;
  BEGIN
    SELECT brain_id::text INTO brain FROM persistence_brain WHERE singleton=1;
    FOR item IN SELECT value FROM jsonb_array_elements_text(NEW.revisions) ORDER BY value LOOP
      SELECT r.* INTO found_revision FROM shared_skill_revisions r
        WHERE r.revision::text=substring(item from '@([^@]+)\$')
          AND item=brain || '/' || r.source_id || '/' || r.source_incarnation::text || '/' || r.pack_id || '/' || r.name || '@' || r.revision::text
        FOR KEY SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'revision_unavailable: delivery revision is no longer retained' USING ERRCODE='23503'; END IF;
      INSERT INTO shared_skill_revision_leases(lease_kind,lease_id,source_id,source_incarnation,pack_id,name,revision,principal_kind,principal_id,expires_at)
        VALUES('delivery',found_revision.revision,found_revision.source_id,found_revision.source_incarnation,found_revision.pack_id,found_revision.name,found_revision.revision,
          'application','delivery',LEAST(NEW.issued_at+interval '24 hours',now()+interval '24 hours'))
        ON CONFLICT(lease_kind,lease_id,source_id,source_incarnation,pack_id,name,revision)
          DO UPDATE SET expires_at=GREATEST(shared_skill_revision_leases.expires_at,excluded.expires_at);
    END LOOP;
    RETURN NEW;
  END \$\$;
DROP TRIGGER IF EXISTS shared_skill_delivery_lease ON shared_skill_delivery_batches;
CREATE TRIGGER shared_skill_delivery_lease AFTER INSERT OR UPDATE OF revisions ON shared_skill_delivery_batches
    FOR EACH ROW EXECUTE FUNCTION gbrain_lease_shared_skill_delivery();
DO \$\$
DECLARE has_bypass boolean; target text;
BEGIN
  SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'USAGE')
    AND (r.rolbypassrls OR r.rolsuper)) INTO has_bypass;
  IF has_bypass THEN
    FOREACH target IN ARRAY ARRAY['shared_skill_state','shared_skill_policies','shared_skill_packs',
      'shared_skill_policy_audit','shared_skill_heads','shared_skill_revisions','shared_skill_revision_leases',
      'shared_skill_members','shared_skill_delivery_batches','persistence_writer_protocols'] LOOP
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',target);
    END LOOP;
  END IF;
END \$\$;

-- System One decide storage (decision receipts, spend ledger, calibrations, proposals).
CREATE TABLE IF NOT EXISTS decision_receipts (
  id                 BIGSERIAL PRIMARY KEY,
  decision_id        TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id          TEXT,
  slot               TEXT NOT NULL,
  mode               TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model_alias        TEXT,
  model_resolved     TEXT,
  question_kind      TEXT,
  state_hash         TEXT,
  question_hash      TEXT,
  answer_value       REAL,
  answer_choice      TEXT,
  confidence         REAL,
  threshold          REAL,
  outcome            TEXT NOT NULL,
  subject_ref        TEXT,
  call_site          TEXT NOT NULL,
  lane               TEXT NOT NULL,
  policy_fingerprint TEXT,
  calibration_ref    TEXT,
  latency_ms         INTEGER,
  input_tokens       INTEGER,
  error_reason       TEXT,
  protected          BOOLEAN NOT NULL DEFAULT false,
  min_keep           INTEGER,
  rank               INTEGER,
  k_used             INTEGER,
  remote             BOOLEAN NOT NULL DEFAULT false,
  run_meta           TEXT
);
CREATE INDEX IF NOT EXISTS decision_receipts_slot_created_idx ON decision_receipts (slot, created_at);
CREATE INDEX IF NOT EXISTS decision_receipts_model_slot_idx ON decision_receipts (model_resolved, slot);
CREATE INDEX IF NOT EXISTS decision_receipts_decision_idx ON decision_receipts (decision_id);
CREATE TABLE IF NOT EXISTS decide_spend (
  request_id     TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id      TEXT,
  slot           TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model_resolved TEXT,
  lane           TEXT NOT NULL,
  remote         BOOLEAN NOT NULL DEFAULT false,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
  outcome        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decide_spend_created_idx ON decide_spend (created_at);
CREATE TABLE IF NOT EXISTS decide_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO \$rls\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE decision_receipts ENABLE ROW LEVEL SECURITY;
  END IF;
END \$rls\$;
DO \$rls\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE decide_spend ENABLE ROW LEVEL SECURITY;
  END IF;
END \$rls\$;
DO \$rls\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE decide_state ENABLE ROW LEVEL SECURITY;
  END IF;
END \$rls\$;

CREATE TABLE IF NOT EXISTS decide_calibrations (
  id                  BIGSERIAL PRIMARY KEY,
  slot                TEXT NOT NULL,
  call_site           TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model_resolved      TEXT NOT NULL,
  threshold           REAL NOT NULL,
  min_keep            INTEGER,
  metric              TEXT NOT NULL,
  metric_value        REAL,
  ece                 REAL,
  retest_sd           REAL,
  repack_sd           REAL,
  action_precision_lb REAL,
  qualification       TEXT,
  qualified_at        TIMESTAMPTZ,
  policy_fingerprint  TEXT,
  n                   INTEGER NOT NULL,
  dataset_hash        TEXT,
  split_hash          TEXT,
  calibrate_ids_hash  TEXT,
  calibrate_only      BOOLEAN NOT NULL DEFAULT true,
  pack_shape          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at          TIMESTAMPTZ,
  notes               TEXT
);
CREATE INDEX IF NOT EXISTS decide_calibrations_lookup_idx ON decide_calibrations (slot, provider, model_resolved, created_at DESC);
DO \$rls\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE decide_calibrations ENABLE ROW LEVEL SECURITY;
  END IF;
END \$rls\$;

CREATE TABLE IF NOT EXISTS decide_proposals (
  id             BIGSERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id      TEXT NOT NULL,
  sweep_id       TEXT NOT NULL,
  pair_index     INTEGER NOT NULL,
  new_fact_id    BIGINT NOT NULL,
  old_fact_id    BIGINT NOT NULL,
  direction      TEXT NOT NULL DEFAULT 'new_supersedes_old',
  p_supersede    REAL NOT NULL,
  threshold      REAL,
  proposal_floor REAL NOT NULL,
  model_resolved TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  decided_at     TIMESTAMPTZ,
  before_state   TEXT,
  after_state    TEXT,
  UNIQUE (sweep_id, pair_index)
);
CREATE INDEX IF NOT EXISTS decide_proposals_status_created_idx ON decide_proposals (status, created_at);
CREATE TABLE IF NOT EXISTS decide_sweep_deferred (
  source_id       TEXT NOT NULL,
  fact_id         BIGINT NOT NULL,
  slot            TEXT NOT NULL,
  reason          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slot, source_id, fact_id)
);
DO \$rls\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE decide_proposals ENABLE ROW LEVEL SECURITY;
  END IF;
END \$rls\$;
DO \$rls\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE decide_sweep_deferred ENABLE ROW LEVEL SECURITY;
  END IF;
END \$rls\$;

-- gbrain facts relink attempts and journal (#5836).
CREATE TABLE IF NOT EXISTS fact_relink_attempts (
  source_id       TEXT NOT NULL,
  fact_id         BIGINT NOT NULL,
  outcome         TEXT NOT NULL,
  reason          TEXT,
  tier            TEXT,
  model           TEXT,
  target_slug     TEXT,
  run_id          TEXT,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, fact_id)
);
CREATE INDEX IF NOT EXISTS fact_relink_attempts_outcome_idx ON fact_relink_attempts (source_id, outcome, attempted_at);
DO \$rls\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE fact_relink_attempts ENABLE ROW LEVEL SECURITY;
  END IF;
END \$rls\$;

-- Temporal typed edges: dated evidence, derived relationship state, proposals.
CREATE TABLE IF NOT EXISTS link_transitions (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  from_page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id      INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('start','end')),
  occurred_on     DATE NOT NULL,
  date_precision  TEXT NOT NULL DEFAULT 'day' CHECK (date_precision IN ('day','month','year')),
  producer        TEXT NOT NULL CHECK (producer IN ('timeline','explicit','frontmatter','manual','inline','dream')),
  origin_page_id  INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  line_hash       TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS link_transitions_identity_idx
  ON link_transitions (origin_page_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS link_transitions_relationship_idx ON link_transitions (from_page_id, to_page_id, link_type);
CREATE INDEX IF NOT EXISTS link_transitions_origin_idx ON link_transitions (origin_page_id);
DO \$rls\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE link_transitions ENABLE ROW LEVEL SECURITY;
  END IF;
END \$rls\$;
CREATE TABLE IF NOT EXISTS link_relationships (
  from_page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id      INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type       TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('all','world')),
  source_id       TEXT NOT NULL,
  semantics       TEXT NOT NULL CHECK (semantics IN ('state','event')),
  valid_ranges    DATEMULTIRANGE NOT NULL,
  status_now      TEXT NOT NULL CHECK (status_now IN ('live','ended','ended_unknown_date','not_started','disputed','event')),
  first_start     DATE,
  last_start      DATE,
  last_end        DATE,
  undated_present INTEGER NOT NULL DEFAULT 0,
  undated_past    INTEGER NOT NULL DEFAULT 0,
  disputed        BOOLEAN NOT NULL DEFAULT false,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at      TIMESTAMPTZ,
  evidence_hash   TEXT NOT NULL,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_page_id, to_page_id, link_type, scope)
);
CREATE INDEX IF NOT EXISTS link_relationships_to_idx ON link_relationships (to_page_id, link_type, scope);
CREATE INDEX IF NOT EXISTS link_relationships_source_idx ON link_relationships (source_id, status_now);
DO \$rls\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE link_relationships ENABLE ROW LEVEL SECURITY;
  END IF;
END \$rls\$;
CREATE TABLE IF NOT EXISTS link_edge_proposals (
  id                 BIGSERIAL PRIMARY KEY,
  source_id          TEXT NOT NULL,
  from_page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  a_to_page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  b_to_page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type          TEXT NOT NULL,
  evidence_hash      TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('proposed','applied','rejected','undone','stale','reverted_by_user','undated_unresolved','ambiguous_same_date','compatible','error')),
  ending_to_page_id  INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  close_date         DATE,
  born_closed        BOOLEAN NOT NULL DEFAULT false,
  model              TEXT,
  confidence         REAL,
  cost_usd           REAL,
  generated_line     TEXT,
  detail             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash)
);
CREATE INDEX IF NOT EXISTS link_edge_proposals_status_idx ON link_edge_proposals (source_id, status, created_at);
DO \$rls\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE link_edge_proposals ENABLE ROW LEVEL SECURITY;
  END IF;
END \$rls\$;
CREATE SEQUENCE IF NOT EXISTS graph_generation_seq;



`;

export function getPGLiteSchema(
  dims: number = DEFAULT_EMBEDDING_DIMENSIONS,
  model: string = DEFAULT_EMBEDDING_MODEL,
): string {
  const parsedDims = Number(dims);
  if (!Number.isInteger(parsedDims) || parsedDims <= 0) {
    throw new Error(`Invalid embedding dimensions: ${dims}`);
  }
  const sanitizedModel = String(model).replace(/'/g, "''");
  return applyFtsLanguagePolicy(applyChunkEmbeddingIndexPolicy(PGLITE_SCHEMA_SQL_TEMPLATE, parsedDims))
    .replace(/__EMBEDDING_DIMS__/g, String(parsedDims))
    .replace(/__EMBEDDING_MODEL__/g, sanitizedModel);
}

/** Back-compat: pre-computed default-1536 schema for existing callers. */
export const PGLITE_SCHEMA_SQL = getPGLiteSchema();
