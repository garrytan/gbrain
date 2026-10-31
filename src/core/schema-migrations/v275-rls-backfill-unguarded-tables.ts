import type { Migration } from './types.ts';
import type { BrainEngine } from '../engine.ts';
import { migrationStatementTimeoutMs } from '../migration-timeout.ts';
import { isLockTimeoutError } from '../retry-matcher.ts';
import { resolveSchemaLockTimeoutMs, schemaLockBlockedError } from '../postgres-engine/schema-lock-timeout.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// RLS backfill on Postgres for every table gbrain creates. Supabase grants anon
// and authenticated default privileges on public tables, so a table left
// without RLS is readable and writable with the anon key whenever the Data API
// is on. A table could be left without it because its RLS came from a path that
// does not run on every brain:
// - the schema blob's RLS blocks, which only a full initSchema replays:
//   `gbrain apply-migrations --yes` runs migrations without the blob (v273's
//   four tables, and page_derivation_spend was missing from the blob's list);
// - v35's auto-RLS event trigger, which needs a superuser to create and is
//   absent or inert on managed brains that never had it or lost it (a dump
//   restore does not carry it): every table created after that without its own
//   RLS block came up with RLS off there.
// TABLES is every table a fresh install creates, frozen at this migration; a
// later migration that creates a table enables RLS itself
// (test/e2e/rls-every-table-postgres.test.ts fails otherwise).
// Same posture as the blob's RLS blocks and v35's backfill: ENABLE only (no
// FORCE, no policies), only for a table still without RLS (ENABLE takes an
// ACCESS EXCLUSIVE lock even when RLS is on, #5227), never for a table carrying
// the GBRAIN:RLS_EXEMPT comment doctor honors, and only under a role that
// bypasses RLS and owns the table. Under any other role, enabling RLS would
// lock the runtime role out of its own rows or fail on ownership, and raising
// would hold every later migration back (#3603), so the table is skipped and
// named on stderr; doctor's rls check keeps failing with the fix until it is
// done. Each table is its own short transaction with the migration's
// transaction-local statement and lock timeouts (safe behind a transaction
// pooler), so no lock is held while the next one waits. Both the public table
// (what the Data API serves) and the relation gbrain's unqualified statements
// resolve to through the search path are covered. Flag change only: no row is
// read or written. PGLite has no role system and enforces no RLS: no-op.
const TABLES = [
  'access_tokens', 'belief_commit_marks', 'belief_events', 'belief_page_lifetimes', 'belief_redactions',
  'belief_retier_manifest', 'budget_ledger', 'budget_reservations', 'calibration_profiles', 'chat_usage_log',
  'chronicle_judge_reservations', 'chronicle_page_state', 'code_edges_chunk', 'code_edges_symbol',
  'code_traversal_cache', 'config', 'content_chunks', 'context_volunteer_events', 'conversation_parser_llm_cache',
  'core_edit_notices', 'decide_calibrations', 'decide_proposals', 'decide_review_proposals', 'decide_review_queue',
  'decide_spend', 'decide_state', 'decide_sweep_deferred', 'decision_receipts', 'derivation_inputs',
  'derived_generation_activations', 'derived_generation_attempts', 'derived_generation_items',
  'derived_generation_valve', 'derived_generations', 'dream_synthesis_completions', 'dream_verdicts',
  'drift_decisions', 'entity_identities', 'eval_candidates', 'eval_capture_failures', 'eval_contradictions_cache',
  'eval_contradictions_runs', 'eval_takes_quality_runs', 'extract_atoms_page_state',
  'extract_atoms_transcript_state', 'extract_rollup_7d', 'fact_purges', 'fact_relink_attempts', 'fact_withdrawals',
  'facts', 'file_migration_ledger', 'files', 'gbrain_cycle_locks', 'git_canonical_brain', 'ingest_log',
  'link_edge_proposals', 'link_relationships', 'link_transitions', 'links', 'loop_suppressions', 'mcp_request_log',
  'mcp_spend_log', 'mcp_spend_reservations', 'mention_gazetteer_entries', 'mention_index_status',
  'migration_impact_log', 'minion_attachments', 'minion_budget_log', 'minion_inbox', 'minion_jobs',
  'minion_lease_pressure_log', 'minion_self_fix_log', 'needs_rederive', 'oauth_clients', 'oauth_codes',
  'oauth_grant_audit', 'oauth_tokens', 'op_checkpoint_paths', 'op_checkpoints', 'open_loops', 'page_aliases',
  'page_body_manifest', 'page_body_staging_parts', 'page_body_staging_texts', 'page_body_stagings',
  'page_derivation_spend', 'page_embedding_budget', 'page_extraction_state', 'page_facts_reconcile',
  'page_generation_clock', 'page_mention_state', 'page_projection_jobs', 'page_purges', 'page_retrievals',
  'page_segment_derivation_purge_pages', 'page_segment_derivation_purges', 'page_segment_derivations',
  'page_segment_texts', 'page_versions', 'page_view_digests', 'page_write_guards', 'pages', 'persistence_brain',
  'persistence_consumers', 'persistence_counters', 'persistence_effects', 'persistence_graduation',
  'persistence_host_bindings', 'persistence_local_writers', 'persistence_requests', 'persistence_source_bindings',
  'persistence_topology_changes', 'persistence_worktree_refreshes', 'persistence_worktrees',
  'persistence_writer_protocols', 'pinned_questions', 'query_cache', 'question_evidence', 'raw_data',
  'retrieval_event_links', 'retrieval_event_pages', 'retrieval_events', 'retrieval_feedback', 'retrieval_weights',
  'search_telemetry', 'session_context_state', 'shared_skill_delivery_batches', 'shared_skill_heads',
  'shared_skill_members', 'shared_skill_packs', 'shared_skill_policies', 'shared_skill_policy_audit',
  'shared_skill_revision_leases', 'shared_skill_revisions', 'shared_skill_state', 'slug_aliases',
  'source_ingestion_receipts', 'sources', 'subagent_messages', 'subagent_rate_leases', 'subagent_tool_executions',
  'sync_notifier_leases', 'sync_notifier_sources', 'sync_wanted_markers', 'synthesis_evidence', 'tags',
  'take_domain_assignments', 'take_grade_cache', 'take_horizons', 'take_nudge_log', 'take_proposals', 'take_purges',
  'takes', 'think_ab_results', 'timeline_entries', 'trust_allow_rules', 'trust_policy_state', 'trust_proposals',
  'wanted_links', 'write_gate_holds', 'write_gate_receipts',
];

