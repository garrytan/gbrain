/**
 * Engine graduation state inventory: every relation of the public schema on
 * either engine maps to exactly one class (deny by default). The relation set,
 * the copy order and the FK closure are read from the live catalog, never
 * hand-maintained; test/graduation-inventory.test.ts fails when a migration
 * adds a relation without a row here.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { LATEST_VERSION } from '../migrate.ts';
import type { ColumnTransform, Inventory, InventoryClass, InventoryEntry, LossKind } from './engine-graduation.types.ts';

type EngineKind = 'pglite' | 'postgres';

const BOTH = { pglite: true, postgres: true } as const;

function entry(relation: string, cls: InventoryClass, lossKind: LossKind, reason: string,
  extra: { kind?: 'table' | 'view'; engines?: { pglite: boolean; postgres: boolean }; transforms?: ColumnTransform[]; rowFilter?: string } = {}): InventoryEntry {
  return {
    relation, kind: extra.kind ?? 'table', class: cls, engines: extra.engines ?? BOTH, lossKind,
    transforms: extra.transforms ?? [], ...(extra.rowFilter ? { rowFilter: extra.rowFilter } : {}), reason,
  };
}
const carry = (relation: string, lossKind: LossKind, reason: string, extra?: Parameters<typeof entry>[4]) => entry(relation, 'carry', lossKind, reason, extra);

const ACTIVE_JOB = "status = 'active'";
const ORPHAN_EFFECT = "state IN ('queued','running','failed')";

export const GRADUATION_INVENTORY: Inventory = {
  version: 1,
  entries: [
    carry('access_tokens', 'security', 'Legacy bearer tokens and their unified grant columns; token hashes keep authorizing on the target.'),
    carry('budget_ledger', 'operational', 'Daily resolver spend totals; admission keeps counting today\'s spend.'),
    carry('calibration_profiles', 'user_data', 'Published calibration profiles per holder.'),
    carry('chat_usage_log', 'operational', 'Chat model usage and cost log.'),
    carry('chronicle_judge_reservations', 'operational', 'Rolling 24-hour paid judge-call counter; dropping it would reopen the daily cap.'),
    carry('chronicle_page_state', 'user_data', 'Chronicle extraction ledger: paid work already done per page revision.'),
    carry('code_edges_chunk', 'user_data', 'Code graph edges between chunks (keyed by chunk id, which carries).'),
    carry('code_edges_symbol', 'user_data', 'Code graph edges to unresolved symbols.'),
    carry('config', 'user_data', 'Brain settings, including the embedding column registry; the engine name and schema version stay each engine\'s own.',
      { rowFilter: "key NOT IN ('engine','version','graduation.deferred_indexes')" }),
    carry('core_edit_notices', 'user_data', 'Remote edits to always-loaded core pages awaiting the owner\'s review (gbrain core diff/ack); dropping them would hide unreviewed edits.'),
    carry('content_chunks', 'user_data', 'Chunks with embeddings (paid work), vectors carried as text at the source typmod.'),
    carry('context_volunteer_events', 'operational', 'Push-context telemetry.'),
    carry('conversation_parser_llm_cache', 'operational', 'Paid LLM parse cache; rebuilding spends money.'),
    carry('decide_calibrations', 'user_data', 'System One slot qualifications (paid calibration results).'),
    carry('decide_proposals', 'user_data', 'Supersession proposals and the user\'s decisions on them.'),
    carry('decide_review_proposals', 'user_data', 'Review-lane proposals (withdraw and duplicate kinds) and the owner\'s decisions on them.'),
    carry('decide_review_queue', 'operational', 'Durable review-lane work with its retry schedule; dropping it would skip queued withdrawals.'),
    carry('decide_spend', 'operational', 'System One spend log.'),
    carry('decide_state', 'operational', 'System One sweep cursors and slot state.'),
    carry('decide_sweep_deferred', 'operational', 'Deferred System One sweep work with its schedule.'),
    carry('decision_receipts', 'user_data', 'Durable System One decision receipts.'),
    carry('dream_synthesis_completions', 'user_data', 'Dream synthesis idempotency ledger.'),
    carry('dream_verdicts', 'operational', 'Paid dream triage verdict cache.'),
    carry('drift_decisions', 'user_data', 'Take drift decisions and when they were applied.'),
    carry('entity_identities', 'user_data', 'Established entity identities.'),
    carry('eval_candidates', 'operational', 'Captured retrieval eval candidates.'),
    carry('eval_capture_failures', 'operational', 'Eval capture failure log.'),
    carry('eval_contradictions_cache', 'operational', 'Paid contradiction judge cache; rebuilding spends money.'),
    carry('eval_contradictions_runs', 'operational', 'Contradiction eval run history.'),
    carry('eval_takes_quality_runs', 'operational', 'Takes quality eval run history.'),
    carry('extract_atoms_page_state', 'user_data', 'Atom extraction ledger per page.'),
    carry('extract_atoms_transcript_state', 'user_data', 'Atom extraction ledger per transcript file.'),
    carry('extract_rollup_7d', 'operational', 'Seven-day extraction rollup counters.'),
    carry('fact_relink_attempts', 'operational', 'Fact relink attempt log.'),
    carry('fact_withdrawals', 'user_data', 'Fact withdrawal ledger (forget); must never be lost.'),
    carry('facts', 'user_data', 'Facts with attribution columns and the superseded_by self-FK.'),
    carry('files', 'user_data', 'File metadata; object bytes stay in the storage backend.'),
    carry('ingest_log', 'operational', 'Ingestion log.'),
    carry('links', 'user_data', 'Page graph links.'),
    carry('link_edge_proposals', 'user_data', 'Relationship contradiction proposals with the user\'s accept/reject/undo decisions and the paid judge results behind them.'),
    carry('link_relationships', 'user_data', 'Temporal relationship state; recorded_at and retired_at keep when the brain first and last saw a relationship, which a rebuild cannot recover.'),
    carry('link_transitions', 'user_data', 'Dated start/end evidence for relationships, including manual add_link dates that exist nowhere else.'),
    carry('loop_suppressions', 'user_data', 'Open-loop mutes the user chose.'),
    carry('mcp_request_log', 'operational', 'MCP request log.'),
    carry('mcp_spend_log', 'operational', 'MCP spend log.'),
    carry('mcp_spend_reservations', 'operational', 'Pending and unresolved MCP charges; admission counts them and late settlement needs them.'),
    carry('mention_gazetteer_entries', 'operational', 'Entity mention index: the linkable names the last mention pass used per source; a name change rescans only affected pages.'),
    carry('mention_index_status', 'operational', 'Entity mention index: per-source pass state, generation and coverage the entity card reports.'),
    carry('migration_impact_log', 'operational', 'Remediation impact log.'),
    carry('minion_attachments', 'operational', 'Job attachments.'),
    carry('minion_budget_log', 'operational', 'Job budget events.'),
    carry('minion_inbox', 'operational', 'Job inbox messages.'),
    carry('minion_jobs', 'operational', 'Job queue; orphaned leases reset under the kernel lock so the target worker runs each job once.', {
      transforms: [
        { column: 'status', rule: "active -> waiting", expression: `CASE WHEN ${ACTIVE_JOB} THEN 'waiting' ELSE status END` },
        { column: 'lock_token', rule: 'cleared on active jobs', expression: `CASE WHEN ${ACTIVE_JOB} THEN NULL ELSE lock_token END` },
        { column: 'lock_until', rule: 'cleared on active jobs', expression: `CASE WHEN ${ACTIVE_JOB} THEN NULL ELSE lock_until END` },
        { column: 'timeout_at', rule: 'cleared on active jobs', expression: `CASE WHEN ${ACTIVE_JOB} THEN NULL ELSE timeout_at END` },
        { column: 'started_at', rule: 'cleared on active jobs', expression: `CASE WHEN ${ACTIVE_JOB} THEN NULL ELSE started_at END` },
      ],
    }),
    carry('minion_lease_pressure_log', 'operational', 'Lease pressure log.'),
    carry('minion_self_fix_log', 'operational', 'Self-fix log.'),
    carry('oauth_clients', 'security', 'OAuth clients and their grants; client secrets stay valid.'),
    carry('oauth_grant_audit', 'security', 'OAuth grant change audit trail.'),
    carry('oauth_tokens', 'security', 'Issued OAuth access and refresh token hashes.'),
    carry('op_checkpoint_paths', 'operational', 'Resumable operation checkpoints.'),
    carry('op_checkpoints', 'operational', 'Resumable operation checkpoints.'),
    carry('open_loops', 'user_data', 'Open loops and their status.'),
    carry('page_aliases', 'user_data', 'Page aliases.'),
    carry('page_facts_reconcile', 'operational', 'Facts reconcile watermark: per-page revision extract_facts last reconciled; without it every page is due again.'),
    carry('page_generation_clock', 'operational', 'Page generation clock (derived side table, verified equal).'),
    carry('page_mention_state', 'operational', 'Entity mention index: per-page mention watermark; without it every page is due for a rescan.'),
    carry('page_projection_jobs', 'operational', 'Pending page projection work (derived side table, verified equal).'),
    carry('page_retrievals', 'operational', 'Retrieval telemetry: when a user-facing read last surfaced each page (stale-page bias, volunteer usage stats).'),
    carry('page_versions', 'user_data', 'Page revision history with attribution.'),
    carry('page_write_guards', 'user_data', 'Page write guards per source incarnation and slug.'),
    carry('pages', 'user_data', 'Pages with ids, knowledge_revision, revision attribution and timestamps.'),
    carry('persistence_counters', 'operational', 'Request admission counters; carried and recomputable from the carried requests.'),
    carry('persistence_effects', 'operational', 'Postcommit outbox; orphaned claims reset so the target worker can claim them, delayed effects keep next_attempt_at.', {
      transforms: [
        { column: 'state', rule: 'running -> queued', expression: "CASE WHEN state = 'running' THEN 'queued' ELSE state END" },
        { column: 'execution_token', rule: 'cleared on queued, running and failed effects', expression: `CASE WHEN ${ORPHAN_EFFECT} THEN NULL ELSE execution_token END` },
        { column: 'claim_expires_at', rule: 'cleared on queued, running and failed effects', expression: `CASE WHEN ${ORPHAN_EFFECT} THEN NULL ELSE claim_expires_at END` },
      ],
    }),
    carry('persistence_local_writers', 'security', 'Local writer credentials (cli/stdio) and revocations.'),
    carry('persistence_requests', 'user_data', 'Write requests: idempotency records and outcomes, so replays return the stored outcome.'),
    carry('persistence_source_bindings', 'user_data', 'Source to worktree bindings.'),
    carry('persistence_topology_changes', 'user_data', 'Topology change journal.'),
    carry('persistence_worktree_refreshes', 'user_data', 'Worktree refresh journal.'),
    carry('persistence_worktrees', 'user_data', 'Managed worktrees; heartbeats reset.', {
      transforms: [{ column: 'heartbeat_at', rule: 'cleared', expression: 'NULL' }],
    }),
    carry('persistence_writer_protocols', 'operational', 'Writer protocol registrations per worktree owner.'),
    carry('raw_data', 'user_data', 'Raw source payloads per page.'),
    carry('retrieval_event_links', 'operational', 'Typed edges each recorded answer used; keeps recent answers rateable.'),
    carry('retrieval_event_pages', 'operational', 'Pages and revisions each recorded answer used; keeps recent answers rateable.'),
    carry('retrieval_events', 'operational', 'Recorded answers (answer_id, client, op) within the retention window.'),
    carry('retrieval_feedback', 'user_data', 'Ratings and citation signals with the weight change each applied.'),
    carry('retrieval_weights', 'user_data', 'Learned retrieval feedback weights per page and edge.'),
    carry('search_telemetry', 'operational', 'Search telemetry rollups.'),
    carry('session_context_state', 'operational', 'Ambient recall session state.'),
    carry('shared_skill_delivery_batches', 'operational', 'Shared-skill delivery batches and acknowledgments.'),
    carry('shared_skill_heads', 'user_data', 'Shared-skill heads.'),
    carry('shared_skill_members', 'user_data', 'Shared-skill installations.'),
    carry('shared_skill_packs', 'user_data', 'Shared-skill packs.'),
    carry('shared_skill_policies', 'user_data', 'Shared-skill policies.'),
    carry('shared_skill_policy_audit', 'user_data', 'Shared-skill policy audit trail.'),
    carry('shared_skill_revision_leases', 'user_data', 'User pins and delivery retention promises with their expiries (not process leases).'),
    carry('shared_skill_revisions', 'user_data', 'Shared-skill revisions; stored_bytes is generated and never inserted.'),
    carry('shared_skill_state', 'security', 'Shared-skill serving epoch and delivery token secret.'),
    carry('slug_aliases', 'user_data', 'Slug aliases.'),
    carry('source_ingestion_receipts', 'user_data', 'Source ingestion receipts.'),
    carry('sources', 'user_data', 'Sources with incarnations and archive state.'),
    carry('subagent_messages', 'operational', 'Subagent job transcripts.'),
    carry('subagent_tool_executions', 'operational', 'Subagent tool execution log.'),
    carry('synthesis_evidence', 'user_data', 'Synthesis citations.'),
    carry('tags', 'user_data', 'Page tags.'),
    carry('take_domain_assignments', 'user_data', 'Take domain assignments.'),
    carry('take_grade_cache', 'operational', 'Paid take grading cache; rebuilding spends money.'),
    carry('take_nudge_log', 'operational', 'Take nudge log.'),
    carry('take_proposals', 'user_data', 'Take proposals and their status.'),
    carry('takes', 'user_data', 'Takes with attribution and supersession.'),
    carry('think_ab_results', 'operational', 'Think A/B eval results.'),
    carry('timeline_entries', 'user_data', 'Timeline entries with attribution.'),
    carry('wanted_links', 'user_data', 'Unresolved authored links (wanted pages); the edge appears when the target page is written, so they are not re-derived without a full re-extraction.'),

    entry('persistence_brain', 'rebind', 'user_data', 'Brain identity and flags carry (brain_id keeps every identity file valid); enabled is set on the target only at cutover.', {
      transforms: [{ column: 'enabled', rule: 'false until cutover', expression: 'false' }],
    }),
    entry('persistence_host_bindings', 'rebind', 'user_data', 'Host bindings carry only when host_id is this host and local_path passes the physical-root check.'),

    entry('query_cache', 'rebuild', 'operational', 'Query result cache; regenerated on the target.'),
    entry('code_traversal_cache', 'rebuild', 'operational', 'Code traversal cache; regenerated on the target.'),

    entry('planner_stats_deltas', 'discard', 'operational', 'PGLite-only planner accounting.', { engines: { pglite: true, postgres: false } }),
    entry('planner_stats_state', 'discard', 'operational', 'PGLite-only planner accounting.', { engines: { pglite: true, postgres: false } }),
    entry('gbrain_cycle_locks', 'discard', 'operational', 'TTL run locks; every row is an orphan under the kernel lock.'),
    entry('budget_reservations', 'discard', 'operational', 'Daily-ledger holds (src/core/budget/daily-ledger.ts) that expire within minutes; budget_ledger carries the day\'s totals, so a hold dropped mid-graduation stays counted as reserved until its UTC day ends (only tightening that day\'s cap).'),
    entry('subagent_rate_leases', 'discard', 'operational', 'Job-owned concurrency leases that expire.'),
    entry('persistence_consumers', 'discard', 'operational', 'Per-process consumer heartbeat rows (#6317): each is renewed every 10 s by a live process on the source host and lapses in 90 s; the target\'s consumers write their own rows.'),
    entry('oauth_codes', 'discard', 'security', 'One-time authorization codes; an in-flight OAuth handshake restarts.'),

    entry('page_links', 'schema_owned', 'operational', 'View over links; each engine\'s schema defines it.', { kind: 'view' }),
    entry('file_migration_ledger', 'schema_owned', 'operational', 'Postgres-only file storage migration ledger written by the target initSchema.', { engines: { pglite: false, postgres: true } }),
    entry('persistence_graduation', 'schema_owned', 'operational', 'Each engine\'s own graduation custody row (source: quiesced/cutover; target: copying..authoritative); never copied, digested or compared.'),
  ],
};

export function expectedRelations(engine: EngineKind, inv: Inventory = GRADUATION_INVENTORY): readonly string[] {
  return inv.entries.filter(e => e.engines[engine]).map(e => e.relation).sort();
}

/** Tables, partitioned tables, views, materialized views and foreign tables in the current schema. */
export async function listRelations(engine: BrainEngine): Promise<readonly { relation: string; kind: 'table' | 'view' }[]> {
  const rows = await engine.executeRaw<{ relname: string; relkind: string }>(`SELECT c.relname, c.relkind::text AS relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','v','m','f') AND NOT c.relispartition
    ORDER BY c.relname COLLATE "C"`);
  return rows.map(r => ({ relation: r.relname, kind: r.relkind === 'v' || r.relkind === 'm' ? 'view' : 'table' }));
}

