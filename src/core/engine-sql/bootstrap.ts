/**
 * Forward-reference bootstrap: one implementation for both engines (refactor
 * wave 1, E1). Replaces `PGLiteEngine#applyForwardReferenceBootstrap` and
 * `src/core/postgres-engine/forward-reference-bootstrap.ts`, which carried
 * the same probes and DDL twice (per-probe inventory:
 * docs/designs/refactor-wave-1/w1-inventory.md, "Forward-reference
 * bootstrap (E1)").
 *
 * Every schema-replay entrypoint runs it right before the embedded blob:
 *   - `PGLiteEngine.initSchema()` (PGLITE_SCHEMA_SQL) via `pgliteBootstrapTarget`.
 *   - `PostgresEngine.initSchema()` and the standalone `db.initSchema()`
 *     (SCHEMA_SQL) via `applyPostgresForwardReferenceBootstrap(conn)`, on the
 *     caller's connection, which MUST hold the initSchema advisory lock (key
 *     42) so concurrent bootstraps can't race on a transaction pooler.
 *
 * The blob forward-references state that older brains don't have yet (a
 * column-with-index or FK target that a migration adds later). One probe
 * round-trip finds every gap; fresh installs and modern brains no-op.
 *
 * Engine differences are explicit dialect hooks, never `dialect ===` checks:
 *   - `probeSchema`: master's probe predicate (`current_schema()` on
 *     Postgres, the literal `'public'` on PGLite).
 *   - `dreamVerdictsForwardReference`: only the Postgres blob carries
 *     `dream_verdicts` + `dream_verdicts_expires_idx`; PGLite creates the
 *     table by migration (v30), so it neither probes nor ALTERs it.
 *   - `chunksEmbeddingImageStep`: the v39 ALTER ran at a different position
 *     in each engine's master sequence; each keeps its own order.
 *
 * **Maintenance contract:** when a migration adds a column-with-index or a
 * new-table-with-FK referenced by either schema blob, add the probe to
 * FORWARD_REFERENCE_PROBES, the gap to `forwardReferenceGaps`, and the DDL
 * below, plus `REQUIRED_BOOTSTRAP_COVERAGE` in
 * `test/schema-bootstrap-coverage.test.ts`. That test (PGLite A2 static
 * check, MIGRATIONS column-only check, Postgres-blob CREATE-INDEX gate) parses
 * THIS file; `test/bootstrap.test.ts` and `test/e2e/postgres-bootstrap.test.ts`
 * are the live convergence halves. DDL that only one blob needs sits between
 * `dialect-only:<engine>` markers so the other engine's coverage check does
 * not count it.
 */

import type { PGlite } from '@electric-sql/pglite';
import type postgres from '#postgres';
import { GRANT_COLUMNS_SQL } from '../grants/schema.ts';

type ProbeRow = Record<string, boolean>;

export interface ForwardReferenceBootstrapDialect {
  /** SQL expression the probe compares `information_schema.*.table_schema` against. */
  readonly probeSchema: string;
  /** Whether this engine's blob forward-references `dream_verdicts.expires_at` (probe + ALTER). */
  readonly dreamVerdictsForwardReference: boolean;
  /** Where the v39 `content_chunks` ALTER runs in this engine's DDL sequence. */
  readonly chunksEmbeddingImageStep: 'after-pages-deleted-at' | 'after-subagent-provider-id';
}

export const PGLITE_BOOTSTRAP_DIALECT: ForwardReferenceBootstrapDialect = {
  probeSchema: `'public'`,
  dreamVerdictsForwardReference: false,
  chunksEmbeddingImageStep: 'after-pages-deleted-at',
};

export const POSTGRES_BOOTSTRAP_DIALECT: ForwardReferenceBootstrapDialect = {
  probeSchema: 'current_schema()',
  dreamVerdictsForwardReference: true,
  chunksEmbeddingImageStep: 'after-subagent-provider-id',
};

/** One connection handle the bootstrap runs on. */
export interface ForwardReferenceBootstrapTarget {
  readonly dialect: ForwardReferenceBootstrapDialect;
  /** Runs the single probe statement and returns its one row. */
  probe(sql: string): Promise<ProbeRow>;
  /** Runs one multi-statement DDL batch. */
  exec(sql: string): Promise<void>;
}

/** PGLite: `db.query` for the probe, `db.exec` for DDL batches (master's calls). */
export function pgliteBootstrapTarget(db: Pick<PGlite, 'query' | 'exec'>): ForwardReferenceBootstrapTarget {
  return {
    dialect: PGLITE_BOOTSTRAP_DIALECT,
    probe: async (sql) => (await db.query<ProbeRow>(sql)).rows[0] as ProbeRow,
    exec: async (sql) => { await db.exec(sql); },
  };
}

