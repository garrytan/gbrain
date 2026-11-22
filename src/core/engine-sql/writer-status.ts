/**
 * The reads of `gbrain sources writer status` (persistence/administration.ts, persistence/diagnostics.ts) and the
 * helpers it shares with other writer commands: the writer diagnostics row sets, the status bindings and stopped
 * retire requests, the onboarding preflight's sources (persistence/onboarding.ts), the blocking effects
 * (persistence/blocking-effects.ts) and the active worktree refreshes (persistence/worktree-refresh.ts).
 *
 * Text keys sort in byte order (`COLLATE "C"`), so the output does not depend on the server's locale. Timestamps come
 * back as the driver returns them (a `Date` on both SQL engines); a Rust brain answers the same rows from its records
 * (src/core/rust-engine/store-members/writer-status.ts).
 */
import type { BrainEngine } from '../engine.ts';
import { ACTIVE_REFRESH_STATES, type WorktreeRefreshState } from '../persistence/worktree-refresh-schema.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;
type Time = Date | string;

/** One `persistence_worktrees` row with its request, counter and effect tallies. */
export interface WriterDiagnosticWorktreeRow {
  id: string; owner_host_id: string | null; owner_epoch: string; topology_generation: string; state: string; heartbeat_at: Time | null;
  queued: number; running: number; recovering: number; oldest_request_at: Time | null; last_completed_sequence: string | null;
  recovery_bytes: string; recovering_effects: number;
}
/** One `persistence_counters` row, every count as text. */
export interface WriterDiagnosticCounterRow { key: string; outstanding_count: string; intent_bytes: string; lifetime_ids: string; terminal_bytes: string; recovery_bytes: string }
/** One outstanding or blocked request: its claim columns and whether its claim was abandoned before the cutoff. */
export interface WriterDiagnosticBlockerRow {
  request_id: string; worktree_id: string | null; source_id: string | null; state: string; blocked_reason: string | null; error_code: string | null;
  created_at: Time; claim_phase: unknown; execution_token: string | null; claim_lapsed: boolean | null; publication_started: boolean;
  operation: string; intent_kind: string | null; preparation_attempts: number | null; id: string; abandoned: boolean;
}
/** The outstanding requests of one state. */
export interface WriterDiagnosticQueueRow { state: string; count: number; intent_bytes: string; oldest_request_at: Time | null; oldest_age_ms: string | null }
/** The unsettled, uncommitted effects of one kind and state. */
export interface WriterDiagnosticEffectRow { kind: string; state: string; count: number; oldest_at: Time | null }
/** A request that recorded a refusal (`error_detail`), newest first. */
export interface WriterDiagnosticFailureRow {
  request_id: string; operation: string; source_id: string; state: string; error_code: string | null; error_detail: Record<string, unknown>; completed_at: Time | null;
}
export interface WriterDiagnosticRows {
  worktrees: WriterDiagnosticWorktreeRow[]; counters: WriterDiagnosticCounterRow[]; blockers: WriterDiagnosticBlockerRow[];
  queue: WriterDiagnosticQueueRow[]; effects: WriterDiagnosticEffectRow[]; failures: WriterDiagnosticFailureRow[];
}

/** One source binding as writer status prints it, with this host's root and Git durability. */
export interface WriterStatusBindingRow {
  source_id: string; source_incarnation: string; worktree_id: string; relative_path: string; topology_generation: string;
  owner_host_id: string | null; owner_epoch: string; state: string; manifest_digest: string | null; prepared_at: string | null;
  local_path: string | null; git_durability: string | null; git_durability_state: 'on' | 'off' | 'unknown';
}
/** A stopped remove or purge request (a retire admission), or one a later lifecycle change superseded. */
export interface WriterStatusTopologyRow {
  request_id: string; operation: string; source_id: string; source_incarnation: string; state: string; error: string | null; created_at: string;
}
export interface WriterStatusRows { bindings: WriterStatusBindingRow[]; topology_requests: WriterStatusTopologyRow[] }

/** One active source as the onboarding preflight reads it. */
export interface OnboardingSourceRow { id: string; local_path: string | null; incarnation: string; kind: string | null }

/** One effect that keeps the brain from quiescing. */
export interface BlockingEffectRow {
  effect_id: string; kind: string; state: string; recovering: boolean; source_id: string; slug: string; request_id: string;
  attempts: number | string; next_attempt_at: Time | null;
}