const EXEMPT_RE = String.raw`^GBRAIN:RLS_EXEMPT\s+reason=\S.{3,}`;

function enableRlsSql(oid: number): string {
  if (!Number.isSafeInteger(oid) || oid <= 0) throw new Error(`enableRlsSql: unexpected relation oid ${oid}`);
  return `DO $rls$
DECLARE
  rel REGCLASS := ${oid}::oid::regclass;
  t RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    RETURN;
  END IF;
  SELECT c.relkind, c.relrowsecurity, pg_has_role(current_user, c.relowner, 'USAGE') AS owned, COALESCE(obj_description(c.oid, 'pg_class'), '') AS note
    INTO t FROM pg_class c WHERE c.oid = rel;
  IF FOUND AND t.relkind = 'r' AND NOT t.relrowsecurity AND t.owned AND t.note !~ '${EXEMPT_RE}' THEN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', rel);
  END IF;
END $rls$;`;
}

/** The public relations and search-path relations named in `tables` that still lack RLS and are not exempt. */
async function relationsWithoutRls(engine: BrainEngine, tables: readonly string[]): Promise<Array<{ oid: number; name: string }>> {
  const rows = await engine.executeRaw<{ oid: number | string; name: string }>(
    `SELECT c.oid, c.oid::regclass::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND c.relname = ANY($1::text[]) AND (n.nspname = 'public' OR c.oid = to_regclass(quote_ident(c.relname)))
        AND NOT c.relrowsecurity AND COALESCE(obj_description(c.oid, 'pg_class'), '') !~ $2
      ORDER BY 2`, [tables, EXEMPT_RE]);
  return rows.map(r => ({ oid: Number(r.oid), name: r.name }));
}

/**
 * Enables RLS on the named gbrain tables where it is still off (Postgres; a no-op elsewhere), one transaction per
 * table, and names on stderr any the role could not protect. Returns those names.
 */
export async function protectTables(engine: BrainEngine, tables: readonly string[], label: string): Promise<string[]> {
  if (engine.kind !== 'postgres') return [];
  const lockTimeoutMs = resolveSchemaLockTimeoutMs();
  for (const rel of await relationsWithoutRls(engine, tables)) {
    try {
      await engine.transaction(async tx => {
        await tx.executeRaw(`SET LOCAL statement_timeout = '${migrationStatementTimeoutMs()}'`);
        await tx.executeRaw(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
        await tx.executeRaw(enableRlsSql(rel.oid));
      });
    } catch (error) {
      if (isLockTimeoutError(error)) throw schemaLockBlockedError({ step: `${label} on ${rel.name}`, timeoutMs: lockTimeoutMs, sessions: null, sampledDuringWait: false });
      throw error;
    }
  }
  const left = (await relationsWithoutRls(engine, tables)).map(r => r.name);
  if (left.length > 0) {
    process.stderr.write(`  ${label}: row-level security is still off on ${left.length} table(s) (${left.join(', ')}): `
      + 'the role must bypass RLS and own them. Run gbrain doctor for the fix.\n');
  }
  return left;
}

export const v275: Migration = {
  version: 275,
  name: 'rls_backfill_unguarded_tables',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => { await protectTables(engine, TABLES, 'v275'); },
};