/**
 * Master ran the Postgres probe as a zero-parameter tagged template: prepared
 * when the connection allows it (direct Postgres; PgBouncer's connection-level
 * `prepare: false` wins) on the extended protocol. These are the equivalent
 * `unsafe` options (the engine-sql adapter's EO2 conversion).
 */
const TAGGED_TEMPLATE_OPTS = { prepare: true, simple: false };

/** Postgres: the probe on the caller's connection as master's tagged template; DDL through `conn.unsafe`. */
export function postgresBootstrapTarget(conn: ReturnType<typeof postgres>): ForwardReferenceBootstrapTarget {
  return {
    dialect: POSTGRES_BOOTSTRAP_DIALECT,
    probe: async (sql) => (await conn.unsafe<ProbeRow[]>(sql, [], TAGGED_TEMPLATE_OPTS))[0]!,
    exec: async (sql) => { await conn.unsafe(sql); },
  };
}

/**
 * Probe + patch every forward-reference target SCHEMA_SQL needs, on the
 * caller-provided connection (see the module header for the lock contract).
 * Kept under this name for `postgres-engine/forward-reference-bootstrap.ts`,
 * which re-exports it.
 */
export async function applyPostgresForwardReferenceBootstrap(conn: ReturnType<typeof postgres>): Promise<void> {
  await applyForwardReferenceBootstrap(postgresBootstrapTarget(conn));
}

type Probe = readonly [alias: string, table: string, column?: string];

// Every probe both engines run. Result order is irrelevant (read by alias).
const FORWARD_REFERENCE_PROBES: readonly Probe[] = [
  ['pages_exists', 'pages'],
  ['source_id_exists', 'pages', 'source_id'],
  ['deleted_at_exists', 'pages', 'deleted_at'],
  ['effective_date_exists', 'pages', 'effective_date'],
  ['links_exists', 'links'],
  ['link_source_exists', 'links', 'link_source'],
  ['origin_page_id_exists', 'links', 'origin_page_id'],
  ['chunks_exists', 'content_chunks'],
  ['symbol_name_exists', 'content_chunks', 'symbol_name'],
  ['language_exists', 'content_chunks', 'language'],
  ['search_vector_exists', 'content_chunks', 'search_vector'],
  ['embedding_image_exists', 'content_chunks', 'embedding_image'],
  ['mcp_log_exists', 'mcp_request_log'],
  ['agent_name_exists', 'mcp_request_log', 'agent_name'],
  ['subagent_messages_exists', 'subagent_messages'],
  ['subagent_provider_id_exists', 'subagent_messages', 'provider_id'],
  ['ingest_log_exists', 'ingest_log'],
  ['ingest_log_source_id_exists', 'ingest_log', 'source_id'],
  ['files_exists', 'files'],
  ['files_source_id_exists', 'files', 'source_id'],
  ['files_page_id_exists', 'files', 'page_id'],
  ['oauth_clients_exists', 'oauth_clients'],
  ['oauth_clients_source_id_exists', 'oauth_clients', 'source_id'],
  ['oauth_clients_federated_read_exists', 'oauth_clients', 'federated_read'],
  ['oauth_clients_surface_exists', 'oauth_clients', 'surface'],
  ['oauth_clients_surface_set_by_exists', 'oauth_clients', 'surface_set_by'],
  ['sources_exists', 'sources'],
  ['sources_archived_exists', 'sources', 'archived'],
  ['sources_archived_at_exists', 'sources', 'archived_at'],
  ['sources_archive_expires_at_exists', 'sources', 'archive_expires_at'],
  ['pages_last_retrieved_at_exists', 'pages', 'last_retrieved_at'],
  ['pages_ingested_via_exists', 'pages', 'ingested_via'],
  ['pages_ingested_at_exists', 'pages', 'ingested_at'],
  ['pages_source_uri_exists', 'pages', 'source_uri'],
  ['pages_source_kind_exists', 'pages', 'source_kind'],
  ['pages_cr_mode_exists', 'pages', 'contextual_retrieval_mode'],
  ['pages_corpus_generation_exists', 'pages', 'corpus_generation'],
  ['sources_cr_mode_exists', 'sources', 'contextual_retrieval_mode'],
  ['sources_trust_fm_exists', 'sources', 'trust_frontmatter_overrides'],
  ['pages_generation_exists', 'pages', 'generation'],
  ['pages_embedding_signature_exists', 'pages', 'embedding_signature'],
  ['pages_links_extracted_at_exists', 'pages', 'links_extracted_at'],
  ['timeline_entries_exists', 'timeline_entries'],
  ['timeline_event_page_id_exists', 'timeline_entries', 'event_page_id'],
  ['minion_jobs_exists', 'minion_jobs'],
  ['minion_jobs_timeout_at_exists', 'minion_jobs', 'timeout_at'],
  ['minion_jobs_idempotency_key_exists', 'minion_jobs', 'idempotency_key'],
  ['minion_jobs_pq_owner_exists', 'minion_jobs', 'private_queue_owner_job_id'],
  ['minion_jobs_pq_token_exists', 'minion_jobs', 'private_queue_owner_token'],
  ['minion_jobs_pq_lease_exists', 'minion_jobs', 'private_queue_lease_until'],
  ['minion_jobs_submission_authority_exists', 'minion_jobs', 'submission_authority'],
  ['minion_jobs_claim_generation_exists', 'minion_jobs', 'claim_generation'],
  ['facts_exists', 'facts'],
  ['facts_embedding_model_exists', 'facts', 'embedding_model'],
  ['facts_embedded_text_hash_exists', 'facts', 'embedded_text_hash'],
];

