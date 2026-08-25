// Forward-reference bootstrap for the RAW Postgres schema-replay path.
//
// Extracted from `PostgresEngine#applyForwardReferenceBootstrap` (#4477) so
// BOTH SCHEMA_SQL replay entrypoints run it before the blob:
//   - `PostgresEngine.initSchema()` (src/core/postgres-engine.ts) — delegates
//     here from its private method, same call shape as before.
//   - `db.initSchema()` (src/core/db.ts) — the standalone module-singleton
//     path (used by test/e2e/helpers.ts and legacy callers) previously
//     replayed SCHEMA_SQL with NO bootstrap, so an older brain whose tables
//     predate the blob's forward-referenced columns wedged on CREATE INDEX.
//
// Bootstrap state that SCHEMA_SQL forward-references but that older brains
// don't have yet. Mirror of `PGLiteEngine#applyForwardReferenceBootstrap`
// in shape and intent. Keep in sync with the PGLite version; covered by
// `test/schema-bootstrap-coverage.test.ts` (PGLite side) and
// `test/e2e/postgres-bootstrap.test.ts` (Postgres side).

import type postgres from 'postgres';

/**
 * Probe + patch every forward-reference target the embedded schema blob
 * needs, on the caller-provided connection. Callers MUST hold the
 * initSchema advisory lock (key 42) on `conn` so concurrent bootstraps
 * can't race on Supabase's transaction pooler.
 *
 * Idempotent on fresh installs and modern brains (single probe round-trip,
 * fast no-op when nothing is missing).
 */
