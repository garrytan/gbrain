/**
 * The one finalize step every operation gets before it runs (central area
 * taxonomy + output redaction wrapper), and the CLI's per-op loader.
 *
 * src/core/operations.ts finalizes the whole registry as it loads. The CLI
 * runs exactly one op per process, so loadOperation() imports only the module
 * that defines it (src/core/operation-loaders.generated.ts) and finalizes that
 * one op the same way, keeping the rest of the handler graph off the
 * cold-start path. Finalizing is idempotent per op object, so a process
 * that later loads operations.ts sees the same objects in the same state.
 */
import type { Operation } from './ops/contract.ts';
import { withOutputRedaction } from './search/output-redaction.ts';
import { OPERATION_LOADERS } from './operation-loaders.generated.ts';

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
  search: 'search', query: 'search', search_by_image: 'search', assemble_evidence: 'search',
  // tags
  add_tag: 'tags', remove_tag: 'tags', get_tags: 'tags',
  // links + graph
  add_link: 'links', remove_link: 'links', get_links: 'links',
  get_backlinks: 'links', list_link_sources: 'links', traverse_graph: 'links',
  find_orphans: 'links',
  wanted_pages: 'links',
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
  get_stats: 'admin', get_health: 'admin', run_doctor: 'admin', mute_notice: 'admin',
  get_status_snapshot: 'admin', run_onboard: 'admin', run_skillopt: 'admin',
  migrate_embeddings: 'admin', code_traversal_cache_clear: 'admin', get_write_attribution: 'admin',
  // identity
  whoami: 'identity', get_brain_identity: 'identity',
  // skills
  list_skills: 'skills', get_skill: 'skills', list_brain_skillpack: 'skills',
  get_skill_asset: 'skills', put_skill: 'skills', delete_skill: 'skills',
  get_skill_policy: 'skills', set_skill_policy: 'skills', import_skill_proposal: 'skills',
  get_skill_retention: 'skills', prune_skill_revisions: 'skills', retain_skill_revision: 'skills',
  join_brain: 'skills', sync_brain_skills: 'skills', leave_brain: 'skills',
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
  extract_facts: 'memory', forget_fact: 'memory', confirm_memory: 'memory',
  // entity extraction lane
  extract_entities: 'entities', extraction_pending: 'entities',
  extraction_review: 'entities',
  // #4224 cross-source entity identity (v1 manual-only)
  entity_identity_link: 'entities', entity_identity_unlink: 'entities',
  entity_identity_list: 'entities',
  // v0.47 open-loop engine (google source kind)
  open_loops: 'loops', loops_close: 'loops', loops_mute: 'loops', loops_unmute: 'loops',
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

const finalized = new WeakSet<Operation>();

export function finalizeOperation(op: Operation): void {
  if (finalized.has(op)) return;
  finalized.add(op);
  if (op.area === undefined && OP_AREAS[op.name] !== undefined) {
    op.area = OP_AREAS[op.name];
  }
  op.handler = withOutputRedaction(op);
}

/** The finalized operation named `name`, loading only the module that defines it. */
export async function loadOperation(name: string): Promise<Operation | undefined> {
  const entry = OPERATION_LOADERS[name];
  if (!entry) return undefined;
  const [load, exportName] = entry;
  const exported = (await load())[exportName] as Operation | Operation[];
  const op = Array.isArray(exported) ? exported.find(o => o.name === name) : exported;
  if (op) finalizeOperation(op);
  return op;
}