// Probed only where `dreamVerdictsForwardReference` (the Postgres blob).
const DREAM_VERDICTS_PROBES: readonly Probe[] = [
  ['dream_verdicts_exists', 'dream_verdicts'],
  ['dream_verdicts_expires_at_exists', 'dream_verdicts', 'expires_at'],
];

/** The single-round-trip probe statement for one dialect. */
export function forwardReferenceProbeSql(dialect: ForwardReferenceBootstrapDialect): string {
  const schema = dialect.probeSchema;
  const exists = ([alias, table, column]: Probe) => column
    ? `EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_schema = ${schema} AND table_name = '${table}' AND column_name = '${column}') AS ${alias}`
    : `EXISTS (SELECT 1 FROM information_schema.tables
            WHERE table_schema = ${schema} AND table_name = '${table}') AS ${alias}`;
  const grants = `(SELECT COUNT(*) = 6 FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'oauth_clients'
        AND column_name IN ('allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile', 'grant_revision', 'grant_repair_reasons')) AS oauth_client_grants_exist`;
  const probes = dialect.dreamVerdictsForwardReference
    ? [...FORWARD_REFERENCE_PROBES, ...DREAM_VERDICTS_PROBES]
    : FORWARD_REFERENCE_PROBES;
  return `
  SELECT
    ${[...probes.map(exists), grants].join(',\n    ')}
`;
}

