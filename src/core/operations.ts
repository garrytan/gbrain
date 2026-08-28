/**
 * Contract-first operation definitions. Single source of truth for CLI, MCP, and tools-json.
 * Each operation defines its schema, handler, and optional CLI hints.
 */

import { verbOperations, MEMORY_VERBS_VERSION } from './verbs.ts';
export { MEMORY_VERBS_VERSION };

// --- Foundation (pure move, v0.46.x): the contract types + error envelope live
// in ops/contract.ts; the validators, slug fences, and source-scope resolvers
// live in ops/context.ts. Re-exported so every existing importer of
// operations.ts is unchanged.

import type { Operation } from './ops/contract.ts';

// Re-exports: the full previously-exported foundation surface of this module.
// The formerly file-private helpers (enforceSubagentSlugFence, slugUnderSubagentFence,
// slugOutsideCallerFence, enforceClientSlugFence, BOUND_CLIENT_META_OPS,
// stampEvidenceSafe, maybeCaptureSearch) are deliberately NOT re-exported —
// they were never part of this module's surface; import them from ops/context.ts.
export { OperationError, verbError } from './ops/contract.ts';
export type {
  ErrorCode,
  ParamDef,
  Logger,
  AuthInfo,
  OperationContext,
  Operation,
} from './ops/contract.ts';
export {
  validateUploadPath,
  validatePageSlug,
  matchesSlugAllowList,
  slugUnderBoundPrefixes,
  normalizeSlugPrefix,
  CLIENT_FENCED_WRITE_OPS,
  opAllowedForBoundClient,
  enforceBoundClientOpAllowList,
  validateFilename,
  sourceScopeOpts,
  thinkSourceScopeOpts,
  linkReadScopeOpts,
  resolveRequestedScope,
  federatedSearchScope,
  resolveCodeIntelScope,
  resolvePerCallMode,
} from './ops/context.ts';

// --- Tranche 1 (pure move, v0.46.x): the Page CRUD, Search (search/query),
// Takes+think, Tags, Links+graph, and Timeline op clusters live in
// ops/pages.ts, ops/search.ts, ops/takes.ts, ops/tags.ts, ops/links.ts, and
// ops/timeline.ts. Their ordered arrays are spliced into the canonical
// `operations` array below at the clusters' original positions (order is
// contractual — docs/TOOL_CATALOG.md is generated from it).

import { pagesOperations } from './ops/pages.ts';
import { searchOperations } from './ops/search.ts';
import { takesOperations } from './ops/takes.ts';
import { tagsOperations } from './ops/tags.ts';
import { linksOperations } from './ops/links.ts';
import { timelineOperations } from './ops/timeline.ts';

// MANAGED_LINK_SOURCES moved to ops/links.ts with the add_link op; re-exported
// so every existing importer of operations.ts is unchanged.
export { MANAGED_LINK_SOURCES } from './ops/links.ts';

// --- Tranche 2 (pure move, v0.46.x): the Admin, skill-catalog (+advisor/
// status-snapshot), Sync, Raw Data, Resolution & Chunks, Ingest Log, File
// Operations, Jobs (Minions + agent lane), Orphans, calibration, and
// Salience + Anomaly op clusters live in ops/admin.ts, ops/skills-catalog.ts,
// ops/sync-status.ts, ops/raw-data.ts, ops/chunks.ts, ops/ingest-log.ts,
// ops/files.ts, ops/jobs.ts, ops/orphans.ts, ops/calibration.ts, and
// ops/salience.ts. Their ordered arrays are spliced into the canonical
// `operations` array below at the clusters' original positions (order is
// contractual — docs/TOOL_CATALOG.md is generated from it).

import { adminOperations } from './ops/admin.ts';
import { skillsCatalogOperations } from './ops/skills-catalog.ts';
import { syncStatusOperations } from './ops/sync-status.ts';
import { rawDataOperations } from './ops/raw-data.ts';
import { chunksOperations } from './ops/chunks.ts';
import { ingestLogOperations } from './ops/ingest-log.ts';
import { usageOperations } from './ops/usage.ts';
import { filesOperations } from './ops/files.ts';
import { jobsOperations } from './ops/jobs.ts';
import { orphansOperations } from './ops/orphans.ts';
import { calibrationOperations } from './ops/calibration.ts';
import { salienceOperations } from './ops/salience.ts';

