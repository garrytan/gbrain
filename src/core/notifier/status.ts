/**
 * GBRA-133 PR 2a.2 / 2a.5: what the notifier tells the user and the agent, read from its durable rows only (no git
 * call, no file read): the per-source notifier block for sync status and doctor, and the freshness notice that rides
 * search and query results.
 *
 * Liveness: on Postgres the owner is live while its host lease has not expired (renewed every heartbeat); on PGLite
 * there is no lease (the brain's lock holder owns the notifier), so the owner is live when it is this process or a
 * running pid on this host. A source with no coverage row, or whose owner is gone, reads not_monitored, never current.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { localHostId } from '../persistence/identity.ts';
import { missingTable, type DetectionMode, type NotifierState } from './store.ts';
import { residentNotifier } from './resident.ts';
import { parseOnCommit } from '../commit-notifier.ts';
import { SYNC_ON_COMMIT_KEY } from '../sync-config-keys.ts';
import { HOLDER_STALL_MS, holderStalled, publicDrainHolder, readLiveDrainHolder, type DrainHolder } from '../persistence/sync-lease.ts';

type Exec = Pick<BrainEngine, 'executeRaw' | 'kind'>;
type FreshnessExec = Exec & Pick<BrainEngine, 'getConfig'>;

export type FreshnessState = 'current' | 'behind' | 'syncing' | 'unknown' | 'not_monitored';

export interface SourceFreshness {
  source_id: string;
  state: FreshnessState;
  observed_head: string | null;
  observed_at: string | null;
  mode: DetectionMode | null;
  held_count: number;
}

export interface NotifierBlock {
  /** The resident that syncs this source, or null with the fix when none is running. */
  resident: { kind: string; pid: number | null; host_id: string | null; live: boolean } | null;
  state: NotifierState | null;
  reason: string | null;
  detection_mode: DetectionMode | null;
  first_due_at: string | null;
  attempts: number;
  next_retry_at: string | null;
  last_error: { code: string | null; message: string | null; at: string | null; trace_path?: string | null } | null;
  observed_head: string | null;
  observed_at: string | null;
  pending_markers: Array<{ intent: string; wanted_head: string | null; first_due_at: string; requested_by: string }>;
  stalled: boolean;
  /**
   * #7189: with no live notifier owner, the process holding the source's drain lease (a serve pass, a sync job, a CLI
   * sync), which is syncing it now; null when none holds it. Remote callers get no host, pid or job id.
   */
  drain_holder: DrainHolder | null;
  /**
   * #7243: with no live notifier owner, the resident the coverage row last recorded as this source's notifier (its trace
   * rows name it) and when its notifier lease lapsed, so the fix text names it instead of saying none ever watched.
   * Null when the row records none. Remote callers get no pid or host id.
   */
  recorded_resident: { kind: string; pid: number | null; host_id: string | null; seen_at: string | null; lease_expired_at: string | null } | null;
  /** Set when nothing will sync the source on its own, the lease holder made no progress, or the notifier stalled. */
  fix: Action | null;
}

interface Row {
  id: string; last_commit: string | null; state: NotifierState | null; reason: string | null; first_due_at: unknown; attempts: unknown;
  next_retry_at: unknown; last_error_code: string | null; last_error: string | null; last_error_at: unknown; trace_path: string | null;
  observed_head: string | null; observed_at: unknown; detection_mode: DetectionMode | null; owner_host_id: string | null; owner_kind: string | null;
  owner_pid: unknown; owner_seen_at: unknown; lease_live: unknown; lease_expires_at: unknown; due_markers: unknown;
}

const iso = (v: unknown): string | null => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const truthy = (v: unknown) => v === true || v === 't' || v === 1;

async function readRows(engine: Exec, sourceIds: string[] | null): Promise<Row[]> {
  return engine.executeRaw<Row>(
    `SELECT s.id, s.last_commit, n.state, n.reason, n.first_due_at, n.attempts, n.next_retry_at, n.last_error_code, n.last_error, n.last_error_at,
            n.trace_path, n.observed_head, n.observed_at, n.detection_mode, n.owner_host_id, n.owner_kind, n.owner_pid, n.owner_seen_at,
            EXISTS (SELECT 1 FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id AND l.expires_at > now()) AS lease_live,
            (SELECT l.expires_at FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id) AS lease_expires_at,
            (SELECT count(*) FROM sync_wanted_markers m WHERE m.source_id = s.id
               AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)) AS due_markers
       FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
      ORDER BY s.id LIMIT 200`, [sourceIds]);
}