/** Which forward references are missing. Fresh installs (no tables) and modern brains report none. */
export function forwardReferenceGaps(probe: ProbeRow, dialect: ForwardReferenceBootstrapDialect) {
  const needsPagesBootstrap = probe.pages_exists && !probe.source_id_exists;
  const needsLinksBootstrap = probe.links_exists
    && (!probe.link_source_exists || !probe.origin_page_id_exists);
  const needsChunksBootstrap = probe.chunks_exists
    && (!probe.symbol_name_exists || !probe.language_exists || !probe.search_vector_exists);
  // v0.26.5: pages_deleted_at_purge_idx in the blob crashes if the column
  // doesn't exist yet. Migration v34 also adds it, but bootstrap runs first.
  const needsPagesDeletedAt = probe.pages_exists && !probe.deleted_at_exists;
  // v0.26.3 (v33): idx_mcp_log_agent_time in the blob needs agent_name col.
  const needsMcpLogBootstrap = probe.mcp_log_exists && !probe.agent_name_exists;
  // v0.27 (v36): idx_subagent_messages_provider in the blob needs provider_id
  // (the SECOND column in the composite index `(job_id, provider_id)`).
  const needsSubagentProviderId = probe.subagent_messages_exists && !probe.subagent_provider_id_exists;
  // v0.27.1 (v39): idx_chunks_embedding_image partial HNSW in the blob
  // references embedding_image. Use embedding_image_exists as the proxy for
  // both v39 columns; modality is added in the same migration.
  const needsChunksEmbeddingImage = probe.chunks_exists && !probe.embedding_image_exists;
  // v0.29.1 (v40 + v41): pages_coalesce_date_idx expression index in the
  // blob references effective_date. Use effective_date_exists as the proxy
  // for the five v40 + v41 pages columns (emotional_weight, effective_date,
  // effective_date_source, import_filename, salience_touched_at).
  const needsPagesRecency = probe.pages_exists && !probe.effective_date_exists;
  // v0.31.2 (v50): idx_ingest_log_source_type_created in the blob references
  // source_id. Old brains have ingest_log without source_id; bootstrap adds
  // the column before blob replay creates the index.
  const needsIngestLogSourceId = probe.ingest_log_exists && !probe.ingest_log_source_id_exists;
  // v0.18 (v18): files.source_id + files.page_id added; idx_files_source_id
  // and idx_files_page_id in the blob crash without them.
  const needsFilesBootstrap = probe.files_exists
    && (!probe.files_source_id_exists || !probe.files_page_id_exists);
  // v0.34.1 (v60+v61+v65): oauth_clients.source_id + federated_read added;
  // FK to sources(id) + GIN index idx_oauth_clients_federated_read in the
  // blob crash without them.
  const needsOauthClientsBootstrap = probe.oauth_clients_exists
    && (!probe.oauth_clients_source_id_exists || !probe.oauth_clients_federated_read_exists);
  // WP4 (v127): oauth_clients.surface + surface_set_by. No blob index
  // references them, but the columns are migration-added AND in the blob's
  // CREATE TABLE — the exact v121 mask class — so the bootstrap adds them
  // defense-in-depth (and satisfies the MIGRATIONS ADD COLUMN coverage
  // gate). They ship in one migration and go missing together.
  const needsOauthClientsSurface = probe.oauth_clients_exists
    && (!probe.oauth_clients_surface_exists || !probe.oauth_clients_surface_set_by_exists);
  const needsOauthClientGrants = probe.oauth_clients_exists && !probe.oauth_client_grants_exist;
  // v0.26.5 (v34): sources.archived + archived_at + archive_expires_at added
  // for soft-delete lifecycle. The blob's `CREATE TABLE IF NOT EXISTS sources`
  // is a no-op on pre-existing sources tables (won't add columns), so the
  // visibility filters in search/list_pages trip on old brains. Bootstrap
  // closes the gap before any visibility-filter SQL runs.
  const needsSourcesArchive = probe.sources_exists
    && (!probe.sources_archived_exists
        || !probe.sources_archived_at_exists
        || !probe.sources_archive_expires_at_exists);
  // v0.37.0 (v79): pages_last_retrieved_at_idx in the blob references
  // last_retrieved_at. Pre-v79 brains crash without the column; bootstrap
  // adds it before blob replay creates the index. v79 runs later via
  // runMigrations and is idempotent.
  const needsPagesLastRetrievedAt = probe.pages_exists && !probe.pages_last_retrieved_at_exists;
  // v0.38.0 (v80): provenance columns on pages. Not referenced by any blob
  // index or FK today; bootstrap exists for the column-only forward-
  // reference class defense-in-depth.
  const needsPagesProvenance = probe.pages_exists
    && (!probe.pages_ingested_via_exists
        || !probe.pages_ingested_at_exists
        || !probe.pages_source_uri_exists
        || !probe.pages_source_kind_exists);
  // v0.40.3.0 (v90, renumbered from v0.40.3.0 v81 on master merge):
  // contextual retrieval columns on pages + sources. Defense-in-depth.
  const needsContextualRetrievalColumns = (probe.pages_exists
      && (!probe.pages_cr_mode_exists || !probe.pages_corpus_generation_exists))
    || (probe.sources_exists
        && (!probe.sources_cr_mode_exists || !probe.sources_trust_fm_exists));
  // v0.40.3.0 (v91): pages.generation BIGINT bumped by
  // bump_page_generation_trg. pages_generation_idx in the blob references
  // it. Pre-v91 brains crash without the column; bootstrap adds it before
  // blob replay creates the index.
  const needsPagesGeneration = probe.pages_exists && !probe.pages_generation_exists;
  // v0.41.31 (v108): pages.embedding_signature for real stale semantics.
  // No blob index references it; bootstrap is defense-in-depth.
  const needsPagesEmbeddingSignature = probe.pages_exists && !probe.pages_embedding_signature_exists;
  // v0.42.7 (v112): pages.links_extracted_at link-extraction freshness
  // watermark. pages_links_extracted_at_idx in the blob references it;
  // pre-v112 brains crash without the column, so bootstrap adds it before
  // blob replay creates the index. v112 runs later via runMigrations and is
  // idempotent.
  const needsPagesLinksExtractedAt = probe.pages_exists && !probe.pages_links_extracted_at_exists;
  // v121: schema-blob indexes reference event_page_id before migrations run.
  const needsTimelineEventPageId = probe.timeline_entries_exists && !probe.timeline_event_page_id_exists;
  // v7-era (#2626 class sweep): minion_jobs.timeout_at + idempotency_key are
  // migration-added AND referenced by blob indexes (idx_minion_jobs_timeout,
  // uniq_minion_jobs_idempotency) — a pre-v7 minion_jobs wedges blob replay
  // exactly like the v121 incident.
  const needsMinionJobsTimeoutAt = probe.minion_jobs_exists && !probe.minion_jobs_timeout_at_exists;
  const needsMinionJobsIdempotencyKey = probe.minion_jobs_exists && !probe.minion_jobs_idempotency_key_exists;
  // Token rides the probe too: a token-only-missing brain (partial upgrade)
  // would otherwise be unrepairable — the ALTER block adds all three.
  const needsMinionJobsPrivateQueue = probe.minion_jobs_exists
    && (!probe.minion_jobs_pq_owner_exists || !probe.minion_jobs_pq_token_exists
        || !probe.minion_jobs_pq_lease_exists);
  // v149: the schema-blob queue protocol references both fields. Repair either
  // missing field without assigning authority to historical work.
  const needsMinionJobsAuthority = probe.minion_jobs_exists
    && (!probe.minion_jobs_submission_authority_exists || !probe.minion_jobs_claim_generation_exists);
  // v143 (dream_verdicts_ttl, #4657): the Postgres blob index
  // dream_verdicts_expires_idx references expires_at, but the column only
  // lands via migration v143 — a Postgres brain at schema v30-v142
  // (dream_verdicts exists since v30) wedges on the blob's CREATE INDEX
  // before any migration runs. Same class as v121/v7; PGLite is unaffected
  // (its blob carries no dream_verdicts).
  const needsDreamVerdictsExpiresAt = dialect.dreamVerdictsForwardReference
    && probe.dream_verdicts_exists && !probe.dream_verdicts_expires_at_exists;
  const needsFactEmbeddingIdentity = probe.facts_exists
    && (!probe.facts_embedding_model_exists || !probe.facts_embedded_text_hash_exists);
  return {
    needsPagesBootstrap, needsLinksBootstrap, needsChunksBootstrap, needsPagesDeletedAt,
    needsMcpLogBootstrap, needsSubagentProviderId, needsChunksEmbeddingImage, needsPagesRecency,
    needsIngestLogSourceId, needsFilesBootstrap, needsOauthClientsBootstrap, needsOauthClientsSurface,
    needsOauthClientGrants, needsSourcesArchive, needsPagesLastRetrievedAt, needsPagesProvenance,
    needsContextualRetrievalColumns, needsPagesGeneration, needsPagesEmbeddingSignature,
    needsPagesLinksExtractedAt, needsTimelineEventPageId, needsMinionJobsTimeoutAt,
    needsMinionJobsIdempotencyKey, needsMinionJobsPrivateQueue, needsMinionJobsAuthority,
    needsDreamVerdictsExpiresAt, needsFactEmbeddingIdentity,
  };
}

