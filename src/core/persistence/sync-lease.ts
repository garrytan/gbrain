/**
 * #6712 PR 1: the drain lease. One managed drainer per source at a time, whatever started it: the CLI (single
 * source and `--all`), a serve-delegated run, a sync job, the cycle phase, `sync_brain`, a staged catch-up, an owner
 * RPC slice or a refresh. The lease is the existing per-source sync lock (`gbrain_cycle_locks` row
 * `gbrain-sync:<source>`, the row `--break-lock` inspects and breaks), taken by `withRefreshingLock`; its
 * `acquisition_token` is the fencing token.
 *
 * - **Renewal.** TTL `DRAIN_LEASE_TTL_MINUTES`, renewed every `DRAIN_LEASE_REFRESH_MS` by `withRefreshingLock`; a
 *   renewal that matches no row, or the TTL passing unconfirmed (an event loop blocked past it, a machine asleep),
 *   aborts the pass's signal with `LockStolenError`.
 * - **Takeover.** `tryAcquireDbLock`'s rules, the same as `--break-lock`'s safe path: a TTL that expired with no
 *   heartbeat inside the steal grace, or a same-host holder whose pid is provably dead and whose lease is older than
 *   `HOLDER_TAKEOVER_GRACE_MS`.
 * - **Fencing.** `assertDrainLease` reads the lock row with this pass's token `FOR SHARE` inside every transaction
 *   that admits sync work or swaps the cursor, so a pass that lost the lease admits nothing and advances no
 *   checkpoint: the row is gone or carries another token, and a takeover waits for the share lock.
 * - **Cancellation.** The caller's signal aborts the pass; the lease is released in `withRefreshingLock`'s finally.
 * - **Reentrancy.** A pass inside a lease (the drain's passes, staged stages, a company catch-up) runs under it. A CLI
 *   run hands itself to a serve before it takes the lease (`maybeDelegateManagedSyncToServe` runs first), so the serve's
 *   run never follows the process that is waiting for it.
 * - **Older binaries.** A drainer older than this lease takes no lock, but its autopilot and its sync jobs back off from
 *   a live `sync` job row (#6713's `liveSyncJob`). Every holder keeps its holder record as such a row
 *   (`LEASE_BEACON_QUEUE`, no worker claims it) renewed with the lease and deleted on release, so nothing of the lease
 *   is left in sync state once it is released; downgrade stays quiescent (stop serve, cron and jobs first), since an
 *   older CLI run by hand ignores both.
 *
 * A caller that may follow (`gbrain sync`, a CLI run delegated to a serve) waits for a live holder within its own
 * budget, counting the holder's commits and cursor saves as this process's forward progress, and takes the lease when
 * the holder releases it. Out of budget, or when the lease moved away mid-pass, the run returns `resumable` with
 * `sync_drain_lease_held`; a holder that has made no progress for `HOLDER_STALL_MS` stops it `blocked` with
 * `drain_stalled` (cause `no_progress`) instead, so a wedged holder never reads as a clean exit on every cron tick.
 * Every other caller gets `SyncLockBusyError` (jobs and the cycle skip on it).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import type { SyncResult } from '../../commands/sync.ts';
import type { Action } from '../agent-output.ts';
import { inspectLock, LockStolenError, LockUnavailableError, syncLockId, withRefreshingLock } from '../db-lock.ts';
import { currentRunDeadline, lastForwardProgressAt, noteForwardProgress } from '../forward-progress.ts';
import { faultPoint } from './fault-points.ts';
import { VERSION } from '../../version.ts';

export const DRAIN_LEASE_TTL_MINUTES = 2;
export const DRAIN_LEASE_REFRESH_MS = 20_000;
/** How long a follower waits between looks at the holder, and the retry delay `sync_drain_lease_held` prints. */
export const FOLLOW_POLL_MS = 2_000;
export const LEASE_RETRY_AFTER_MS = 60_000;
/** A follower stops this long before its watchdog would (or half its window, when the window is shorter). */
const FOLLOW_MARGIN_MS = 30_000;
/** The minion queue of the holder records (also the beacon older binaries' `liveSyncJob` sees); no worker serves it. */
export const LEASE_BEACON_QUEUE = 'gbrain-drain-lease';
/** A holder with no commit and no cursor save for this long is wedged (the in-pass governor's no-progress window). */
export const HOLDER_STALL_MS = 5 * 60_000;
/** How often a following run prints the holder's progress: on a terminal, and otherwise. */
const FOLLOW_REPORT_TTY_MS = 10_000, FOLLOW_REPORT_MS = 60_000;
export const SYNC_DRAIN_LEASE_HELD = 'sync_drain_lease_held';