// --- Tranche 3 (pure move, v0.46.x): the remaining inline clusters live in
// ops/insights.ts (push-based volunteer_context + the find_* insight reads —
// exported individually because their array slots are non-adjacent),
// ops/transcripts.ts, ops/sources.ts, ops/facts.ts, ops/code-intel.ts,
// ops/embedding-migration.ts, ops/image.ts, ops/schema-packs.ts,
// ops/skillopt.ts, ops/chronicle.ts, ops/extraction.ts, and
// ops/request-tools.ts. Their ordered arrays / ops are spliced into the
// canonical `operations` array below at the clusters' original positions
// (order is contractual — docs/TOOL_CATALOG.md is generated from it).

import { volunteer_context, find_experts, find_contradictions, find_trajectory } from './ops/insights.ts';
import { transcriptsOperations } from './ops/transcripts.ts';
import { connectorsOperations } from './ops/connectors.ts';
import { sourcesOperations } from './ops/sources.ts';
import { factsOperations } from './ops/facts.ts';
import { codeIntelOperations } from './ops/code-intel.ts';
import { embeddingMigrationOperations } from './ops/embedding-migration.ts';
import { imageOperations } from './ops/image.ts';
import { schemaPacksOperations } from './ops/schema-packs.ts';
import { skilloptOperations } from './ops/skillopt.ts';
import { loopsOperations } from './ops/loops.ts';
import { chronicleOperations } from './ops/chronicle.ts';
import { extractionOperations } from './ops/extraction.ts';
import { entityIdentityOperations } from './ops/entity-identity.ts';
import { requestToolsOperations } from './ops/request-tools.ts';

// parseTtlParam moved to ops/facts.ts with the facts cluster; the `remember`
// verb (verbs.ts) loads it from THIS module at runtime — re-exported so every
// existing importer of operations.ts is unchanged.
export { parseTtlParam } from './ops/facts.ts';
// The request_tools persist-limiter test seam moved with its cluster —
// re-exported for the same reason.
export { __resetRequestToolsPersistLimiterForTests } from './ops/request-tools.ts';