async function schemaVersion(engine: BrainEngine): Promise<number | null> {
  try {
    const [row] = await engine.executeRaw<{ value: string }>("SELECT value FROM config WHERE key='version'");
    return row ? Number(row.value) : null;
  } catch { return null; }
}

/** Throws graduation_unclassified_table when the live relation set differs from the inventory for this engine. */
export async function assertRelationSet(engine: BrainEngine, kind: EngineKind, inv: Inventory = GRADUATION_INVENTORY): Promise<void> {
  const live = await listRelations(engine);
  const expected = new Map(inv.entries.filter(e => e.engines[kind]).map(e => [e.relation, e]));
  const liveNames = new Set(live.map(r => r.relation));
  const unclassified = live.filter(r => !expected.has(r.relation)).map(r => r.relation);
  const missing = [...expected.keys()].filter(name => !liveNames.has(name)).sort();
  const wrongKind = live.filter(r => expected.has(r.relation) && expected.get(r.relation)!.kind !== r.kind).map(r => r.relation);
  if (!unclassified.length && !missing.length && !wrongKind.length) return;
  const version = await schemaVersion(engine);
  const newer = version !== null && version > LATEST_VERSION;
  const parts = [
    unclassified.length ? `unclassified: ${unclassified.join(', ')}` : '',
    missing.length ? `missing: ${missing.join(', ')}` : '',
    wrongKind.length ? `wrong kind: ${wrongKind.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  const verify = { argv: ['gbrain', 'migrate', '--to', 'postgres', '--plan', '--url-env', 'GBRAIN_TARGET_URL', '--json'] };
  throw opError('graduation_unclassified_table',
    `The ${kind} schema does not match this gbrain's graduation inventory (${parts}).`,
    newer
      ? `The ${kind} brain is at schema v${version}, newer than this gbrain (v${LATEST_VERSION}). Ask the user to upgrade gbrain on this machine (gbrain upgrade), then plan the move again. --force never bypasses this.`
      : 'A relation this gbrain\'s own migrations create has no graduation inventory row, so nothing was copied. Report this as a gbrain bug with the relation names; --force never bypasses this.',
    {
      why: newer
        ? 'Graduation copies only relations it knows how to classify; a newer schema may hold state this binary would silently drop.'
        : 'Every relation must be classified carry, rebind, rebuild, discard or schema-owned before a copy, so no state is lost by omission.',
      fix: newer
        ? { argv: ['gbrain', 'upgrade'], consent: [], actor: 'user', why: 'A newer gbrain knows the newer schema\'s relations.', requires_exclusive: false,
          user_message: 'This brain was written by a newer gbrain. Please run `gbrain upgrade` on this machine, then I can plan the move again.', verify }
        : { consent: [], actor: 'agent', why: 'An inventory row is missing in this gbrain release; a maintainer must add it.', requires_exclusive: false, verify },
      reason: newer ? 'newer_schema' : 'missing_inventory_row',
    });
}