type ForwardReferenceGaps = ReturnType<typeof forwardReferenceGaps>;

/** Probe once, then add every missing forward-referenced piece of state in master's order. */
export async function applyForwardReferenceBootstrap(target: ForwardReferenceBootstrapTarget): Promise<void> {
  const gaps = forwardReferenceGaps(await target.probe(forwardReferenceProbeSql(target.dialect)), target.dialect);
  const {
    needsPagesBootstrap, needsLinksBootstrap, needsChunksBootstrap, needsPagesDeletedAt,
    needsMcpLogBootstrap, needsSubagentProviderId, needsChunksEmbeddingImage, needsPagesRecency,
    needsIngestLogSourceId, needsFilesBootstrap, needsOauthClientsBootstrap, needsOauthClientsSurface,
    needsOauthClientGrants, needsSourcesArchive, needsPagesLastRetrievedAt, needsPagesProvenance,
    needsContextualRetrievalColumns, needsPagesGeneration, needsPagesEmbeddingSignature,
    needsPagesLinksExtractedAt, needsTimelineEventPageId, needsMinionJobsTimeoutAt,
    needsMinionJobsIdempotencyKey, needsMinionJobsPrivateQueue, needsMinionJobsAuthority,
    needsDreamVerdictsExpiresAt, needsFactEmbeddingIdentity,
  } = gaps;

  if (!needsPagesBootstrap && !needsLinksBootstrap && !needsChunksBootstrap
      && !needsPagesDeletedAt && !needsMcpLogBootstrap && !needsSubagentProviderId
      && !needsChunksEmbeddingImage && !needsPagesRecency
      && !needsIngestLogSourceId && !needsFilesBootstrap
      && !needsOauthClientsBootstrap && !needsOauthClientsSurface && !needsOauthClientGrants
      && !needsSourcesArchive
      && !needsPagesLastRetrievedAt
      && !needsPagesProvenance
      && !needsContextualRetrievalColumns && !needsPagesGeneration
      && !needsPagesEmbeddingSignature
      && !needsPagesLinksExtractedAt
      && !needsTimelineEventPageId
      && !needsMinionJobsTimeoutAt && !needsMinionJobsIdempotencyKey
      && !needsMinionJobsPrivateQueue && !needsMinionJobsAuthority
      && !needsDreamVerdictsExpiresAt && !needsFactEmbeddingIdentity) return;

  process.stderr.write('  Schema forward-reference gap detected, applying bootstrap\n');

  await applyCoreTableGaps(target, gaps);
  await applyLaterColumnGaps(target, gaps);
}