/** One active `persistence_worktree_refreshes` row (every column) with its worktree's owner and deferred requests. */
export interface ActiveWorktreeRefreshRow {
  id: string; worktree_id: string; source_ids: string[]; principal_id: string; owner_epoch: string | number; topology_generation: string | number;
  state: WorktreeRefreshState; old_head: string; target_head: string; upstream_ref: string; preserved_uncommitted: string[]; outcome: Record<string, unknown>;
  created_at: Time; updated_at: Time; completed_at: Time | null; barrier_sequence?: string | number | null;
  owner_host_id: string | null; deferred_count: number; deferred_oldest_ms: number | string | null;
}

/**
 * The writer diagnostics row sets. `abandonedCutoff` (ISO, or null) marks a running claim not updated since then as
 * abandoned; `excludedOrigins` are the `error_detail.origin` values the failure list leaves out.
 */
export async function readWriterDiagnosticRows(engine: RawSql, abandonedCutoff: string | null, excludedOrigins: readonly string[]): Promise<WriterDiagnosticRows> {
  const worktrees = await engine.executeRaw<WriterDiagnosticWorktreeRow>(`SELECT w.id,w.owner_host_id,w.owner_epoch::text AS owner_epoch,w.topology_generation::text AS topology_generation,w.state,w.heartbeat_at,
    COUNT(r.id) FILTER (WHERE r.state='queued')::integer AS queued,
    COUNT(r.id) FILTER (WHERE r.state='running')::integer AS running,
    COUNT(r.id) FILTER (WHERE r.state='recovering')::integer AS recovering,
    MIN(r.created_at) FILTER (WHERE r.state IN ('queued','deferred','running','recovering')) AS oldest_request_at,
    (MAX(r.sequence) FILTER (WHERE r.state='committed'))::text AS last_completed_sequence,
    COALESCE((SELECT c.recovery_bytes FROM persistence_counters c WHERE c.key='worktree:'||w.id::text),0)::text AS recovery_bytes,
    (SELECT COUNT(*)::integer FROM persistence_effects e WHERE e.worktree_id=w.id AND e.recovery IS NOT NULL) AS recovering_effects
    FROM persistence_worktrees w LEFT JOIN persistence_requests r ON r.worktree_id=w.id
    GROUP BY w.id ORDER BY w.id`);
  const counters = await engine.executeRaw<WriterDiagnosticCounterRow>(`SELECT key,outstanding_count::text,intent_bytes::text,lifetime_ids::text,terminal_bytes::text,recovery_bytes::text
    FROM persistence_counters ORDER BY key COLLATE "C"`);
  const blockers = await engine.executeRaw<WriterDiagnosticBlockerRow>(
    `SELECT request_id,worktree_id,source_id,state,blocked_reason,error_code,created_at,claim_phase,execution_token,claim_expires_at<now() AS claim_lapsed,publication_started,
      operation,intent->>'kind' AS intent_kind,preparation_attempts,id::text AS id,
      ($1::timestamptz IS NOT NULL AND state='running' AND recovery IS NULL AND updated_at<$1::timestamptz) AS abandoned
    FROM persistence_requests WHERE state IN ('queued','deferred','running','recovering') OR blocked_reason IS NOT NULL OR recovery IS NOT NULL ORDER BY sequence LIMIT 100`, [abandonedCutoff]);
  const queue = await engine.executeRaw<WriterDiagnosticQueueRow>(`SELECT state,COUNT(*)::integer AS count,COALESCE(SUM(intent_bytes),0)::text AS intent_bytes,
    MIN(created_at) AS oldest_request_at,
    MAX(EXTRACT(EPOCH FROM (now()-created_at))*1000)::bigint::text AS oldest_age_ms
    FROM persistence_requests WHERE state IN ('queued','deferred','running','recovering') GROUP BY state ORDER BY state COLLATE "C"`);
  const effects = await engine.executeRaw<WriterDiagnosticEffectRow>(`SELECT e.kind,e.state,COUNT(*)::integer AS count,MIN(r.created_at) AS oldest_at
    FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE e.state<>'committed' AND NOT (e.data ? 'settled') GROUP BY e.kind,e.state ORDER BY e.kind COLLATE "C",e.state COLLATE "C"`);
  const failures = await engine.executeRaw<WriterDiagnosticFailureRow>(
    `SELECT request_id,operation,source_id,state,error_code,error_detail,completed_at FROM persistence_requests
    WHERE error_detail IS NOT NULL AND NOT COALESCE(error_detail->>'origin','')=ANY($1::text[]) ORDER BY sequence DESC LIMIT 20`, [[...excludedOrigins]]);
  return { worktrees, counters, blockers, queue, effects, failures };
}

