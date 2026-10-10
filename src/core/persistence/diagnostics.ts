import type { BrainEngine } from '../engine.ts';
import { journalLimitKey, readJournalLimits } from './limits.ts';
import type { JournalLimits } from './model.ts';
import { publicationConcurrency } from './pool-capacity.ts';
import { WRITER_INSPECTION_HINT } from './admin-intent.ts';
import { writeHealth } from './health.ts';
import { claimStall, claimStateOf, isOwnerThisProcess, sqlLabel, type ClaimRow, type ClaimState, type ClaimStall } from './claim-phase.ts';
import { cliRenderContext, renderAction, type Action, type RenderedAction } from '../agent-output.ts';
import { enginePoolStats } from '../postgres-engine/pool-stats.ts';
import { listHostConsumers, type ConsumerPool, type ListedConsumer } from './consumer-heartbeat.ts';
import type { WriteRequestState } from './types.ts';
import { preparationBudgetMs } from './preparation-budget.ts';
import { readWriteSwitchSnapshot } from './switches.ts';
import { DATABASE_REFUSAL_HINT, DATABASE_TRIGGER_HINT } from './connector-errors.ts';

export const WRITER_NEXT_ACTIONS: Record<string, string> = {
  unexpected_staging_bytes: 'Keep the worktree blocked and retain its staging files and recovery capacity. Compare the recorded staging size and hash, then reconcile unexpected bytes explicitly before retrying; never discard unverified staging files.',
  unexpected_file_bytes: 'Keep the worktree blocked. Compare current bytes with the recorded before/after fingerprints and resolve the local edit explicitly; never overwrite unexpected bytes.',
  commit_outcome_uncertain: 'Recover on the designated owner and inspect the durable receipt before retrying publication.',
  publication_failed: 'Allow conditional file restoration to finish; inspect the retained terminal failure before submitting a corrected write.',
  database_contention: 'Keep the same request_id; the owner will retry after the SQL lock or connection contention clears.',
  revision_changed_repreparing: 'Keep the same request_id while the owner recomputes this supported semantic mutation against the latest revision.',
  writer_pool_capacity: 'Configure the ordinary Postgres pool with at least two connections, then restart the resident writer.',
  owner_unavailable: WRITER_INSPECTION_HINT,
  writer_busy: 'Keep the same request_id and wait for the current worktree publication to finish.',
  writer_lock_unavailable: 'Verify the bundled native addon and coordination directory permissions on the owner; never delete a live coordination lock.',
  recovery_required: 'Inspect the recorded publication fingerprints on the designated owner and settle recovery before publishing this worktree.',
  recovery_capacity: 'Allow recovery to settle or increase the applicable persistence.limits recovery byte cap. Do not remove recovery records.',
  queue_capacity: 'Let outstanding requests finish or increase the applicable persistence.limits cap. Accepted request IDs are never evicted.',
  consumer_stopping: 'Restart the resident owner and inspect the same request_id before resubmitting.',
  source_changed: 'Inspect the source incarnation and worktree binding; queued requests cannot follow a recreated source.',
  permission_denied: 'Inspect the durable principal and current source, operation, and namespace grants.',
  writer_coordinator_required: DATABASE_REFUSAL_HINT,
  // #6278: a preparation the budget cut off, and the terminal give-up at the attempt limit.
  preparation_deadline: 'Keep the same request_id: the owner cut this preparation off at its budget and will claim it again; a second cut-off finishes it preparation_stalled. Read claim.stall on the running blocker for the step and what it waited on.',
  preparation_stalled: 'Do not resubmit under the same request_id. The receipt names the last recorded step; for a sync file run gbrain sources retry-held <source> after the cause is fixed, then the same gbrain sync with the same options; a foreground write needs a new request_id.',
};
export function writerNextAction(reason: string | null | undefined): string {
  return reason && WRITER_NEXT_ACTIONS[reason] || 'Inspect the sanitized receipt and owner diagnostics before retrying with the same request_id.';
}

/**
 * #6317 (C1): the one `next` envelope (`claim.next`: code, why, retry_after_ms, fix) a running claim ends with, so the two-call journey (sources status → writer
 * status) ends in an action: inside the allowance the agent reruns status after `retry_after_ms` (`next: run`); past the
 * ceiling or on `restart_required` the host admin restarts the named owner (`tell_user_to_run`); a lapsed claim resumes
 * on its own once its transaction ends or the owner exits, so the fix is the resume (`run`).
 */