export const operations: Operation[] = [
  // MEMORY_VERBS v1 (Cathedral 1) — remember/entity/synthesize/forget live in
  // verbs.ts; the remaining three of the seven verbs (the extended `recall`,
  // plus the v0.45.x boundary verbs `context_pack`/`delta`) are defined below.
  // Spread first so `--surface verbs` agents see them at the top of the list.
  ...verbOperations,
  // Page CRUD (get_page, put_page, delete_page, list_pages + the v0.26.5
  // destructive-guard ops restore_page, purge_deleted_pages) — ops/pages.ts
  ...pagesOperations,
  // Search (search, query) — ops/search.ts
  ...searchOperations,
  // v0.36 Phase 2: image-as-query (search_by_image) — ops/image.ts
  ...imageOperations,
  // Tags (add_tag, remove_tag, get_tags) — ops/tags.ts
  ...tagsOperations,
  // Links (add_link, remove_link, get_links, get_backlinks,
  // list_link_sources, traverse_graph) — ops/links.ts
  ...linksOperations,
  // Timeline (add_timeline_entry, get_timeline) — ops/timeline.ts
  ...timelineOperations,
  // Admin (get_stats, get_health, run_doctor, get_versions, revert_version
  // + the v0.31.1 banner packet get_brain_identity) — ops/admin.ts
  ...adminOperations,
  // PR1: skill catalog over MCP (list_skills, get_skill, list_brain_skillpack,
  // advisor) + v0.41.19.0 get_status_snapshot — ops/skills-catalog.ts
  ...skillsCatalogOperations,
  // Sync (sync_brain) — ops/sync-status.ts
  ...syncStatusOperations,
  // Raw data (put_raw_data, get_raw_data) — ops/raw-data.ts
  ...rawDataOperations,
  // Resolution & chunks (resolve_slugs, get_chunks) — ops/chunks.ts
  ...chunksOperations,
  // Ingest log (log_ingest, get_ingest_log) — ops/ingest-log.ts
  ...ingestLogOperations,
  // Usage accounting (get_usage, #4218) — ops/usage.ts
  ...usageOperations,
  // Files (file_list, file_upload, file_url) — ops/files.ts
  ...filesOperations,
  // Jobs (Minions: submit_job, get_job, list_jobs, cancel_job, retry_job,
  // get_job_progress, pause_job, resume_job, replay_job, send_job_message)
  // + v0.38 Slice 3 agent lane (submit_agent, get_agent_job) — ops/jobs.ts
  ...jobsOperations,
  // Orphans (find_orphans) — ops/orphans.ts
  ...orphansOperations,
  // v0.36.1.0 (T7) — Hindsight calibration wave (get_calibration_profile) —
  // ops/calibration.ts
  ...calibrationOperations,
  // v0.28: Takes + think (takes_list, takes_search, think) + v0.30
  // calibration aggregates (takes_scorecard, takes_calibration) — ops/takes.ts
  ...takesOperations,
  // v0.28: whoami + scoped sources management — ops/sources.ts
  ...sourcesOperations,
  // WP4 (T9): discovery + pull-based per-client surface unlock (D4/D5/D9) —
  // ops/request-tools.ts
  ...requestToolsOperations,
  // v0.29: Salience + anomalies (get_recent_salience, find_anomalies —
  // ops/salience.ts) + recent transcripts (ops/transcripts.ts)
  ...salienceOperations, ...transcriptsOperations, ...connectorsOperations,
  // v0.42.x (#2390): Life Chronicle timeline reads + ontology +
  // volunteer_chronicle/backfill — ops/chronicle.ts
  ...chronicleOperations,
  // v0.43 (#2095): push-based context — ops/insights.ts
  volunteer_context,
  // Extraction quarantine lane (#160): gated entity extraction + review
  // queue — ops/extraction.ts
  ...extractionOperations,
  // #4224: cross-source entity identity groups (v1 manual-only) —
  // ops/entity-identity.ts
  ...entityIdentityOperations,
  // v0.31: hot memory (extract_facts, recall, context_pack, delta,
  // forget_fact) — ops/facts.ts
  ...factsOperations,
  // v0.32.6: contradiction probe MCP surface (M3) — ops/insights.ts
  find_contradictions,
  // v0.33: expertise + relationship-proximity routing — ops/insights.ts
  find_experts,
  // v0.35.4: temporal trajectory (typed claims over time + regression
  // detection) — ops/insights.ts
  find_trajectory,
  // v0.33.3 Cathedral III code-intelligence + v0.34 W3 code_blast/code_flow
  // + W3b cache-clear — ops/code-intel.ts
  ...codeIntelOperations,
  // #3390: provider-agnostic embedding migration (local-only admin) —
  // ops/embedding-migration.ts
  ...embeddingMigrationOperations,
  // v0.40.6.0 Schema Cathedral v3: 9 ops — 7 read + 2 admin —
  // ops/schema-packs.ts
  ...schemaPacksOperations,
  // v0.41.18.0 run_onboard + v0.41.20.0 run_skillopt — ops/skillopt.ts
  ...skilloptOperations,
  // v0.47: open-loop engine (who is waiting on you) — ops/loops.ts
  ...loopsOperations,
];