function ownerLive(engine: Exec, row: Pick<Row, 'owner_host_id' | 'owner_pid' | 'lease_live'>): boolean {
  if (!row.owner_host_id) return false;
  if (engine.kind !== 'pglite') return truthy(row.lease_live);
  const pid = row.owner_pid === null || row.owner_pid === undefined ? null : Number(row.owner_pid);
  if (pid === null || row.owner_host_id !== localHostId()) return false;
  if (pid === process.pid) return residentNotifier() !== null;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function freshnessOf(engine: Exec, row: Row, held: number): SourceFreshness {
  const base = { source_id: row.id, observed_head: row.observed_head, observed_at: iso(row.observed_at), mode: row.detection_mode, held_count: held };
  if (!row.observed_at || !ownerLive(engine, row)) return { ...base, state: 'not_monitored' };
  if (row.state === 'running') return { ...base, state: 'syncing' };
  const behind = (row.state !== null && row.state !== 'idle') || Number(row.due_markers ?? 0) > 0 || row.observed_head !== row.last_commit;
  return { ...base, state: behind ? 'behind' : 'current' };
}

/**
 * Whether search carries the freshness notice: the brain opted in (`sync.on_commit` on) or a resident has recorded
 * coverage for some source. A brain that never ran a resident with the flag off keeps its search output unchanged;
 * once the notice is on, a source nobody watches still reads not_monitored.
 */
async function freshnessReported(engine: FreshnessExec): Promise<boolean> {
  const [flag, [covered]] = await Promise.all([
    engine.getConfig(SYNC_ON_COMMIT_KEY),
    engine.executeRaw<{ covered: unknown }>('SELECT EXISTS (SELECT 1 FROM sync_notifier_sources WHERE observed_at IS NOT NULL) AS covered'),
  ]);
  return parseOnCommit(flag) || truthy(covered?.covered);
}

/**
 * The freshness notice for search and query: one entry per source in the caller's scope, from the cached coverage
 * record, or none when the brain does not report freshness (freshnessReported). A brain without the v262 tables reports
 * none; another failed read answers unknown for the scope instead of failing the search.
 */
export async function readSourceFreshness(engine: FreshnessExec, scope: { sourceId?: string; sourceIds?: string[] }, held: ReadonlyArray<{ source_id: string; missing: number; stale: number }> = []): Promise<SourceFreshness[]> {
  const ids = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : null);
  if (ids && ids.length === 0) return [];
  const heldBy = new Map(held.map(h => [h.source_id, h.missing + h.stale]));
  try {
    if (!await freshnessReported(engine)) return [];
    return (await readRows(engine, ids)).map(row => freshnessOf(engine, row, heldBy.get(row.id) ?? 0));
  } catch (error) {
    if (missingTable(error)) return [];
    console.error(`[notifier] reading source freshness failed: ${error instanceof Error ? error.message : String(error)}`);
    return (ids ?? []).map(id => ({ source_id: id, state: 'unknown' as const, observed_head: null, observed_at: null, mode: null, held_count: heldBy.get(id) ?? 0 }));
  }
}