export async function applyPostgresForwardReferenceBootstrap(
  conn: ReturnType<typeof postgres>,
): Promise<void> {

// Single round-trip probe for every forward-reference target.
// current_schema() resolves to whatever search_path the connection uses,
// which matches schema-embedded.ts's `public.` references.
const probeRows = await conn<{
  pages_exists: boolean;
  source_id_exists: boolean;
  deleted_at_exists: boolean;
  effective_date_exists: boolean;
  links_exists: boolean;
  link_source_exists: boolean;
  origin_page_id_exists: boolean;
  chunks_exists: boolean;
  symbol_name_exists: boolean;
  language_exists: boolean;
  search_vector_exists: boolean;
  embedding_image_exists: boolean;
  mcp_log_exists: boolean;
  agent_name_exists: boolean;
  subagent_messages_exists: boolean;
  subagent_provider_id_exists: boolean;
  ingest_log_exists: boolean;
  ingest_log_source_id_exists: boolean;
  files_exists: boolean;
  files_source_id_exists: boolean;
  files_page_id_exists: boolean;
  oauth_clients_exists: boolean;
  oauth_clients_source_id_exists: boolean;
  oauth_clients_federated_read_exists: boolean;
  oauth_clients_surface_exists: boolean;
  oauth_clients_surface_set_by_exists: boolean;
  sources_exists: boolean;
  sources_archived_exists: boolean;
  sources_archived_at_exists: boolean;
  sources_archive_expires_at_exists: boolean;
}[]>`
  SELECT
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'pages') AS pages_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'source_id') AS source_id_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'deleted_at') AS deleted_at_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'effective_date') AS effective_date_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'links') AS links_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'links' AND column_name = 'link_source') AS link_source_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'links' AND column_name = 'origin_page_id') AS origin_page_id_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'content_chunks') AS chunks_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'content_chunks' AND column_name = 'symbol_name') AS symbol_name_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'content_chunks' AND column_name = 'language') AS language_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'content_chunks' AND column_name = 'search_vector') AS search_vector_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'content_chunks' AND column_name = 'embedding_image') AS embedding_image_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'mcp_request_log') AS mcp_log_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'mcp_request_log' AND column_name = 'agent_name') AS agent_name_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'subagent_messages') AS subagent_messages_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'subagent_messages' AND column_name = 'provider_id') AS subagent_provider_id_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'ingest_log') AS ingest_log_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'ingest_log' AND column_name = 'source_id') AS ingest_log_source_id_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'files') AS files_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'files' AND column_name = 'source_id') AS files_source_id_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'files' AND column_name = 'page_id') AS files_page_id_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'oauth_clients') AS oauth_clients_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'oauth_clients' AND column_name = 'source_id') AS oauth_clients_source_id_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'oauth_clients' AND column_name = 'federated_read') AS oauth_clients_federated_read_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'oauth_clients' AND column_name = 'surface') AS oauth_clients_surface_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'oauth_clients' AND column_name = 'surface_set_by') AS oauth_clients_surface_set_by_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'sources') AS sources_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'sources' AND column_name = 'archived') AS sources_archived_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'sources' AND column_name = 'archived_at') AS sources_archived_at_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'sources' AND column_name = 'archive_expires_at') AS sources_archive_expires_at_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'last_retrieved_at') AS pages_last_retrieved_at_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'ingested_via') AS pages_ingested_via_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'ingested_at') AS pages_ingested_at_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'source_uri') AS pages_source_uri_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'source_kind') AS pages_source_kind_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'contextual_retrieval_mode') AS pages_cr_mode_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'corpus_generation') AS pages_corpus_generation_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'sources' AND column_name = 'contextual_retrieval_mode') AS sources_cr_mode_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'sources' AND column_name = 'trust_frontmatter_overrides') AS sources_trust_fm_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'generation') AS pages_generation_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'embedding_signature') AS pages_embedding_signature_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'links_extracted_at') AS pages_links_extracted_at_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'timeline_entries') AS timeline_entries_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'timeline_entries' AND column_name = 'event_page_id') AS timeline_event_page_id_exists,
    EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'minion_jobs') AS minion_jobs_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'minion_jobs' AND column_name = 'timeout_at') AS minion_jobs_timeout_at_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'minion_jobs' AND column_name = 'idempotency_key') AS minion_jobs_idempotency_key_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'minion_jobs' AND column_name = 'private_queue_owner_job_id') AS minion_jobs_pq_owner_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'minion_jobs' AND column_name = 'private_queue_owner_token') AS minion_jobs_pq_token_exists,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'minion_jobs' AND column_name = 'private_queue_lease_until') AS minion_jobs_pq_lease_exists
`;
const probe = probeRows[0]!;

const needsPagesBootstrap = probe.pages_exists && !probe.source_id_exists;
const needsLinksBootstrap = probe.links_exists
  && (!probe.link_source_exists || !probe.origin_page_id_exists);
const needsChunksBootstrap = probe.chunks_exists
  && (!probe.symbol_name_exists || !probe.language_exists || !probe.search_vector_exists);
// v0.26.5: pages_deleted_at_purge_idx in SCHEMA_SQL crashes if the column
// doesn't exist yet. Migration v34 also adds it, but bootstrap runs first.
const needsPagesDeletedAt = probe.pages_exists && !probe.deleted_at_exists;
// v0.26.3 (v33): idx_mcp_log_agent_time in SCHEMA_SQL needs agent_name col.
const needsMcpLogBootstrap = probe.mcp_log_exists && !probe.agent_name_exists;
// v0.27 (v36): idx_subagent_messages_provider in SCHEMA_SQL needs provider_id
// (the SECOND column in the composite index `(job_id, provider_id)`).
const needsSubagentProviderId = probe.subagent_messages_exists && !probe.subagent_provider_id_exists;
// v0.27.1 (v39): idx_chunks_embedding_image partial HNSW in SCHEMA_SQL
// references embedding_image. Use embedding_image_exists as the proxy for
// both v39 columns; modality is added in the same migration.
const needsChunksEmbeddingImage = probe.chunks_exists && !probe.embedding_image_exists;
// v0.29.1 (v40 + v41): pages_coalesce_date_idx expression index in SCHEMA_SQL
// references effective_date. Use effective_date_exists as the proxy for the
// five v40 + v41 pages columns (emotional_weight, effective_date,
// effective_date_source, import_filename, salience_touched_at).
const needsPagesRecency = probe.pages_exists && !probe.effective_date_exists;
// v0.31.2 (v50): idx_ingest_log_source_type_created in SCHEMA_SQL references
// source_id. Old brains have ingest_log without source_id; bootstrap adds
// the column before SCHEMA_SQL replay creates the index.
const needsIngestLogSourceId = probe.ingest_log_exists && !probe.ingest_log_source_id_exists;
// v0.18 (v18): files.source_id + files.page_id added; idx_files_source_id
// and idx_files_page_id in SCHEMA_SQL crash without them.
const needsFilesBootstrap = probe.files_exists
  && (!probe.files_source_id_exists || !probe.files_page_id_exists);
// v0.34.1 (v60+v61+v65): oauth_clients.source_id + federated_read added;
// FK to sources(id) + GIN index idx_oauth_clients_federated_read in
// SCHEMA_SQL crash without them.
const needsOauthClientsBootstrap = probe.oauth_clients_exists
  && (!probe.oauth_clients_source_id_exists || !probe.oauth_clients_federated_read_exists);
// WP4 (v127): oauth_clients.surface + surface_set_by. No SCHEMA_SQL index
// references them, but the columns are migration-added AND in the blob's
// CREATE TABLE — the exact v121 mask class — so the bootstrap adds them
// defense-in-depth (and satisfies the MIGRATIONS ADD COLUMN coverage
// gate). They ship in one migration and go missing together.
const probeSurface = probe as {
  oauth_clients_surface_exists?: boolean;
  oauth_clients_surface_set_by_exists?: boolean;
};
const needsOauthClientsSurface = probe.oauth_clients_exists
  && (!probeSurface.oauth_clients_surface_exists || !probeSurface.oauth_clients_surface_set_by_exists);
// v0.26.5 (v34): sources.archived + archived_at + archive_expires_at added
// for soft-delete lifecycle. SCHEMA_SQL's `CREATE TABLE IF NOT EXISTS sources`
// is a no-op on pre-existing sources tables (won't add columns), so the
// visibility filters in search/list_pages trip on old brains. Bootstrap
// closes the gap before any visibility-filter SQL runs.
const needsSourcesArchive = probe.sources_exists
  && (!probe.sources_archived_exists
      || !probe.sources_archived_at_exists
      || !probe.sources_archive_expires_at_exists);
// v0.37.0 (v79): pages_last_retrieved_at_idx in SCHEMA_SQL references
// last_retrieved_at. Pre-v79 brains crash without the column; bootstrap
// adds it before SCHEMA_SQL replay creates the index. v79 runs later
// via runMigrations and is idempotent.
const needsPagesLastRetrievedAt = probe.pages_exists && !(probe as { pages_last_retrieved_at_exists?: boolean }).pages_last_retrieved_at_exists;
// v0.38.0 (v80): provenance columns. Not referenced by any SCHEMA_SQL
// index/FK today; bootstrap exists for the column-only forward-
// reference class defense-in-depth.
const probeProv = probe as {
  pages_ingested_via_exists?: boolean;
  pages_ingested_at_exists?: boolean;
  pages_source_uri_exists?: boolean;
  pages_source_kind_exists?: boolean;
};
const needsPagesProvenance = probe.pages_exists
  && (!probeProv.pages_ingested_via_exists
      || !probeProv.pages_ingested_at_exists
      || !probeProv.pages_source_uri_exists
      || !probeProv.pages_source_kind_exists);
// v0.40.3.0 (v90, renumbered from v0.40.3.0 v81 on master merge):
// contextual retrieval columns on pages + sources. Defense-in-depth.
const probeCr = probe as {
  pages_cr_mode_exists?: boolean;
  pages_corpus_generation_exists?: boolean;
  sources_cr_mode_exists?: boolean;
  sources_trust_fm_exists?: boolean;
  pages_generation_exists?: boolean;
  pages_embedding_signature_exists?: boolean;
  pages_links_extracted_at_exists?: boolean;
  timeline_entries_exists?: boolean;
  timeline_event_page_id_exists?: boolean;
  minion_jobs_exists?: boolean;
  minion_jobs_timeout_at_exists?: boolean;
  minion_jobs_idempotency_key_exists?: boolean;
  minion_jobs_pq_owner_exists?: boolean;
  minion_jobs_pq_token_exists?: boolean;
  minion_jobs_pq_lease_exists?: boolean;
};
const needsContextualRetrievalColumns = (probe.pages_exists
    && (!probeCr.pages_cr_mode_exists || !probeCr.pages_corpus_generation_exists))
  || (probe.sources_exists
      && (!probeCr.sources_cr_mode_exists || !probeCr.sources_trust_fm_exists));
// v0.40.3.0 (v91): pages.generation BIGINT bumped by
// bump_page_generation_trg. pages_generation_idx in SCHEMA_SQL references
// it. Pre-v91 brains crash without the column; bootstrap adds it before
// SCHEMA_SQL replay creates the index.
const needsPagesGeneration = probe.pages_exists && !probeCr.pages_generation_exists;
// v0.41.31 (v108): pages.embedding_signature for real stale semantics.
// No SCHEMA_SQL index references it; bootstrap is defense-in-depth.
const needsPagesEmbeddingSignature = probe.pages_exists && !probeCr.pages_embedding_signature_exists;
// v0.42.7 (v112): pages.links_extracted_at link-extraction freshness
// watermark. pages_links_extracted_at_idx in SCHEMA_SQL references it;
// pre-v112 brains crash without the column, so bootstrap adds it before
// SCHEMA_SQL replay creates the index. v112 runs later via runMigrations
// and is idempotent.
const needsPagesLinksExtractedAt = probe.pages_exists && !probeCr.pages_links_extracted_at_exists;
// v121: schema-blob indexes reference event_page_id before migrations run.
const needsTimelineEventPageId = probeCr.timeline_entries_exists === true
  && !probeCr.timeline_event_page_id_exists;
// v7-era (#2626 class sweep): minion_jobs.timeout_at + idempotency_key are
// migration-added AND referenced by blob indexes (idx_minion_jobs_timeout,
// uniq_minion_jobs_idempotency) — a pre-v7 minion_jobs wedges blob replay
// exactly like the v121 incident.
const needsMinionJobsTimeoutAt = probeCr.minion_jobs_exists === true
  && !probeCr.minion_jobs_timeout_at_exists;
const needsMinionJobsIdempotencyKey = probeCr.minion_jobs_exists === true
  && !probeCr.minion_jobs_idempotency_key_exists;
// Token rides the probe too: a token-only-missing brain (partial upgrade)
// would otherwise be unrepairable — the ALTER block adds all three.
const needsMinionJobsPrivateQueue = probeCr.minion_jobs_exists === true
  && (!probeCr.minion_jobs_pq_owner_exists || !probeCr.minion_jobs_pq_token_exists
      || !probeCr.minion_jobs_pq_lease_exists);

if (!needsPagesBootstrap && !needsLinksBootstrap && !needsChunksBootstrap
    && !needsPagesDeletedAt && !needsMcpLogBootstrap && !needsSubagentProviderId
    && !needsChunksEmbeddingImage && !needsPagesRecency
    && !needsIngestLogSourceId && !needsFilesBootstrap
    && !needsOauthClientsBootstrap && !needsOauthClientsSurface
    && !needsSourcesArchive
    && !needsPagesLastRetrievedAt
    && !needsPagesProvenance
    && !needsContextualRetrievalColumns && !needsPagesGeneration
    && !needsPagesEmbeddingSignature
    && !needsPagesLinksExtractedAt
    && !needsTimelineEventPageId
    && !needsMinionJobsTimeoutAt && !needsMinionJobsIdempotencyKey
    && !needsMinionJobsPrivateQueue) return;

process.stderr.write('  Pre-v0.21 brain detected, applying forward-reference bootstrap\n');

if (needsPagesBootstrap) {
  // Mirror schema-embedded.ts's `sources` shape so the subsequent
  // SCHEMA_SQL CREATE TABLE IF NOT EXISTS is a true no-op.
  // Archive columns (v34) are folded in here so a pre-v18 brain doesn't
  // need needsSourcesArchive to also fire — bootstrap creates a complete
  // v34-shape sources in one go. needsSourcesArchive then only fires on
  // the pre-v34 case (sources exists, archive cols don't).
  await conn.unsafe(`
    CREATE TABLE IF NOT EXISTS sources (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL UNIQUE,
      local_path         TEXT,
      last_commit        TEXT,
      last_sync_at       TIMESTAMPTZ,
      config             JSONB NOT NULL DEFAULT '{}'::jsonb,
      archived           BOOLEAN NOT NULL DEFAULT FALSE,
      archived_at        TIMESTAMPTZ,
      archive_expires_at TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO sources (id, name, config)
      VALUES ('default', 'default', '{"federated": true}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_id TEXT
      NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;
  `);
}

if (needsLinksBootstrap) {
  // v11 (links_provenance_columns) handles the CHECK constraint, the
  // UNIQUE swap, and the backfill. The bootstrap only adds enough state
  // for SCHEMA_SQL's `CREATE INDEX idx_links_source/origin` not to crash.
  // v11 runs later via runMigrations and is idempotent.
  await conn.unsafe(`
    ALTER TABLE links ADD COLUMN IF NOT EXISTS link_source TEXT;
    ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_page_id INTEGER
      REFERENCES pages(id) ON DELETE SET NULL;
  `);
}

if (needsChunksBootstrap) {
  // v26 (content_chunks_code_metadata) adds symbol_name + language; v27
  // (Cathedral II) adds parent_symbol_path + doc_comment +
  // symbol_name_qualified + search_vector. The schema blob has indexes
  // (idx_chunks_search_vector line 141, idx_chunks_symbol_qualified
  // line 142) that need the v27 columns to exist before they run.
  // v26 + v27 run later via runMigrations and are idempotent.
  await conn.unsafe(`
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS language TEXT;
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS symbol_name TEXT;
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS parent_symbol_path TEXT[];
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS doc_comment TEXT;
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS symbol_name_qualified TEXT;
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
  `);
}

if (needsPagesDeletedAt) {
  // v34 (destructive_guard_columns) adds the column + sources columns +
  // partial purge index. Bootstrap only adds enough for SCHEMA_SQL's
  // `CREATE INDEX pages_deleted_at_purge_idx ... WHERE deleted_at IS NOT NULL`
  // not to crash. v34 runs later via runMigrations and is idempotent.
  await conn.unsafe(`
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
  `);
}

if (needsMcpLogBootstrap) {
  // v33 (admin_dashboard_columns_v0_26_3) adds agent_name + params +
  // error_message to mcp_request_log. SCHEMA_SQL's
  // `CREATE INDEX idx_mcp_log_agent_time ON mcp_request_log(agent_name,...)`
  // crashes without agent_name. v33 runs later via runMigrations and is
  // idempotent (and also handles backfill).
  await conn.unsafe(`
    ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS agent_name TEXT;
    ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS params JSONB;
    ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS error_message TEXT;
  `);
}

if (needsSubagentProviderId) {
  // v36 (subagent_provider_neutral_persistence_v0_27) adds provider_id +
  // schema_version on subagent_messages and subagent_tool_executions.
  // SCHEMA_SQL's `CREATE INDEX idx_subagent_messages_provider ON
  // subagent_messages (job_id, provider_id)` crashes without provider_id
  // (composite-index second column). v36 runs later via runMigrations and
  // is idempotent.
  await conn.unsafe(`
    ALTER TABLE subagent_messages ADD COLUMN IF NOT EXISTS provider_id TEXT;
  `);
}

if (needsChunksEmbeddingImage) {
  // v39 (multimodal_dual_column_v0_27_1) adds modality + embedding_image
  // columns to content_chunks plus a partial HNSW index that references
  // embedding_image. Bootstrap mirrors enough state for SCHEMA_SQL's
  // `CREATE INDEX idx_chunks_embedding_image ... WHERE embedding_image IS NOT NULL`
  // not to crash. v39 runs later via runMigrations and is idempotent.
  await conn.unsafe(`
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS modality TEXT NOT NULL DEFAULT 'text';
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_image vector(1024);
  `);
}

if (needsPagesRecency) {
  // v40 (pages_emotional_weight) adds emotional_weight; v41
  // (pages_recency_columns) adds effective_date + effective_date_source +
  // import_filename + salience_touched_at and the
  // `pages_coalesce_date_idx ON pages ((COALESCE(effective_date, updated_at)))`
  // expression index. SCHEMA_SQL's CREATE INDEX for that expression crashes
  // before v41 runs. Bootstrap adds all five additive columns; v40 + v41
  // run later via runMigrations and are idempotent.
  await conn.unsafe(`
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS emotional_weight      REAL NOT NULL DEFAULT 0.0;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS effective_date        TIMESTAMPTZ;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS effective_date_source TEXT;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS import_filename       TEXT;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS salience_touched_at   TIMESTAMPTZ;
  `);
}

if (needsIngestLogSourceId) {
  // v50 (ingest_log_source_id) adds source_id +
  // idx_ingest_log_source_type_created composite index. SCHEMA_SQL's
  // CREATE INDEX (source_id, source_type, created_at) crashes without
  // source_id. Bootstrap adds the column with NOT NULL DEFAULT 'default'
  // so the index can build cleanly.
  await conn.unsafe(`
    ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default';
  `);
}

if (needsFilesBootstrap) {
  // v18 (files_provenance_columns) adds source_id + page_id to files plus
  // idx_files_source_id and idx_files_page_id in SCHEMA_SQL. Pre-v18 brains
  // crash on the CREATE INDEX. Bootstrap adds both columns; v18 runs later
  // via runMigrations and is idempotent.
  await conn.unsafe(`
    ALTER TABLE files ADD COLUMN IF NOT EXISTS source_id TEXT
      NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS page_id INTEGER
      REFERENCES pages(id) ON DELETE SET NULL;
  `);
}

if (needsOauthClientsBootstrap) {
  // v60+v61+v65 (oauth_clients_source_id_fk, oauth_clients_federated_read_column,
  // oauth_clients_federated_read_gin_index) add source_id + federated_read
  // and the GIN index idx_oauth_clients_federated_read. SCHEMA_SQL's
  // FK + index references crash on pre-v60 brains. Bootstrap mirrors the
  // v60+v61 column shape; v60-v65 run later via runMigrations and are
  // idempotent (and handle backfill + the v64 RESTRICT-flip).
  await conn.unsafe(`
    ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS source_id TEXT
      DEFAULT 'default' REFERENCES sources(id) ON DELETE SET NULL;
    ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS federated_read TEXT[]
      NOT NULL DEFAULT '{}';
  `);
}

if (needsOauthClientsSurface) {
  // WP4 (v127): per-client MCP tool surface + operator-lock marker.
  // Nullable TEXT, no index — bootstrap mirrors the v127 column shape so
  // the blob's CREATE TABLE presence can't mask the forward reference on
  // pre-v127 brains (the v121 wedge class). v127 runs later via
  // runMigrations and is idempotent. Mirror of the PGLite bootstrap.
  await conn.unsafe(`
    ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface TEXT;
    ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface_set_by TEXT;
  `);
}

if (needsSourcesArchive) {
  // v34 (destructive_guard_columns) promotes archive lifecycle from JSONB
  // config to real columns on sources. SCHEMA_SQL's `CREATE TABLE IF NOT EXISTS
  // sources` is a no-op against an existing pre-v34 sources table, so the
  // column-add never lands until the v34 migration runs. v34's UPDATE
  // statements + downstream visibility filters (search/query/list_pages)
  // need the columns to exist on the table schema. Bootstrap adds the
  // three columns; v34 runs later via runMigrations and is idempotent
  // (and handles JSONB → column backfill).
  await conn.unsafe(`
    ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
    ALTER TABLE sources ADD COLUMN IF NOT EXISTS archive_expires_at TIMESTAMPTZ;
  `);
}

if (needsPagesLastRetrievedAt) {
  // v79 (pages_last_retrieved_at): adds the real stale-page signal column
  // + full B-tree index. SCHEMA_SQL's CREATE INDEX
  // pages_last_retrieved_at_idx crashes without the column. v79 runs
  // later via runMigrations and is idempotent.
  await conn.unsafe(`
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ;
  `);
}

if (needsPagesProvenance) {
  // v81 (pages_provenance_columns): four nullable columns added by the
  // v0.38 ingestion cathedral. No SCHEMA_SQL index/FK references them
  // today; bootstrap exists defense-in-depth so future schema work that
  // does reference them doesn't wedge pre-v81 brains.
  await conn.unsafe(`
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS ingested_via TEXT;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_uri TEXT;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_kind TEXT;
  `);
}

if (needsContextualRetrievalColumns) {
  // v0.40.3.0 v90 (contextual_retrieval_columns, renumbered from
  // v0.40.3.0 v81 on master merge). Five additive columns wiring the
  // three-tier wrapper ladder. Defense-in-depth probes; v90 runs later
  // via runMigrations and is idempotent (ADD COLUMN IF NOT EXISTS).
  await conn.unsafe(`
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS contextual_retrieval_mode TEXT;
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS corpus_generation TEXT;
    ALTER TABLE sources ADD COLUMN IF NOT EXISTS contextual_retrieval_mode TEXT;
    ALTER TABLE sources ADD COLUMN IF NOT EXISTS trust_frontmatter_overrides BOOLEAN NOT NULL DEFAULT FALSE;
  `);
}

if (needsPagesGeneration) {
  // v0.40.3.0 v91 (pages_generation_trigger_and_bookmark):
  // pages.generation BIGINT. SCHEMA_SQL CREATE INDEX
  // pages_generation_idx ON pages (generation) crashes on pre-v91 brains
  // without this. The trigger and index land via v91 migration run
  // later; bootstrap only adds the column. v91 is idempotent.
  await conn.unsafe(`
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1;
  `);
}

if (needsPagesEmbeddingSignature) {
  // v108 (pages_embedding_signature): embedding provenance for real stale
  // semantics. NULL grandfathered. v108 runs later via runMigrations and
  // is idempotent.
  await conn.unsafe(`
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS embedding_signature TEXT;
  `);
}

if (needsPagesLinksExtractedAt) {
  // v112 (pages_links_extracted_at): link-extraction freshness watermark.
  // pages_links_extracted_at_idx in SCHEMA_SQL references it, so bootstrap
  // adds the column before the blob's CREATE INDEX runs. The index itself
  // lands via the blob (CREATE INDEX IF NOT EXISTS) and v112 (CONCURRENTLY);
  // bootstrap only adds the column. v112 runs later via runMigrations and is
  // idempotent.
  await conn.unsafe(`
    ALTER TABLE pages ADD COLUMN IF NOT EXISTS links_extracted_at TIMESTAMPTZ;
  `);
}

if (needsTimelineEventPageId) {
  // Add only the forward-referenced column. Migration v121 remains the
  // source of truth for the FK and indexes and runs idempotently afterward.
  await conn.unsafe(`
    ALTER TABLE timeline_entries ADD COLUMN IF NOT EXISTS event_page_id INTEGER;
  `);
}

if (needsMinionJobsTimeoutAt) {
  // v7: blob index idx_minion_jobs_timeout references timeout_at; a
  // pre-v7 minion_jobs wedges blob replay without it (same class as v121).
  await conn.unsafe(`
    ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ;
  `);
}
if (needsMinionJobsIdempotencyKey) {
  // v7: blob index uniq_minion_jobs_idempotency references idempotency_key.
  await conn.unsafe(`
    ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
  `);
}
if (needsMinionJobsPrivateQueue) {
  // v0.46.26: blob indexes idx_minion_jobs_private_queue_recovery /
  // idx_minion_jobs_private_queue_owner reference the private-queue
  // owner/lease columns; a pre-upgrade minion_jobs wedges blob replay
  // without them (same class as v121). The token column is not indexed
  // but rides along so upgraded rows carry the full lifecycle shape.
  await conn.unsafe(`
    ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_owner_job_id INTEGER REFERENCES minion_jobs(id) ON DELETE SET NULL;
    ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_owner_token TEXT;
    ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_lease_until TIMESTAMPTZ;
  `);
}
}