/** The source bindings (one source, or all) with `hostId`'s root, and the stopped retire requests (newest first, at most 20). */
export async function readWriterStatusRows(engine: RawSql, hostId: string | null, sourceId: string | null): Promise<WriterStatusRows> {
  const bindings = await engine.executeRaw<WriterStatusBindingRow>(`SELECT b.source_id,b.source_incarnation,b.worktree_id,b.relative_path,b.topology_generation::text AS topology_generation,
      w.owner_host_id,w.owner_epoch::text AS owner_epoch,w.state,w.manifest->>'digest' AS manifest_digest,w.manifest->>'prepared_at' AS prepared_at,h.local_path,h.git_durability,
      CASE h.git_durability WHEN 'enabled' THEN 'on' WHEN 'disabled' THEN 'off' ELSE 'unknown' END AS git_durability_state FROM persistence_source_bindings b
      JOIN persistence_worktrees w ON w.id=b.worktree_id
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$1::uuid
      WHERE ($2::text IS NULL OR b.source_id=$2) ORDER BY b.source_id COLLATE "C"`, [hostId, sourceId]);
  const topology_requests = await engine.executeRaw<WriterStatusTopologyRow>(`SELECT request_id::text AS request_id,operation,source_id,source_incarnation::text AS source_incarnation,state,outcome->>'error' AS error,created_at::text AS created_at
      FROM persistence_topology_changes WHERE ($1::text IS NULL OR source_id=$1) AND operation IN ('remove','purge') AND recovery IS NULL
      AND (state='recovering' OR state='failed' AND outcome->>'error'='source_retire_superseded') ORDER BY created_at DESC LIMIT 20`, [sourceId]);
  return { bindings, topology_requests };
}

/** The active sources (one, or all), by id in byte order. */
export async function listOnboardingSources(engine: RawSql, sourceId: string | null): Promise<OnboardingSourceRow[]> {
  return engine.executeRaw<OnboardingSourceRow>(
    `SELECT id,local_path,incarnation,config->>'kind' AS kind FROM sources WHERE NOT archived AND ($1::text IS NULL OR id=$1) ORDER BY id COLLATE "C"`, [sourceId]);
}

/** Effects in state queued or running (unless `recoveringOnly`), or holding a recovery record, by id; at most `limit`. */
export async function listBlockingEffectRows(engine: RawSql, sourceId: string | null, limit: number, recoveringOnly: boolean): Promise<BlockingEffectRow[]> {
  return engine.executeRaw<BlockingEffectRow>(`SELECT e.id::text AS effect_id,e.kind,e.state,(e.recovery IS NOT NULL) AS recovering,
    COALESCE(e.source_id,r.source_id) AS source_id,r.slug,r.request_id::text AS request_id,e.attempts,e.next_attempt_at
    FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE (e.recovery IS NOT NULL OR (NOT $3::boolean AND e.state IN ('queued','running')))
      AND ($1::text IS NULL OR COALESCE(e.source_id,r.source_id)=$1)
    ORDER BY e.id LIMIT $2`, [sourceId, limit, recoveringOnly]);
}

/** The active worktree refreshes (of one source's worktree, or all), oldest first. */
export async function listActiveWorktreeRefreshRows(engine: RawSql, sourceId: string | null): Promise<ActiveWorktreeRefreshRow[]> {
  return engine.executeRaw<ActiveWorktreeRefreshRow>(`SELECT f.*,w.owner_host_id::text AS owner_host_id,
    (SELECT count(*)::int FROM persistence_requests d WHERE d.deferred_refresh_id=f.id AND d.state='deferred') AS deferred_count,
    (SELECT (EXTRACT(EPOCH FROM now()-min(d.created_at))*1000)::bigint FROM persistence_requests d WHERE d.deferred_refresh_id=f.id AND d.state='deferred') AS deferred_oldest_ms
    FROM persistence_worktree_refreshes f
    LEFT JOIN persistence_worktrees w ON w.id=f.worktree_id WHERE f.state=ANY($2::text[])
    AND ($1::text IS NULL OR $1=ANY(f.source_ids)) ORDER BY f.created_at`, [sourceId, [...ACTIVE_REFRESH_STATES]]);
}