// ---------------------------------------------------------------------------
// WP4 (amendment 22) — area taxonomy.
//
// One central map (single reviewable block) rather than 100+ scattered inline
// fields. Area NAMES ARE NON-CONTRACTUAL: they group the request_tools
// catalog and the generated tool-catalog doc; renaming or regrouping is never
// a breaking change. Every non-localOnly op MUST have an area — enforced by
// the CI walker in test/mcp-tool-defs.test.ts, so a future op missing from
// this map fails at PR time. localOnly ops are covered too (harmless; the
// walker only requires non-localOnly). Ops that declare `area` inline
// (request_tools) win over this map.
// ---------------------------------------------------------------------------
const OP_AREAS: Record<string, string> = {
  // memory verbs (the frozen protocol facade)
  recall: 'memory-verbs', remember: 'memory-verbs', entity: 'memory-verbs',
  synthesize: 'memory-verbs', forget: 'memory-verbs',
  context_pack: 'memory-verbs', delta: 'memory-verbs',
  // pages (CRUD, versions, raw payloads, resolution)
  get_page: 'pages', put_page: 'pages', delete_page: 'pages', list_pages: 'pages',
  restore_page: 'pages', purge_deleted_pages: 'pages',
  get_versions: 'pages', revert_version: 'pages',
  resolve_slugs: 'pages', get_chunks: 'pages',
  put_raw_data: 'pages', get_raw_data: 'pages',
  fetch: 'pages', // #4039 deep-research read adapter (search/fetch pair)
  // search
  search: 'search', query: 'search', search_by_image: 'search',
  // tags
  add_tag: 'tags', remove_tag: 'tags', get_tags: 'tags',
  // links + graph
  add_link: 'links', remove_link: 'links', get_links: 'links',
  get_backlinks: 'links', list_link_sources: 'links', traverse_graph: 'links',
  find_orphans: 'links',
  // timeline
  add_timeline_entry: 'timeline', get_timeline: 'timeline',
  // life chronicle
  chronicle_day: 'chronicle', chronicle_on_this_day: 'chronicle',
  chronicle_since: 'chronicle', chronicle_last_seen: 'chronicle',
  volunteer_chronicle: 'chronicle', chronicle_backfill: 'chronicle',
  // ontology
  ontology_get: 'ontology', ontology_propose: 'ontology',
  ontology_dimensions: 'ontology', ontology_conflicts: 'ontology',
  // admin + operations
  get_stats: 'admin', get_health: 'admin', run_doctor: 'admin',
  get_status_snapshot: 'admin', run_onboard: 'admin', run_skillopt: 'admin',
  migrate_embeddings: 'admin', code_traversal_cache_clear: 'admin',
  // identity
  whoami: 'identity', get_brain_identity: 'identity',
  // skills
  list_skills: 'skills', get_skill: 'skills', list_brain_skillpack: 'skills',
  // advisor
  advisor: 'advisor',
  // sources
  sources_add: 'sources', sources_list: 'sources', sources_remove: 'sources',
  sources_status: 'sources',
  // sync (localOnly)
  sync_brain: 'sync',
  // ingest log
  log_ingest: 'ingest', get_ingest_log: 'ingest',
  get_usage: 'admin',
  // files (localOnly)
  file_list: 'files', file_upload: 'files', file_url: 'files',
  // jobs (Minions + agent lane)
  submit_job: 'jobs', get_job: 'jobs', list_jobs: 'jobs', cancel_job: 'jobs',
  retry_job: 'jobs', get_job_progress: 'jobs', pause_job: 'jobs',
  resume_job: 'jobs', replay_job: 'jobs', send_job_message: 'jobs',
  submit_agent: 'jobs', get_agent_job: 'jobs',
  // takes + think
  takes_list: 'takes', takes_search: 'takes', think: 'takes',
  takes_scorecard: 'takes', takes_calibration: 'takes',
  // hot memory (facts)
  extract_facts: 'memory', forget_fact: 'memory',
  // entity extraction lane
  extract_entities: 'entities', extraction_pending: 'entities',
  extraction_review: 'entities',
  // #4224 cross-source entity identity (v1 manual-only)
  entity_identity_link: 'entities', entity_identity_unlink: 'entities',
  entity_identity_list: 'entities',
  // v0.47 open-loop engine (google source kind)
  open_loops: 'loops', loops_close: 'loops', loops_mute: 'loops',
  // insight / signal reads
  get_recent_salience: 'insights', find_anomalies: 'insights',
  find_contradictions: 'insights', find_experts: 'insights',
  find_trajectory: 'insights', get_calibration_profile: 'insights',
  volunteer_context: 'insights', get_recent_transcripts: 'insights',
  // code intelligence
  code_callers: 'code', code_callees: 'code', code_def: 'code',
  code_refs: 'code', code_blast: 'code', code_flow: 'code',
  // schema packs
  get_active_schema_pack: 'schema', list_schema_packs: 'schema',
  schema_stats: 'schema', schema_lint: 'schema', schema_graph: 'schema',
  schema_explain_type: 'schema', schema_review_orphans: 'schema',
  schema_apply_mutations: 'schema', reload_schema_pack: 'schema',
  // discovery
  request_tools: 'discovery',
};
for (const op of operations) {
  if (op.area === undefined && OP_AREAS[op.name] !== undefined) {
    op.area = OP_AREAS[op.name];
  }
}

export const operationsByName = Object.fromEntries(
  operations.map(op => [op.name, op]),
) as Record<string, Operation>;
