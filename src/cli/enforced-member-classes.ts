/**
 * GST-2476 G2: the allow-list of an enforced member CLI (GBRAIN_ENFORCED_MEMBER). Every CLI command and every
 * operation has exactly one class; anything absent is refused (test/enforced-member-classes.test.ts fails when a
 * command or operation has none).
 *
 * - read: read-filtered. The operation runs as the in-process stdio MCP server bound to the member would answer it
 *   (remote: true, the member's readers and folder rules, privacy always hidden).
 * - write: write-checked. A trusted local write (ctx.remote false, landing exactly where and as visible as it lands
 *   without the mode), after the gate refuses a target page the member cannot read and every label change.
 * - allowed: an operation the member's launcher runs (sync, a source refresh, git commit-push --pull) with its output
 *   replaced by one constant line, doctor with only check names, statuses and counts, or an offline command (errors,
 *   protocol).
 * - silent: hook only. Nothing on stdout, the constant stderr line, exit 0: harness hooks run in group turns and must
 *   not fail them; the one deliberate exception to "anything unlisted exits non-zero".
 * - refused: everything else.
 */
export type EnforcedClass = 'read' | 'write' | 'allowed' | 'silent' | 'refused';

/** A command whose subcommands differ: the first positional picks the class, default covers the rest. */
export interface EnforcedSubcommands {
  default: EnforcedClass;
  sub: Readonly<Record<string, EnforcedClass>>;
}

const READ_OPS = [
  'search', 'query', 'search_exact', 'list_pages', 'find_pages', 'get_page', 'get_backlinks', 'get_timeline', 'get_links',
  'get_tags', 'get_versions', 'get_stats', 'whoami', 'entity', 'whois', 'traverse_graph',
] as const;

const WRITE_OPS = [
  'put_page', 'edit_page', 'append_page', 'add_link', 'remove_link', 'add_tag', 'remove_tag',
  'add_timeline_entry', 'remember', 'get_write_request',
] as const;