export type DrainHolderKind = 'cli' | 'serve' | 'job' | 'cycle' | 'mcp' | 'owner_slice' | 'refresh';
export interface DrainHolderRef { kind: DrainHolderKind; id?: string | null }
/** The holder's commits since it took the lease, and its last commit or cursor save. */
export interface DrainHolderProgress { committed: number; last_committed_at: string | null; last_progress_at: string | null }
export interface DrainHolder { kind: DrainHolderKind | 'unknown'; id: string | null; host: string | null; pid: number | null; started_at: string | null; last_heartbeat_at: string | null;
  /** The holder's gbrain version (null for a holder that predates it). */
  version: string | null; progress: DrainHolderProgress | null }
/** `safe_to_loop` and `retry_after_ms` are the `next` fields of the drain's other owner stops (`owner_wedged_here`). */
export interface DrainLeaseHeld { code: typeof SYNC_DRAIN_LEASE_HELD; holder: DrainHolder | null; retry_after_ms: number; safe_to_loop: true; lost?: true; fix: Action }
interface DrainLease { lockId: string; sourceId: string; token: string; signal: AbortSignal }

const leases = new AsyncLocalStorage<ReadonlyMap<string, DrainLease>>();

export function currentDrainLease(sourceId: string): DrainLease | null {
  return leases.getStore()?.get(syncLockId(sourceId)) ?? null;
}

/**
 * The fence: inside a transaction that admits work or swaps the cursor, the lock row must still carry this pass's
 * token. Throws `LockStolenError` when it does not (the pass ends `resumable` with `sync_drain_lease_held`). A caller
 * outside any lease (none in production: `performManagedSync` takes one) is not fenced.
 */