interface ForeignKey { name: string; child: string; parent: string; childColumns: string[]; parentColumns: string[] }

/** Every FK constraint in the current schema, read from pg_constraint. */
export async function foreignKeys(engine: BrainEngine): Promise<readonly ForeignKey[]> {
  const rows = await engine.executeRaw<{ name: string; child: string; parent: string; child_cols: string; parent_cols: string }>(`SELECT c.conname AS name,
      ch.relname AS child, pa.relname AS parent,
      (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n)::text AS child_cols,
      (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n)::text AS parent_cols
    FROM pg_constraint c JOIN pg_class ch ON ch.oid=c.conrelid JOIN pg_class pa ON pa.oid=c.confrelid
    JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE c.contype='f' AND n.nspname=current_schema()
    ORDER BY ch.relname COLLATE "C", c.conname COLLATE "C"`);
  return rows.map(r => ({ name: r.name, child: r.child, parent: r.parent, childColumns: JSON.parse(r.child_cols), parentColumns: JSON.parse(r.parent_cols) }));
}

/** Kahn's algorithm over parent -> child edges (self-FKs ignored), ties broken by name; throws on a cycle. */
export function topologicalOrder(nodes: readonly string[], edges: readonly { parent: string; child: string }[]): string[] {
  const set = new Set(nodes);
  const indegree = new Map(nodes.map(n => [n, 0]));
  const children = new Map<string, Set<string>>(nodes.map(n => [n, new Set()]));
  for (const { parent, child } of edges) {
    if (parent === child || !set.has(parent) || !set.has(child) || children.get(parent)!.has(child)) continue;
    children.get(parent)!.add(child);
    indegree.set(child, indegree.get(child)! + 1);
  }
  const ready = nodes.filter(n => indegree.get(n) === 0).sort();
  const order: string[] = [];
  while (ready.length) {
    const next = ready.shift()!;
    order.push(next);
    for (const child of children.get(next)!) {
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) { ready.push(child); ready.sort(); }
    }
  }
  if (order.length !== nodes.length) {
    const cyclic = nodes.filter(n => !order.includes(n)).sort();
    throw new Error(`Foreign-key cycle among ${cyclic.join(', ')}: graduation needs an acyclic FK graph apart from self-references.`);
  }
  return order;
}

/** Carry and rebind entries present on this engine, parents before children. */
export async function copyOrder(engine: BrainEngine, inv: Inventory = GRADUATION_INVENTORY): Promise<readonly InventoryEntry[]> {
  const live = new Set((await listRelations(engine)).map(r => r.relation));
  const copied = inv.entries.filter(e => (e.class === 'carry' || e.class === 'rebind') && live.has(e.relation));
  const byName = new Map(copied.map(e => [e.relation, e]));
  return topologicalOrder([...byName.keys()], await foreignKeys(engine)).map(name => byName.get(name)!);
}

/** The relation and every table that references it transitively, in topological order (the re-copy closure). */
export async function fkClosure(engine: BrainEngine, relation: string): Promise<readonly string[]> {
  const fks = await foreignKeys(engine);
  const closure = new Set([relation]);
  for (let grew = true; grew;) {
    grew = false;
    for (const fk of fks) if (closure.has(fk.parent) && !closure.has(fk.child)) { closure.add(fk.child); grew = true; }
  }
  return topologicalOrder([...closure], fks);
}