export interface ClaimNextAction { code: 'claim_running' | 'claim_overdue' | 'claim_lapsed'; why: string; retry_after_ms: number | null; fix: RenderedAction }
export function claimNextAction(claim: ClaimState, stall: ClaimStall | null, policy: { budgetMs: number | null; ceilingMs: number }, sourceId: string | null,
  owner: { row: ListedConsumer | null; live: boolean | null }, now = Date.now()): ClaimNextAction {
  const ctx = cliRenderContext();
  const status = ['gbrain', 'sources', 'writer', 'status', ...(sourceId ? ['--source', sourceId] : []), '--json'];
  const who = claim.owner ? `${claim.owner.kind} pid ${claim.owner.pid}` : 'the owner';
  const where = `${claim.step ? ` at step ${claim.step}` : ''}${claim.waiting_on !== 'unknown' ? ` (waiting on ${claim.waiting_on})` : ''}${claim.last_sql ? `, last statement ${claim.last_sql.label}` : ''}`;
  if (claim.phase === 'publication_transaction') {
    return { code: 'claim_lapsed', retry_after_ms: null, why: `The claim lapsed while running; the request is requeued once the transaction holding its row ends or the owner exits, and the next consumer claims it.`,
      fix: renderAction({ argv: status, consent: [], actor: 'agent', requires_exclusive: false, why: 'Read-only: rerun to see the request requeued or claimed again.', verify: { argv: status } }, ctx) };
  }
  const age = claim.phase_age_ms ?? claim.claim_age_ms ?? 0;
  const pastCeiling = claim.phase === 'preparing' && age >= policy.ceilingMs;
  const wedged = owner.row?.restart_required === true || (owner.row?.root_barrier_age_ms ?? -1) > policy.ceilingMs;
  if (pastCeiling || wedged) {
    return { code: 'claim_overdue', retry_after_ms: 0,
      why: `${who} has held this claim${where} for ${Math.round(age / 1000)}s${pastCeiling ? `, past the ${Math.round(policy.ceilingMs / 1000)}s ceiling` : ''}${owner.row?.restart_required ? ' and reports restart_required' : wedged ? ' and reports a root barrier past the ceiling' : ''}; only restarting that process ends the work it is parked in.`,
      fix: renderAction({ argv: status, consent: [], actor: 'host_admin', requires_exclusive: false, why: 'Restart the named process on this host, then rerun status (read-only) to see the claim released.',
        user_message: `Restart the gbrain ${claim.owner?.kind ?? 'owner'} process${claim.owner ? ` (pid ${claim.owner.pid})` : ''} on the brain host.`, verify: { argv: status } }, ctx) };
  }
  const budgetLeft = stall ? Math.max(0, policy.ceilingMs - age) : policy.budgetMs === null ? null : Math.max(0, policy.budgetMs - age);
  return { code: 'claim_running', retry_after_ms: budgetLeft,
    why: stall ? `${who} is past the ${Math.round(stall.budget_ms / 1000)}s preparation budget${where}; its own budget cuts the preparation off and frees the root by the ${Math.round(policy.ceilingMs / 1000)}s ceiling (${Math.round((budgetLeft ?? 0) / 1000)}s left). Nothing to do yet.`
      : `${who} is ${claim.phase === 'publishing' ? 'publishing' : 'preparing'} this write${where}${owner.live === false ? '; its heartbeat row is not live' : ''}. Nothing to do yet.`,
    fix: renderAction({ argv: status, consent: [], actor: 'agent', requires_exclusive: false, why: 'Read-only: rerun after retry_after_ms to see the step advance or the claim settle.', verify: { argv: status } }, ctx) };
}
/**
 * #6317 (reporter ask 3): the owner process's database backends from `pg_stat_activity`, matched on the `application_name`
 * every gbrain pool starts its connections with (`gbrain <kind>:<pid>:<nonce8>`, db.ts), so a round-trip that never
 * returns (backend `active`, `wait_event` ClientRead, an old transaction) is visible in one command. Statement text never
 * leaves: only its label (first keyword plus table). Through a transaction-mode pooler the server connection is shared
 * and carries the pooler's own name or another client's, so the mapping is partial (`backend_visibility: 'pooled'`).
 */
export interface OwnerBackend { pid: number; state: string | null; wait_event_type: string | null; wait_event: string | null; statement: string | null;
  query_age_ms: number | null; xact_age_ms: number | null; state_age_ms: number | null; application_name: string }