export async function assertDrainLease(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<void> {
  const lease = currentDrainLease(sourceId);
  if (!lease) return;
  // A renewal that failed aborts the lease's signal before its row is released; an expired row is lost even untaken.
  if (lease.signal.aborted) throw new LockStolenError(lease.lockId, `the drain lease of source ${sourceId} lapsed in this pass`);
  const rows = await tx.executeRaw('SELECT 1 FROM gbrain_cycle_locks WHERE id=$1 AND acquisition_token=$2::uuid AND ttl_expires_at > now() FOR SHARE', [lease.lockId, lease.token]);
  if (!rows.length) throw new LockStolenError(lease.lockId, `the drain lease of source ${sourceId} is no longer held by this pass`);
}

const iso = (value: Date | null | undefined) => value ? value.toISOString() : null;

/** The live holder of a source's drain lease (kind and id from the row this module writes beside the lock), or null. */
export async function readDrainHolder(engine: BrainEngine, sourceId: string): Promise<DrainHolder | null> {
  const snap = await inspectLock(engine, syncLockId(sourceId));
  if (!snap) return null;
  const [row] = await engine.executeRaw<{ meta: { kind?: DrainHolderKind; id?: string | null; version?: string } | string | null }>(
    "SELECT data->'drain_lease_beacon' AS meta FROM minion_jobs WHERE queue=$1 AND lock_token=$2", [LEASE_BEACON_QUEUE, snap.acquisition_token]).catch(() => []);
  const meta = typeof row?.meta === 'string' ? JSON.parse(row.meta) : row?.meta ?? null;
  return { kind: meta?.kind ?? 'unknown', id: meta?.id ?? null, host: snap.holder_host, pid: snap.holder_pid,
    started_at: iso(snap.acquired_at), last_heartbeat_at: iso(snap.last_refreshed_at), version: meta?.version ?? null,
    progress: await holderProgress(engine, sourceId, snap.acquired_at).catch(() => null) };
}

/** The source's managed-sync commits since `since`, and its last commit or cursor save at all. */
async function holderProgress(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, since: Date | null): Promise<DrainHolderProgress> {
  const [row] = await engine.executeRaw<{ committed: number | string; last_committed_at: Date | string | null; last_saved_at: Date | string | null }>(`
    SELECT (SELECT count(*) FROM persistence_requests r WHERE r.worktree_id=b.worktree_id AND r.state='committed'
        AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND r.completed_at >= $2::timestamptz) AS committed,
      (SELECT max(r.completed_at) FROM persistence_requests r WHERE r.worktree_id=b.worktree_id AND r.source_incarnation=b.source_incarnation
        AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS last_committed_at,
      (SELECT max(c.updated_at) FROM op_checkpoints c WHERE c.op='managed-sync' AND c.completed_keys->0->>'sourceId'=$1) AS last_saved_at
    FROM persistence_source_bindings b WHERE b.source_id=$1`, [sourceId, (since ?? new Date(0)).toISOString()]);
  const at = (value: Date | string | null | undefined) => value == null ? null : new Date(value).toISOString();
  const committedAt = at(row?.last_committed_at), savedAt = at(row?.last_saved_at);
  return { committed: Number(row?.committed ?? 0), last_committed_at: committedAt,
    last_progress_at: [committedAt, savedAt].filter((value): value is string => !!value).sort().pop() ?? null };
}

/** A holder that has held the lease, and made no commit or cursor save, for `HOLDER_STALL_MS`. */
export function holderStalled(holder: DrainHolder | null, now = Date.now()): boolean {
  if (!holder?.started_at || !holder.progress) return false;
  const since = Math.max(Date.parse(holder.started_at), holder.progress.last_progress_at ? Date.parse(holder.progress.last_progress_at) : 0);
  return now - since >= HOLDER_STALL_MS;
}

/** What a remote caller may see of a holder: its kind and times, never its host, pid or job id. */
export const publicDrainHolder = (holder: DrainHolder | null): DrainHolder | null => holder && { ...holder, id: null, host: null, pid: null };
const redacted = publicDrainHolder;

/** The `resumable` result of a run that did not get (or lost) the lease. Nothing was admitted by it; the cursor stands. */
export function leaseHeldResult(sourceId: string, holder: DrainHolder | null, opts: { lost?: boolean; remote?: boolean; resumeArgv?: string[] } = {}): SyncResult {
  const shown = opts.remote ? redacted(holder) : holder;
  const who = shown ? `a ${shown.kind} drainer${shown.pid ? ` (pid ${shown.pid}${shown.host ? ` on ${shown.host}` : ''})` : ''}` : 'another drainer';
  const argv = opts.resumeArgv ?? ['gbrain', 'sync', '--no-pull', '--source', sourceId];
  const progress = shown?.progress ? `, ${shown.progress.committed} page(s) committed since it took the lease${shown.progress.last_committed_at ? ` (last at ${shown.progress.last_committed_at})` : ''}` : '';
  const why = `${opts.lost ? `This run lost the drain lease of source ${sourceId} to ${who}` : `Source ${sourceId} is being drained by ${who}`}${shown?.last_heartbeat_at ? `, last heartbeat ${shown.last_heartbeat_at}` : ''}${progress}; `
    + `one drainer runs per source and it resumes the same cursor, so nothing is lost. Rerun after ${Math.round(LEASE_RETRY_AFTER_MS / 1000)}s: it follows the holder and takes the lease when the holder finishes. `
    + `If the holder is gone, gbrain sync --source ${sourceId} --break-lock releases its lease (never a live holder's); gbrain sources writer status --source ${sourceId} --json shows the writer, read-only.`;
  const fix: Action = { argv, consent: [], actor: 'provider', requires_exclusive: false, why,
    verify: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] } };
  return { status: 'partial', reason: 'drain_lease_held', fromCommit: null, toCommit: '', added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [],
    filesImported: 0, bankedFiles: 0,
    leaseHeld: { code: SYNC_DRAIN_LEASE_HELD, holder: shown, retry_after_ms: LEASE_RETRY_AFTER_MS, safe_to_loop: true, ...(opts.lost ? { lost: true as const } : {}), fix },
    drain: { outcome: 'resumable', stop_reason: 'drain_lease_held', passes: 0, processed: 0, written: 0, waived: 0, remaining: null, rate_pages_per_min: null, eta_seconds: null,
      retry_after_ms: LEASE_RETRY_AFTER_MS } };
}