// v39 (multimodal_dual_column_v0_27_1) adds modality + embedding_image
// columns to content_chunks plus a partial HNSW index that references
// embedding_image. Bootstrap mirrors enough state for the blob's
// `CREATE INDEX idx_chunks_embedding_image ... WHERE embedding_image IS NOT NULL`
// not to crash. v39 runs later via runMigrations and is idempotent.
const CHUNKS_EMBEDDING_IMAGE_SQL = `
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS modality TEXT NOT NULL DEFAULT 'text';
    ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_image vector(1024);
  `;

/** facts through sources archive: the first half of master's DDL sequence. */
async function applyCoreTableGaps(target: ForwardReferenceBootstrapTarget, gaps: ForwardReferenceGaps): Promise<void> {
  const exec = (sql: string) => target.exec(sql);
  const { dialect } = target;
  const {
    needsFactEmbeddingIdentity, needsPagesBootstrap, needsLinksBootstrap, needsChunksBootstrap,
    needsPagesDeletedAt, needsChunksEmbeddingImage, needsMcpLogBootstrap, needsSubagentProviderId,
    needsPagesRecency, needsIngestLogSourceId, needsFilesBootstrap, needsOauthClientsBootstrap,
    needsOauthClientGrants, needsOauthClientsSurface, needsSourcesArchive,
  } = gaps;

  if (needsFactEmbeddingIdentity) {
    await exec(`
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS embedding_model TEXT;
      ALTER TABLE facts ADD COLUMN IF NOT EXISTS embedded_text_hash TEXT;
    `);
  }

  if (needsPagesBootstrap) {
    // Mirror the blob's `sources` shape so the subsequent blob
    // CREATE TABLE IF NOT EXISTS is a true no-op.
    // Archive columns (v34) are folded in here so a pre-v18 brain doesn't
    // need needsSourcesArchive to also fire — bootstrap creates a complete
    // v34-shape sources in one go. needsSourcesArchive then only fires on
    // the pre-v34 case (sources exists, archive cols don't).
    await exec(`
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
    // for the blob's `CREATE INDEX idx_links_source/origin` not to crash.
    // v11 runs later via runMigrations and is idempotent.
    await exec(`
      ALTER TABLE links ADD COLUMN IF NOT EXISTS link_source TEXT;
      ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_page_id INTEGER
        REFERENCES pages(id) ON DELETE SET NULL;
    `);
  }

  if (needsChunksBootstrap) {
    // v26 (content_chunks_code_metadata) adds symbol_name + language; v27
    // (Cathedral II) adds parent_symbol_path + doc_comment +
    // symbol_name_qualified + search_vector. The blob has indexes
    // (idx_chunks_search_vector, idx_chunks_symbol_qualified) that need the
    // v27 columns to exist before they run. v26 + v27 run later via
    // runMigrations and are idempotent.
    await exec(`
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
    // partial purge index. Bootstrap only adds enough for the blob's
    // `CREATE INDEX pages_deleted_at_purge_idx ... WHERE deleted_at IS NOT NULL`
    // not to crash. v34 runs later via runMigrations and is idempotent.
    await exec(`
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    `);
  }

  if (needsChunksEmbeddingImage && dialect.chunksEmbeddingImageStep === 'after-pages-deleted-at') {
    await exec(CHUNKS_EMBEDDING_IMAGE_SQL);
  }

  if (needsMcpLogBootstrap) {
    // v33 (admin_dashboard_columns_v0_26_3) adds agent_name + params +
    // error_message to mcp_request_log. The blob's
    // `CREATE INDEX idx_mcp_log_agent_time ON mcp_request_log(agent_name,...)`
    // crashes without agent_name. v33 runs later via runMigrations and is
    // idempotent (and also handles backfill).
    await exec(`
      ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS agent_name TEXT;
      ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS params JSONB;
      ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS error_message TEXT;
    `);
  }

  if (needsSubagentProviderId) {
    // v36 (subagent_provider_neutral_persistence_v0_27) adds provider_id +
    // schema_version on subagent_messages and subagent_tool_executions.
    // The blob's `CREATE INDEX idx_subagent_messages_provider ON
    // subagent_messages (job_id, provider_id)` crashes without provider_id
    // (composite-index second column). v36 runs later via runMigrations and
    // is idempotent.
    await exec(`
      ALTER TABLE subagent_messages ADD COLUMN IF NOT EXISTS provider_id TEXT;
    `);
  }

  if (needsChunksEmbeddingImage && dialect.chunksEmbeddingImageStep === 'after-subagent-provider-id') {
    await exec(CHUNKS_EMBEDDING_IMAGE_SQL);
  }

  if (needsPagesRecency) {
    // v40 (pages_emotional_weight) adds emotional_weight; v41
    // (pages_recency_columns) adds effective_date + effective_date_source +
    // import_filename + salience_touched_at and the
    // `pages_coalesce_date_idx ON pages ((COALESCE(effective_date, updated_at)))`
    // expression index. The blob's CREATE INDEX for that expression crashes
    // before v41 runs. Bootstrap adds all five additive columns; v40 + v41
    // run later via runMigrations and are idempotent.
    await exec(`
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS emotional_weight      REAL NOT NULL DEFAULT 0.0;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS effective_date        TIMESTAMPTZ;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS effective_date_source TEXT;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS import_filename       TEXT;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS salience_touched_at   TIMESTAMPTZ;
    `);
  }

  if (needsIngestLogSourceId) {
    // v50 (ingest_log_source_id) adds source_id + the
    // idx_ingest_log_source_type_created composite index. The blob's
    // CREATE INDEX (source_id, source_type, created_at) crashes without
    // source_id. Bootstrap adds the column with NOT NULL DEFAULT 'default'
    // so the index can build cleanly.
    await exec(`
      ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS source_id TEXT NOT NULL DEFAULT 'default';
    `);
  }

  if (needsFilesBootstrap) {
    // v18 (files_provenance_columns) adds source_id + page_id to files plus
    // idx_files_source_id and idx_files_page_id in the blob. Pre-v18 brains
    // crash on the CREATE INDEX. Bootstrap adds both columns; v18 runs later
    // via runMigrations and is idempotent.
    await exec(`
      ALTER TABLE files ADD COLUMN IF NOT EXISTS source_id TEXT
        NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;
      ALTER TABLE files ADD COLUMN IF NOT EXISTS page_id INTEGER
        REFERENCES pages(id) ON DELETE SET NULL;
    `);
  }

  if (needsOauthClientsBootstrap) {
    // v60+v61+v65 (oauth_clients_source_id_fk, oauth_clients_federated_read_column,
    // oauth_clients_federated_read_gin_index) add source_id + federated_read
    // and the GIN index idx_oauth_clients_federated_read. The blob's
    // FK + index references crash on pre-v60 brains. Bootstrap mirrors the
    // v60+v61 column shape; v60-v65 run later via runMigrations and are
    // idempotent (and handle backfill + the v64 RESTRICT-flip).
    await exec(`
      ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS source_id TEXT
        DEFAULT 'default' REFERENCES sources(id) ON DELETE SET NULL;
      ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS federated_read TEXT[]
        NOT NULL DEFAULT '{}';
    `);
  }

  // Includes partially installed grant columns. Numbered migration 147 owns
  // policy repair and its constraints.
  if (needsOauthClientGrants) await exec(GRANT_COLUMNS_SQL);

  if (needsOauthClientsSurface) {
    // WP4 (v127): per-client MCP tool surface + operator-lock marker.
    // Nullable TEXT, no index — bootstrap mirrors the v127 column shape so
    // the blob's CREATE TABLE presence can't mask the forward reference on
    // pre-v127 brains (the v121 wedge class). v127 runs later via
    // runMigrations and is idempotent.
    await exec(`
      ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface TEXT;
      ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface_set_by TEXT;
    `);
  }

  if (needsSourcesArchive) {
    // v34 (destructive_guard_columns) promotes archive lifecycle from JSONB
    // config to real columns on sources. The blob's `CREATE TABLE IF NOT
    // EXISTS sources` is a no-op against an existing pre-v34 sources table,
    // so the column-add never lands until the v34 migration runs. v34's
    // UPDATE statements + downstream visibility filters (search/query/
    // list_pages) need the columns to exist on the table schema. Bootstrap
    // adds the three columns; v34 runs later via runMigrations and is
    // idempotent (and handles JSONB → column backfill).
    await exec(`
      ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE sources ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
      ALTER TABLE sources ADD COLUMN IF NOT EXISTS archive_expires_at TIMESTAMPTZ;
    `);
  }
}

/** pages v79+ columns through minion_jobs authority: the second half of master's DDL sequence. */
async function applyLaterColumnGaps(target: ForwardReferenceBootstrapTarget, gaps: ForwardReferenceGaps): Promise<void> {
  const exec = (sql: string) => target.exec(sql);
  const {
    needsPagesLastRetrievedAt, needsPagesProvenance, needsContextualRetrievalColumns,
    needsPagesGeneration, needsPagesEmbeddingSignature, needsPagesLinksExtractedAt,
    needsTimelineEventPageId, needsMinionJobsTimeoutAt, needsMinionJobsIdempotencyKey,
    needsDreamVerdictsExpiresAt, needsMinionJobsPrivateQueue, needsMinionJobsAuthority,
  } = gaps;

  if (needsPagesLastRetrievedAt) {
    // v79 (pages_last_retrieved_at): adds the stale-page signal column +
    // full B-tree index. The blob's CREATE INDEX pages_last_retrieved_at_idx
    // crashes without the column. v79 runs later via runMigrations and is
    // idempotent.
    await exec(`
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ;
    `);
  }

  if (needsPagesProvenance) {
    // v81 (pages_provenance_columns): four nullable columns added by the
    // v0.38 ingestion cathedral. No blob index/FK references them today;
    // bootstrap exists defense-in-depth so future schema work that does
    // reference them doesn't wedge pre-v81 brains.
    await exec(`
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
    await exec(`
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS contextual_retrieval_mode TEXT;
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS corpus_generation TEXT;
      ALTER TABLE sources ADD COLUMN IF NOT EXISTS contextual_retrieval_mode TEXT;
      ALTER TABLE sources ADD COLUMN IF NOT EXISTS trust_frontmatter_overrides BOOLEAN NOT NULL DEFAULT FALSE;
    `);
  }

  if (needsPagesGeneration) {
    // v0.40.3.0 v91 (pages_generation_trigger_and_bookmark):
    // pages.generation BIGINT. The blob's CREATE INDEX pages_generation_idx
    // ON pages (generation) crashes on pre-v91 brains without this. The
    // trigger and index land via v91 migration run later; bootstrap only
    // adds the column. v91 is idempotent.
    await exec(`
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1;
    `);
  }

  if (needsPagesEmbeddingSignature) {
    // v108 (pages_embedding_signature): embedding provenance for real stale
    // semantics. NULL grandfathered (never stale). v108 runs later via
    // runMigrations and is idempotent.
    await exec(`
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS embedding_signature TEXT;
    `);
  }

  if (needsPagesLinksExtractedAt) {
    // v112 (pages_links_extracted_at): link-extraction freshness watermark.
    // pages_links_extracted_at_idx in the blob references it, so bootstrap
    // adds the column before the blob's CREATE INDEX runs. The index itself
    // lands via the blob (CREATE INDEX IF NOT EXISTS) and v112; bootstrap
    // only adds the column. v112 runs later via runMigrations and is
    // idempotent.
    await exec(`
      ALTER TABLE pages ADD COLUMN IF NOT EXISTS links_extracted_at TIMESTAMPTZ;
    `);
  }

  if (needsTimelineEventPageId) {
    // Add only the forward-referenced column. Migration v121 remains the
    // source of truth for the FK and indexes and runs idempotently afterward.
    await exec(`
      ALTER TABLE timeline_entries ADD COLUMN IF NOT EXISTS event_page_id INTEGER;
    `);
  }

  if (needsMinionJobsTimeoutAt) {
    // v7: blob index idx_minion_jobs_timeout references timeout_at; a
    // pre-v7 minion_jobs wedges blob replay without it (same class as v121).
    await exec(`
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ;
    `);
  }
  if (needsMinionJobsIdempotencyKey) {
    // v7: blob index uniq_minion_jobs_idempotency references idempotency_key.
    await exec(`
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    `);
  }
  // dialect-only:postgres begin
  if (needsDreamVerdictsExpiresAt) {
    // Nullable column + DEFAULT as TWO statements, deliberately:
    //  - a single `ADD COLUMN ... DEFAULT` would stamp EXISTING rows via
    //    PG11 fast-defaults, destroying v143's judged_at-derived backfill
    //    (pre-TTL rows must keep their original age);
    //  - SET DEFAULT after ADD affects only NEW rows, so a legacy writer
    //    racing the upgrade window can't insert NULLs (and getDreamVerdict's
    //    read predicate is NULL-tolerant for rows older than the default).
    // Migration v143 stays the source of truth for the backfill, SET NOT
    // NULL, and the index. On the engine path it runs right after bootstrap
    // under the same advisory lock; on the standalone db.ts:initSchema path
    // migrations do NOT run — the column stays nullable there until the next
    // full engine init, which the NULL-tolerant read predicate makes safe.
    await exec(`
      ALTER TABLE dream_verdicts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      ALTER TABLE dream_verdicts ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 days');
    `);
  }
  // dialect-only:postgres end
  if (needsMinionJobsPrivateQueue) {
    // v0.46.26: blob indexes idx_minion_jobs_private_queue_recovery /
    // idx_minion_jobs_private_queue_owner reference the private-queue
    // owner/lease columns; a pre-upgrade minion_jobs wedges blob replay
    // without them (same class as v121). The token column is not indexed
    // but rides along so upgraded rows carry the full lifecycle shape.
    await exec(`
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_owner_job_id INTEGER REFERENCES minion_jobs(id) ON DELETE SET NULL;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_owner_token TEXT;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS private_queue_lease_until TIMESTAMPTZ;
    `);
  }
  if (needsMinionJobsAuthority) {
    // Metadata only. Migration v149 owns the cutover guard; local explicit
    // review is the only path that may assign authority to historical rows.
    await exec(`
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS submission_authority JSONB;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS claim_generation BIGINT NOT NULL DEFAULT 0;
    `);
  }
}
