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
import { finalizeOperation } from './operation-load.ts';
import { registerOpRoutes } from './fix-routing.ts';

// Re-exports: the full previously-exported foundation surface of this module.
// The formerly file-private helpers (enforceSubagentSlugFence, slugUnderSubagentFence,
// slugOutsideCallerFence, enforceClientSlugFence, BOUND_CLIENT_META_OPS,
// stampEvidenceSafe, maybeCaptureSearch) are deliberately NOT re-exported —
// they were never part of this module's surface; import them from ops/context.ts.
export { OperationError, verbError, opError } from './ops/contract.ts';
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
import { persistenceOperations } from './ops/persistence.ts';
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
import { attributionOperations } from './ops/attribution.ts';
import { skillsCatalogOperations } from './ops/skills-catalog.ts';
import { brainMembershipOperations } from './ops/brain-membership.ts';
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
import { purgeOperations } from './ops/purge.ts';
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
import { noticesOperations } from './ops/notices.ts';
import { pageEditOperations } from './ops/page-edit.ts';
import { pageBatchOperations } from './ops/page-batch.ts';
import { feedbackOperations } from './ops/feedback.ts';
import { trustOperations } from './ops/trust.ts';

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
  ...pagesOperations, ...pageEditOperations, ...pageBatchOperations,
  ...persistenceOperations,
  // Search (search, query) — ops/search.ts
  ...searchOperations,
  ...feedbackOperations,
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
  // + get_brain_identity) — ops/admin.ts; get_write_attribution — ops/attribution.ts; confirm_memory — ops/trust.ts
  ...adminOperations, ...attributionOperations, ...trustOperations,
  // PR1: skill catalog over MCP (list_skills, get_skill, list_brain_skillpack,
  // advisor) + v0.41.19.0 get_status_snapshot — ops/skills-catalog.ts
  ...skillsCatalogOperations,
  ...brainMembershipOperations,
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
  ...factsOperations, ...purgeOperations,
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
  ...loopsOperations, ...noticesOperations, // + agent contract v1 A6 mute_notice — ops/notices.ts
];

// Area taxonomy + output redaction: one finalize step shared with the CLI's
// per-op loader (src/core/operation-load.ts).
for (const op of operations) finalizeOperation(op);

export const operationsByName = Object.fromEntries(
  operations.map(op => [op.name, op]),
) as Record<string, Operation>;
registerOpRoutes(operations); // A1 render-time routing pin (src/core/fix-routing.ts)