/**
 * The `blocked` result of a follower whose holder heartbeats but has made no progress for `HOLDER_STALL_MS`: the drain's
 * own stall (`drain_stalled`, cause `no_progress`), naming the holder, so `drainNext` renders its escape steps.
 */
export function leaseStalledResult(sourceId: string, holder: DrainHolder, opts: { remote?: boolean } = {}): SyncResult {
  const shown = opts.remote ? redacted(holder)! : holder;
  const since = Math.max(Date.parse(holder.started_at ?? ''), holder.progress?.last_progress_at ? Date.parse(holder.progress.last_progress_at) : 0) || Date.now();
  const held = leaseHeldResult(sourceId, holder, opts);
  return { ...held, drain: { ...held.drain!, outcome: 'blocked', stop_reason: 'drain_stalled', retry_after_ms: 0,
    stall: { request_id: '', state: 'lease_held', blocked_reason: null, head_request_id: null, head_state: null, claimable_here: null, owner_is_this_host: null,
      stalled_seconds: Math.round((Date.now() - since) / 1000), cause: 'no_progress', owner_pid: shown.pid, owner_kind: shown.kind, owner_nonce: null, lease_holder: shown } } };
}

/**
 * When a follower stops: the earliest of the caller's own deadline (`deadlineAtMs`, a job's) and the process watchdog
 * (`--hard-deadline` or the non-TTY window, which extends while progress keeps arriving), less a margin, so the
 * follower reports before the watchdog fires. `--timeout` arrives as the caller's signal.
 */