const syncNowFix = (sourceId: string, why: string): Action => ({ argv: ['gbrain', 'sync', '--source', sourceId, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false, why });

/**
 * The notifier block of `gbrain sync status` (and doctor): the resident that syncs the source or none with the fix,
 * its state, the retry schedule, the last error and, for a local caller, the trace file. Remote callers get no trace
 * path, pid or host id (the sync_status projection rule).
 */
export async function readNotifierBlock(engine: BrainEngine, sourceId: string, opts: { remote?: boolean } = {}): Promise<NotifierBlock | null> {
  let row: Row | undefined;
  let markers: Array<{ intent: string; wanted_head: string | null; first_due_at: unknown; requested_by: string }> = [];
  try {
    [row] = await readRows(engine, [sourceId]);
    markers = await engine.executeRaw('SELECT intent, wanted_head, first_due_at, requested_by FROM sync_wanted_markers WHERE source_id = $1 ORDER BY first_due_at, intent', [sourceId]);
  } catch (error) { if (missingTable(error)) return null; throw error; }
  if (!row) return null;
  const remote = opts.remote === true;
  const live = ownerLive(engine, row);
  const stalled = row.reason === 'notifier_stalled' || row.state === 'operator_blocked';
  const resident = live ? { kind: row.owner_kind ?? 'unknown', pid: remote ? null : row.owner_pid === null ? null : Number(row.owner_pid), host_id: remote ? null : row.owner_host_id, live } : null;
  // #7614: a holder that stopped renewing the drain lease (killed) syncs nothing, so it does not stand in for the resident.
  const holder = live ? null : await readLiveDrainHolder(engine, sourceId).catch(() => null);
  // #7243: the resident the row last recorded (the one its trace rows name), whose notifier lease is no longer live.
  const recorded = !live && row.owner_kind ? { kind: row.owner_kind, pid: remote || row.owner_pid == null ? null : Number(row.owner_pid), host_id: remote ? null : row.owner_host_id,
    seen_at: iso(row.owner_seen_at), lease_expired_at: iso(row.lease_expires_at) } : null;
  const fix = !live && !holder
    ? syncNowFix(sourceId, recorded
      ? `The ${recorded.kind} resident recorded as this source's notifier${recorded.pid ? ` (PID ${recorded.pid})` : ''} holds no live notifier lease${recorded.lease_expired_at ? ` (it lapsed at ${recorded.lease_expired_at})` : ''}, `
        + `so nothing watches this source now; this syncs the checkout HEAD now. If that resident is still running, it is not renewing its lease: restart it, and it catches up on its own.`
      : 'No resident (gbrain serve, gbrain jobs work or the autopilot daemon) watches this source; this syncs the checkout HEAD now. A resident started later catches up on its own.')
    : !live ? (holderStalled(holder) ? syncNowFix(sourceId, `No notifier watches this source, and the ${holder!.kind} process holding its drain lease has made no commit or cursor save for ${HOLDER_STALL_MS / 60_000} min or more; `
      + 'a foreground sync follows it and takes over when its lease lapses.') : null)
    : stalled ? syncNowFix(sourceId, `The notifier made no progress after ${Number(row.attempts ?? 0)} attempts (${row.last_error_code ?? row.reason ?? 'blocked'}); a foreground sync shows the error`
      + `${!remote && row.trace_path ? `, and the trace is ${row.trace_path}` : ''}.`) : null;
  return {
    resident, state: row.state, reason: row.reason, detection_mode: row.detection_mode, first_due_at: iso(row.first_due_at), attempts: Number(row.attempts ?? 0),
    next_retry_at: iso(row.next_retry_at),
    last_error: row.last_error_code || row.last_error ? { code: row.last_error_code, message: row.last_error, at: iso(row.last_error_at), ...(remote ? {} : { trace_path: row.trace_path }) } : null,
    observed_head: row.observed_head, observed_at: iso(row.observed_at),
    pending_markers: markers.map(m => ({ intent: m.intent, wanted_head: m.wanted_head, first_due_at: iso(m.first_due_at)!, requested_by: m.requested_by })),
    stalled, drain_holder: remote ? publicDrainHolder(holder) : holder, recorded_resident: recorded, fix,
  };
}

/** One line for the human sync status and doctor. */
export function formatNotifierBlock(sourceId: string, b: NotifierBlock): string {
  const who = b.resident ? `${b.resident.kind}${b.resident.pid ? ` (PID ${b.resident.pid})` : ''}, ${b.detection_mode ?? 'not observed yet'}`
    : b.drain_holder ? `none running; ${b.drain_holder.kind}${b.drain_holder.pid ? ` (PID ${b.drain_holder.pid})` : ''} holds the drain lease and is syncing it`
    : b.recorded_resident ? `none running; ${b.recorded_resident.kind}${b.recorded_resident.pid ? ` (PID ${b.recorded_resident.pid})` : ''} was recorded but holds no live lease${b.recorded_resident.lease_expired_at ? ` (lapsed ${b.recorded_resident.lease_expired_at})` : ''}` : 'none running';
  const state = b.state ? `${b.state}${b.reason ? ` (${b.reason})` : ''}${b.next_retry_at && b.state === 'retry' ? `, next retry ${b.next_retry_at}` : ''}${b.attempts ? `, ${b.attempts} attempt(s)` : ''}` : 'idle';
  const markers = b.pending_markers.length ? `; wanted: ${b.pending_markers.map(m => `${m.intent}${m.wanted_head ? ` ${m.wanted_head.slice(0, 8)}` : ''}`).join(', ')}` : '';
  const fix = b.fix ? `. Fix: ${b.fix.argv?.join(' ')}` : '';
  return `notifier for ${sourceId}: ${who}; ${state}${markers}${b.last_error?.trace_path ? `; trace ${b.last_error.trace_path}` : ''}${fix}`;
}