export type BackendVisibility = 'session' | 'pooled' | 'unavailable';
export async function readOwnerBackends(engine: BrainEngine, owners: Array<Pick<ClaimState['owner'] & object, 'kind' | 'pid' | 'nonce'>>): Promise<{ visibility: BackendVisibility; byOwner: Map<string, OwnerBackend[]> }> {
  const byOwner = new Map<string, OwnerBackend[]>();
  if (engine.kind !== 'postgres' || !owners.length) return { visibility: 'unavailable', byOwner };
  const diagnostics = (engine as { getPoolDiagnostics?: () => { prepare?: boolean | null } | null }).getPoolDiagnostics?.();
  const visibility: BackendVisibility = diagnostics?.prepare === false ? 'pooled' : 'session';
  const names = owners.map(owner => `gbrain ${owner.kind}:${owner.pid}:${(owner.nonce ?? '').slice(0, 8)}`);
  try {
    const rows = await engine.executeRaw<{ pid: number; state: string | null; wait_event_type: string | null; wait_event: string | null; query: string | null;
      query_age_ms: string | number | null; xact_age_ms: string | number | null; state_age_ms: string | number | null; application_name: string }>(
      `SELECT pid, state, wait_event_type, wait_event, left(query, 300) AS query, application_name,
         (EXTRACT(EPOCH FROM (now() - query_start)) * 1000)::bigint AS query_age_ms,
         (EXTRACT(EPOCH FROM (now() - xact_start)) * 1000)::bigint AS xact_age_ms,
         (EXTRACT(EPOCH FROM (now() - state_change)) * 1000)::bigint AS state_age_ms
       FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND application_name = ANY($1::text[]) ORDER BY pid`,
      [names], { timeoutMs: 2_000 });
    for (const row of rows) {
      const list = byOwner.get(row.application_name) ?? [];
      list.push({ pid: Number(row.pid), state: row.state, wait_event_type: row.wait_event_type, wait_event: row.wait_event, statement: row.query ? sqlLabel(row.query) : null,
        query_age_ms: row.query_age_ms === null ? null : Number(row.query_age_ms), xact_age_ms: row.xact_age_ms === null ? null : Number(row.xact_age_ms),
        state_age_ms: row.state_age_ms === null ? null : Number(row.state_age_ms), application_name: row.application_name });
      byOwner.set(row.application_name, list);
    }
    return { visibility, byOwner };
  } catch {
    return { visibility: 'unavailable', byOwner };
  }
}
/** #6317 (C1): the pool numbers for a running claim: this process's driver when it owns the claim, else the owner's heartbeat row. */
function claimPool(engine: BrainEngine, claim: ClaimState, row: ListedConsumer | null): { pool: ConsumerPool | null; pool_source: 'driver' | 'heartbeat' | null } {
  if (isOwnerThisProcess(claim.owner)) return { pool: enginePoolStats(engine), pool_source: enginePoolStats(engine) ? 'driver' : null };
  return { pool: row?.pool ?? null, pool_source: row?.pool ? 'heartbeat' : null };
}
interface Counter { key: string; outstanding_count: string | number; intent_bytes: string | number;
  lifetime_ids: string | number; terminal_bytes: string | number; recovery_bytes: string | number; }