/** Operations the mode refuses: admin and local-only surfaces, label and batch writes, and reads without a leak test. */
const REFUSED_OPS = [
  // reads not yet covered by a no-trace test (each can move to READ_OPS with one)
  'assemble_evidence', 'chronicle_day', 'chronicle_last_seen', 'chronicle_on_this_day', 'chronicle_since', 'context_pack',
  'delta', 'entity_identity_list', 'extraction_pending', 'fetch', 'find_contradictions', 'find_trajectory',
  'get_active_schema_pack', 'get_brain_health', 'get_brain_identity', 'get_calibration_profile', 'get_chunks',
  'get_ingest_log', 'get_memory_settings', 'get_raw_data', 'get_skill', 'get_skill_asset', 'join_brain', 'leave_brain',
  'list_brain_skillpack', 'list_link_sources', 'list_schema_packs', 'list_skills', 'list_write_conflicts',
  'memory_recall', 'ontology_conflicts', 'ontology_dimensions', 'ontology_get', 'open_loops', 'questions_list',
  'questions_status', 'rank_entities', 'recall', 'request_tools', 'resolve_slugs', 'schema_explain_type', 'schema_graph',
  'schema_lint', 'schema_review_orphans', 'schema_stats', 'search_by_image', 'search_modes', 'sync_brain_skills',
  'synthesize', 'takes_calibration', 'takes_list', 'takes_scorecard', 'takes_search', 'volunteer_chronicle',
  'volunteer_context', 'wanted_pages', 'storage_find', 'storage_get', 'storage_list',
  // hidden operations: no CLI path reaches them (their CLI names are CLI-only commands or gbrain call)
  'advisor', 'code_blast', 'code_callees', 'code_callers', 'code_def', 'code_flow', 'code_refs', 'find_anomalies',
  'find_experts', 'find_orphans', 'get_recent_salience', 'sources_list', 'sources_resolve_path', 'sources_status', 'think',
  'capture', 'list_page_purges', 'list_watches', 'purge_fact', 'unpurge_page', 'unwatch', 'watch_job', 'connectors_status',
  'get_recent_transcripts', 'sources_inspect', 'sources_add', 'sources_remove', 'connector_sync',
  'code_traversal_cache_clear', 'migrate_embeddings', 'purge_deleted_pages', 'sync_brain',
  // writes outside the checked set: batch, upload, label, history, fact and queue writes
  'abort_page_upload', 'begin_page_upload', 'commit_page_upload', 'get_page_upload', 'upload_page_part', 'put_pages',
  'put_raw_data', 'put_skill', 'delete_skill', 'delete_page', 'restore_page', 'revert_version', 'cancel_write_request',
  'list_write_requests', 'confirm_memory', 'extract_entities', 'extract_facts', 'forget',
  'forget_fact', 'log_ingest', 'loops_close', 'loops_mute', 'loops_unmute', 'memory_conversation_mode', 'memory_propose',
  'memory_write', 'mute_notice', 'ontology_propose', 'questions_pin', 'questions_refresh', 'questions_unpin', 'rate_answer',
  'takes_add', 'takes_resolve', 'takes_supersede', 'takes_update', 'entity_identity_link', 'entity_identity_unlink',
  'extraction_review', 'takes_rebuild', 'takes_remove',
  // admin, agent and local-only
  'cache_stats', 'cancel_job', 'get_health', 'get_job', 'get_job_progress', 'get_job_stats', 'get_skill_policy',
  'get_status_snapshot', 'get_usage', 'get_write_attribution', 'list_jobs', 'pause_job', 'quarantine_list',
  'reload_schema_pack', 'replay_job', 'resume_job', 'retry_job', 'run_doctor', 'run_onboard', 'run_skillopt',
  'schema_apply_mutations', 'search_stats', 'search_tune', 'send_job_message', 'set_memory_writeback', 'set_skill_policy',
  'submit_job', 'wait_job', 'chronicle_backfill', 'file_list', 'file_register', 'file_upload', 'file_url', 'file_verify',
  'get_skill_retention', 'import_skill_proposal', 'prune_skill_revisions', 'retain_skill_revision', 'get_agent_job',
  'submit_agent', 'storage_register', 'storage_update',
] as const;

export const OPERATION_CLASSES: Readonly<Record<string, EnforcedClass>> = Object.freeze(Object.fromEntries([
  ...READ_OPS.map(n => [n, 'read'] as const),
  ...WRITE_OPS.map(n => [n, 'write'] as const),
  ...REFUSED_OPS.map(n => [n, 'refused'] as const),
]));

/** Classified operations whose arguments narrow the class further (checked by the gate after parsing). */
export const ARGUMENT_CONDITIONS: Readonly<Record<string, string>> = {
  get_stats: 'only with --by (grouped counts under the member filter); the plain brain-wide counters are refused',
  remember: 'only one fact with --entity naming the exact slug of a page the member reads; --items, --visibility, --share and --replaces are refused',
  add_timeline_entry: 'no gbrain fence marker in the summary, detail or source',
  get_write_request: "only the member's own receipts (writes this mode accepted for it, recorded on this machine); any other id answers exactly as an unknown id",
};

/** Arguments of classified CLI-only commands the mode refuses. */
export const CLI_ARGUMENT_CONDITIONS: Readonly<Record<string, string>> = {
  recall: 'the facts arms (entity, --since, --question, --grep, --query) and the page arm; --pending, --supersessions, --session, --watch and --since-last-run are refused',
  'git commit-push': 'named paths (each readable by the member, no label change, no access policy file), --dry-run and --pull; --pending, --push-only, --resolve, --untrack and --allow-outside-source-root are refused; output withheld',
  sync: 'only --source <id> (a source the member reads), --no-pull, --no-embed, --json and --dry-run; output withheld; sync status and every other flag or subcommand are refused',
  'sources refresh': 'exactly one source id the member reads, with --json or --dry-run only; output withheld; every other sources subcommand (status and writer status name held paths) is refused',
  doctor: 'plain doctor or doctor --json only; output replaced by each check name and status and the count per status',
};