export function followStopAt(startedAt: number, deadlineAtMs?: number): number {
  let at = deadlineAtMs ?? Infinity;
  const run = currentRunDeadline();
  if (run) at = Math.min(at, run.progressWindowMs ? Math.max(run.atMs, lastForwardProgressAt() + run.progressWindowMs) : run.atMs);
  if (!Number.isFinite(at)) return at;
  return at - Math.min(FOLLOW_MARGIN_MS, Math.max(0, (at - startedAt) / 2));
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface DrainLeaseOptions {
  holder: DrainHolderRef;
  /** Follow a live holder within this budget; without it a busy lease throws `LockUnavailableError`. */
  follow?: { signal?: AbortSignal; deadlineAtMs?: number };
  remote?: boolean;
  resumeArgv?: string[];
  /** Called when this run starts following a live holder, then every 10 s on a terminal (60 s otherwise) while it follows. */
  announce?: (holder: DrainHolder | null, phase: 'start' | 'progress') => void;
  tty?: boolean;
}

/**
 * The holder record: one `gbrain-drain-lease` minion row per lease, keyed by the lease token, carrying the holder's
 * kind, id and version. It doubles as the beacon an older binary's `liveSyncJob` sees, so an older autopilot backs off
 * while any holder drains. Application authority keeps it out of the unreviewed-job gate; `max_stalled` 0 and
 * `remove_on_fail` drop a dead holder's row instead of queueing it. It is renewed with the lease and deleted on release.
 */
async function writeHolderRecord(engine: BrainEngine, sourceId: string, lease: DrainLease, holder: DrainHolderRef): Promise<void> {
  await engine.executeRaw(`DELETE FROM minion_jobs WHERE queue=$1 AND name='sync' AND data->>'sourceId'=$2`, [LEASE_BEACON_QUEUE, sourceId]);
  await engine.executeRaw(`INSERT INTO minion_jobs(name,queue,status,submission_authority,data,max_attempts,max_stalled,lock_token,lock_until,started_at,remove_on_complete,remove_on_fail)
    VALUES('sync',$1,'active','{"version":1,"kind":"application"}'::jsonb,$2::text::jsonb,1,0,$3,now()+make_interval(mins => $4),now(),true,true)`,
    [LEASE_BEACON_QUEUE, JSON.stringify({ sourceId, drain_lease_beacon: { kind: holder.kind, id: holder.id ?? null, version: VERSION } }), lease.token, DRAIN_LEASE_TTL_MINUTES]);
}

/**
 * Runs `work` under the source's drain lease (`work`'s signal aborts when the lease is lost). Reentrant. A busy
 * lease throws `LockUnavailableError` unless `follow` is set; a lost lease, and a follow budget that ran out, return
 * `leaseHeldResult`, and a holder stalled for `HOLDER_STALL_MS` returns `leaseStalledResult`.
 */
export async function withDrainLease(engine: BrainEngine, sourceId: string, opts: DrainLeaseOptions,
  work: (signal: AbortSignal | undefined) => Promise<SyncResult>): Promise<SyncResult> {
  const lockId = syncLockId(sourceId);
  if (leases.getStore()?.has(lockId)) return work(undefined);
  const startedAt = Date.now();
  let seen: string | undefined, reportedAt = 0;
  for (;;) {
    try {
      return await withRefreshingLock(engine, lockId, async (signal, handle) => {
        const lease: DrainLease = { lockId, sourceId, token: handle.acquisitionToken, signal };
        await writeHolderRecord(engine, sourceId, lease, opts.holder);
        const beacon = setInterval(() => {
          void engine.executeRaw(`UPDATE minion_jobs SET lock_until=now()+make_interval(mins => $3),updated_at=now() WHERE queue=$1 AND lock_token=$2`,
            [LEASE_BEACON_QUEUE, lease.token, DRAIN_LEASE_TTL_MINUTES]).catch(() => undefined);
        }, DRAIN_LEASE_REFRESH_MS);
        beacon.unref?.();
        try {
          await faultPoint('sync:lease_acquired', { sourceId });
          const store = new Map(leases.getStore() ?? []);
          store.set(lockId, lease);
          return await leases.run(store, () => work(signal));
        } finally {
          clearInterval(beacon);
          await engine.executeRaw('DELETE FROM minion_jobs WHERE queue=$1 AND lock_token=$2', [LEASE_BEACON_QUEUE, lease.token]).catch(() => undefined);
        }
      }, { ttlMinutes: DRAIN_LEASE_TTL_MINUTES, refreshIntervalMs: DRAIN_LEASE_REFRESH_MS });
    } catch (error) {
      if (error instanceof LockStolenError && error.lockId === lockId) {
        return leaseHeldResult(sourceId, await readDrainHolder(engine, sourceId).catch(() => null), { lost: true, remote: opts.remote, resumeArgv: opts.resumeArgv });
      }
      if (!(error instanceof LockUnavailableError) || error.lockId !== lockId || !opts.follow) throw error;
    }
    const follow = opts.follow;
    const holder = await readDrainHolder(engine, sourceId).catch(() => null);
    if (seen === undefined) { opts.announce?.(holder, 'start'); reportedAt = Date.now(); }
    else if (Date.now() - reportedAt >= (opts.tty ? FOLLOW_REPORT_TTY_MS : FOLLOW_REPORT_MS)) { opts.announce?.(holder, 'progress'); reportedAt = Date.now(); }
    // The holder's commits and cursor saves are this run's forward progress: the progress-aware watchdog window extends with them.
    const now = `${holder?.started_at ?? ''}|${holder?.progress?.committed ?? ''}|${holder?.progress?.last_progress_at ?? ''}`;
    if (seen !== undefined && now !== seen) noteForwardProgress();
    seen = now;
    if (holder && holderStalled(holder)) return leaseStalledResult(sourceId, holder, { remote: opts.remote });
    const stopAt = followStopAt(startedAt, follow.deadlineAtMs);
    if (follow.signal?.aborted || Date.now() >= stopAt) return leaseHeldResult(sourceId, holder, { remote: opts.remote, resumeArgv: opts.resumeArgv });
    await pause(Math.min(FOLLOW_POLL_MS, stopAt - Date.now()), follow.signal);
  }
}