export function capacityDiagnostics(counters: Counter[], limits: JournalLimits) {
  return counters.flatMap(counter => {
    const scope = counter.key === 'brain' ? 'brain' : counter.key.startsWith('worktree:') ? 'worktree' : 'principal';
    const resources: Array<readonly [keyof Counter, keyof JournalLimits]> = scope === 'worktree'
      ? [['recovery_bytes', 'worktreeRecoveryBytes']]
      : [['outstanding_count', `${scope}Outstanding`], ['intent_bytes', `${scope}IntentBytes`],
        ['lifetime_ids', `${scope}LifetimeIds`], ['terminal_bytes', `${scope}TerminalBytes`],
        ...(scope === 'brain' ? [['recovery_bytes', 'brainRecoveryBytes'] as const] : [])];
    return resources.map(([resource, setting]) => {
      const used = Number(counter[resource]), limit = limits[setting];
      const approaching = limit === 0 ? used > 0 : used >= limit * 0.8;
      return { scope: counter.key, resource, used, limit, remaining: Math.max(0, limit - used),
        approaching_capacity: approaching, config_key: journalLimitKey(setting),
        ...(approaching ? { next_action: `Review capacity and raise ${journalLimitKey(setting)} if needed. Permanent accepted IDs and reserved completion space must not be deleted.` } : {}) };
    });
  });
}
/** Trusted-admin counts only: neither normalized intent nor private paths leave here. */
export async function readWriterDiagnostics(engine: BrainEngine) {
  const [brain] = await engine.executeRaw<{ enabled: boolean; brain_id: string }>('SELECT enabled,brain_id FROM persistence_brain WHERE singleton=1');
  const worktrees = await engine.executeRaw(`SELECT w.id,w.owner_host_id,w.owner_epoch::text AS owner_epoch,w.topology_generation::text AS topology_generation,w.state,w.heartbeat_at,
    COUNT(r.id) FILTER (WHERE r.state='queued')::integer AS queued,
    COUNT(r.id) FILTER (WHERE r.state='running')::integer AS running,
    COUNT(r.id) FILTER (WHERE r.state='recovering')::integer AS recovering,
    MIN(r.created_at) FILTER (WHERE r.state IN ('queued','running','recovering')) AS oldest_request_at,
    (MAX(r.sequence) FILTER (WHERE r.state='committed'))::text AS last_completed_sequence,
    COALESCE((SELECT c.recovery_bytes FROM persistence_counters c WHERE c.key='worktree:'||w.id::text),0)::text AS recovery_bytes,
    (SELECT COUNT(*)::integer FROM persistence_effects e WHERE e.worktree_id=w.id AND e.recovery IS NOT NULL) AS recovering_effects
    FROM persistence_worktrees w LEFT JOIN persistence_requests r ON r.worktree_id=w.id
    GROUP BY w.id ORDER BY w.id`);
  const counters = await engine.executeRaw<Counter>(`SELECT key,outstanding_count::text,intent_bytes::text,lifetime_ids::text,terminal_bytes::text,recovery_bytes::text FROM persistence_counters ORDER BY key`);
  // #6278: the operation and intent kind say which budget applies and tell a sync member from a maintenance write; the owner process comes from the live claim's stamp.
  const blockers = await engine.executeRaw<{ request_id: string; worktree_id: string | null; source_id: string | null; state: WriteRequestState; created_at: Date | string; blocked_reason: string | null; error_code: string | null;
    operation: string; intent_kind: string | null; preparation_attempts: number | null } & Omit<ClaimRow, 'state'>>(
    `SELECT request_id,worktree_id,source_id,state,blocked_reason,error_code,created_at,claim_phase,execution_token,claim_expires_at<now() AS claim_lapsed,publication_started,
      operation,intent->>'kind' AS intent_kind,preparation_attempts
    FROM persistence_requests WHERE state IN ('queued','running','recovering') OR blocked_reason IS NOT NULL ORDER BY sequence LIMIT 100`);
  const queue = await engine.executeRaw(`SELECT state,COUNT(*)::integer AS count,COALESCE(SUM(intent_bytes),0)::text AS intent_bytes,
    MIN(created_at) AS oldest_request_at,
    MAX(EXTRACT(EPOCH FROM (now()-created_at))*1000)::bigint::text AS oldest_age_ms
    FROM persistence_requests WHERE state IN ('queued','running','recovering') GROUP BY state ORDER BY state`);
  const effects = await engine.executeRaw(`SELECT e.kind,e.state,COUNT(*)::integer AS count,MIN(r.created_at) AS oldest_at
    FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE e.state<>'committed' GROUP BY e.kind,e.state ORDER BY e.kind,e.state`);
  // #5974: trusted-admin view of database refusals, including owner-only source ids and the executing build.
  const failures = await engine.executeRaw<{ request_id: string; operation: string; source_id: string; state: WriteRequestState;
    error_code: string | null; error_detail: Record<string, unknown>; completed_at: Date | string | null }>(
    `SELECT request_id,operation,source_id,state,error_code,error_detail,completed_at FROM persistence_requests
    WHERE error_detail IS NOT NULL AND COALESCE(error_detail->>'origin','')<>'fence' ORDER BY sequence DESC LIMIT 20`);
  const limits = await readJournalLimits(engine);
  // #6278: the budgets, ceiling, attempt limit and switch in effect, next to every running blocker's step age.
  const snapshot = await readWriteSwitchSnapshot(engine).catch(() => null);
  const preparation_policy = snapshot ? { deadlines: snapshot.switches.preparation_deadlines, sync_preparation_ms: snapshot.preparation.syncMs,
    maintenance_preparation_ms: snapshot.preparation.maintenanceMs, preparation_ceiling_ms: snapshot.preparation.ceilingMs, max_preparation_attempts: snapshot.preparation.maxAttempts } : null;
  const { persistenceConsumerStatus } = await import('./service.ts');
  // #6317 (C1): the heartbeat rows of this host, read once, so each running claim can name its owner's liveness and pool.
  const { existingLocalHostId } = await import('./identity.ts');
  const hostId = existingLocalHostId();
  const consumerRows = hostId ? await listHostConsumers(engine, hostId).catch(() => []) : [];
  const tracked = (engine as { getPoolDiagnostics?: () => { tracked?: unknown } | null }).getPoolDiagnostics?.()?.tracked ?? null;
  const claimStates = blockers.map(row => claimStateOf({ state: row.state, claim_phase: row.claim_phase, execution_token: row.execution_token, claim_lapsed: row.claim_lapsed, publication_started: row.publication_started }));
  const backends = await readOwnerBackends(engine, claimStates.flatMap(state => state?.owner ? [state.owner] : []));
  // C-NEW-4: the consumer is per process, so this is the answering process's own ingress, never proof the brain's owner is down.
  const local = persistenceConsumerStatus(engine);
  const local_process_ingress = { ...local, scope: local.state === 'not_running'
    ? 'The process that answered has no resident consumer (a one-shot CLI, for example); another process may own writes. See worktrees and bindings for ownership.'
    : 'The resident consumer of the process that answered this status.' };
  return { ...brain, sampled_at: new Date().toISOString(), publication_concurrency: publicationConcurrency(engine),
    local_process_ingress, worktrees, counters, queue, effects, limits, capacity: capacityDiagnostics(counters, limits), preparation_policy,
    recent_failures: failures.map(row => ({ ...row, next_action: row.error_detail?.origin === 'database_guard' ? DATABASE_REFUSAL_HINT : DATABASE_TRIGGER_HINT })),
    backend_visibility: backends.visibility,
    blockers: blockers.map(({ claim_phase: _phase, execution_token: _token, claim_lapsed: _lapsed, publication_started: _started, ...row }, index) => {
      const health = writeHealth(row);
      const advice = writerNextAction(row.blocked_reason ?? row.error_code);
      // #6176: a running request names the phase its claim is in and how long it has held it; #6278: its step, wait cause, owner
      // process and, past its budget, the `preparation_overdue` verdict (the running state; `preparation_stalled` is only the terminal give-up).
      const state = claimStates[index] ?? null;
      const budget = snapshot ? preparationBudgetMs({ operation: row.operation, intent: row.intent_kind ? { kind: row.intent_kind } : null }, snapshot.preparation, 30_000) : null;
      const stall = state && budget !== null ? claimStall(state, budget) : null;
      // #6317 (C1): the owner's heartbeat row (liveness, pool), the last statement, and the one next_action envelope per running claim.
      const ownerRow = state?.owner ? consumerRows.find(r => r.pid === state.owner!.pid && (state.owner!.nonce === undefined || r.nonce === state.owner!.nonce)) ?? null : null;
      const ceilingMs = snapshot?.preparation.ceilingMs ?? 600_000;
      const ownerBackends = state?.owner ? backends.byOwner.get(`gbrain ${state.owner.kind}:${state.owner.pid}:${(state.owner.nonce ?? '').slice(0, 8)}`) ?? [] : [];
      const claim = state ? { ...state, ...(state.owner ? { owner: { ...state.owner, backend: ownerBackends, backend_visibility: backends.visibility } } : {}),
        ...(budget === null ? {} : { budget_ms: budget }), stall, ...claimPool(engine, state, ownerRow), pool_tracked_subset: tracked,
        owner_live: ownerRow ? ownerRow.liveness === 'live' : null, owner_mode: ownerRow?.mode ?? null,
        next: claimNextAction(state, stall, { budgetMs: budget, ceilingMs }, row.source_id, { row: ownerRow, live: ownerRow ? ownerRow.liveness === 'live' : null }) } : undefined;
      return { ...row, preparation_attempts: row.preparation_attempts ?? 0, ...health, ...(claim ? { claim } : {}), next_action: health.diagnostic?.next_action === 'inspect_owner' && advice !== WRITER_INSPECTION_HINT
        ? `${WRITER_INSPECTION_HINT} ${advice}` : advice };
    }) };
}