/** Every CLI-only command (src/cli/command-table.ts) by class; a command with mixed subcommands lists them. */
export const CLI_COMMAND_CLASSES: Readonly<Record<string, EnforcedClass | EnforcedSubcommands>> = {
  errors: 'allowed',
  protocol: 'allowed',
  sync: { default: 'allowed', sub: { status: 'refused' } },
  sources: { default: 'refused', sub: { refresh: 'allowed' } },
  git: { default: 'refused', sub: { 'commit-push': 'write' } },
  recall: 'read',
  hook: 'silent',
  doctor: 'allowed',
  ...Object.fromEntries([
    'schema', 'bundled-skill', 'skill-resolver', 'notices', 'init', 'bench', 'reinit-pglite', 'embeddings', 'pglite-repair',
    'engine', 'db-repair', 'auth', 'google', 'creds', 'remote', 'connect', 'setup', 'bootstrap', 'backup', 'upgrade',
    'post-upgrade', 'check-update', 'self-upgrade', 'integrations', 'providers', 'resolvers', 'integrity', 'publish',
    'check-backlinks', 'frontmatter', 'lint', 'check-resolvable', 'mounts', 'cache', 'routing-eval', 'skillify', 'skillpack',
    'friction', 'claw-test', 'report', 'apply-migrations', 'repair-jsonb', 'skillpack-check', 'compile-context',
    'smoke-test', 'dream', 'decide', 'facts', 'projections', 'append', 'capture', 'forget', 'call', 'mcp', 'import', 'access',
    'export', 'files', 'embed', 'serve', 'sweep', 'config', 'pricing', 'migrate', 'retrieval-upgrade', 'eval', 'jobs', 'agent',
    'book-mirror', 'extract', 'extract-conversation-facts', 'enrich', 'features', 'autopilot', 'graph-query',
    'reconcile-links', 'repair', 'diag', 'orphans', 'maintain', 'reindex', 'salience', 'anomalies', 'feedback', 'status',
    'advisor', 'conversation-parser', 'edges-backfill', 'whoknows', 'brainstorm', 'lsd', 'skillopt', 'calibration',
    'transcripts', 'models', 'takes', 'onboard', 'founder', 'think', 'notability-eval', 'waiting', 'loops',
    'questions', 'edge-proposals', 'memory-proposals', 'core', 'connectors', 'wakeshift', 'pages', 'quarantine', 'beliefs',
    'trust', 'watch', 'storage', 'code-def', 'code-refs', 'reindex-code', 'reindex-search-vector', 'reindex-frontmatter',
    'backfill', 'code-callers', 'code-callees', 'repos',
  ].map(n => [n, 'refused' as const])),
};

/** Subcommands of operation-backed commands that run something other than the operation. */
export const OPERATION_SUBCOMMANDS: Readonly<Record<string, EnforcedSubcommands>> = {
  search: { default: 'read', sub: { modes: 'refused', stats: 'refused', tune: 'refused', diagnose: 'refused' } },
};

function subcommandClass(spec: EnforcedClass | EnforcedSubcommands, args: readonly string[]): EnforcedClass {
  if (typeof spec === 'string') return spec;
  const first = args.find(a => !a.startsWith('-'));
  return (first !== undefined ? spec.sub[first] : undefined) ?? spec.default;
}

/** The class of a dispatched command: its CLI-only record, else the operation it names (by CLI name or alias). */
export function enforcedClassOf(command: string, args: readonly string[], opName: string | undefined): EnforcedClass {
  const cli = CLI_COMMAND_CLASSES[command];
  if (cli !== undefined) return subcommandClass(cli, args);
  const opClass = opName === undefined ? 'refused' : OPERATION_CLASSES[opName] ?? 'refused';
  const sub = OPERATION_SUBCOMMANDS[command];
  return sub && opClass !== 'refused' ? subcommandClass(sub, args) : opClass;
}
