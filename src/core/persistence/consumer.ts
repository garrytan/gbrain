import type { BrainEngine, ReservedConnection } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { claimableWriteSql, foregroundPrioritySql, claimGroupFollowers, claimNextLaneHead, claimNextWrite, publicationGroupKey, compactWriteReceipts, floorPreparationAttempts, hasClaimableWrite, getWriteRequestById, releaseUnpublishedClaim, renewWriteClaim, vacuumPersistenceQueues } from './journal.ts';
import { finishPreparationStalled, finishUnpublishedFailure, preparationAbortReason, recoverPublication, type PreparedMutation } from './coordinator.ts';
import { localHostId } from './identity.ts';
import { executeClaimedGroup, PAGE_BATCH_GROUP_MAX, publishSingleWrite, singleWrite } from './group-publish.ts';
import { preparationConfigView } from './config-snapshot.ts';
import { CLAIM_LOST, DEFAULT_CLAIM_LEASE_TIMING, endLostLease, startClaimLease, type ClaimLeaseTiming } from './claim-lease.ts';
import { claimPhaseStamp, claimStateOf, EXPIRED_PREPARING_CHARGE_SQL, enterClaimPhase, startClaimPhase, type ClaimPhaseClock, type WaitingOn } from './claim-phase.ts';
import { DEFAULT_PREPARATION_POLICY, preparationBudgetMs, preparationKind, startPreparation, type PreparationPolicy } from './preparation-budget.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { ownerExceptionLogText } from './publication-failure.ts';
import { refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { PROJECTION_RETRY_READY_SQL, rebuildPendingPageProjections } from '../page-state/projections.ts';
import { publicationConcurrency } from './pool-capacity.ts';
import { claimedHeadOrder } from './sync-window.ts';
import { laneClaim, laneOf, laneRoots, laneTask } from './sync-lanes.ts';
import { runPersistenceEffects } from './effects.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { isWriteErrorCode } from './types.ts';
import { redactConnectionInfo } from '../audit/redact-connection-info.ts';
import { OperationError } from '../ops/contract.ts';
import type { ReservedTransactions } from '../postgres-engine/reserved-transactions.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { maybeRefreshPlannerStats } from '../planner-stats.ts';
import { refreshFenceClear } from './worktree-refresh-schema.ts';
import { faultPoint } from './fault-points.ts';
import { releaseAbandonedClaims } from './effect-journal.ts';
import { readWriteSwitchSnapshot, writeSwitchOn } from './switches.ts';

type PhaseObservation = { name: string; started_at: string; deadline_exceeded: boolean; attempt: number; first_conn_ms?: number };
/** #5373: set by a task that abandons a still-running preparation after losing its claim; its root is freed only once `until` settles. */
type RootHold = { until?: Promise<void> };
/** #6278: the budgets and switch in effect for this tick's claims; a test may pin them through `opts.preparationBudgets`. */
export type EffectivePreparationPolicy = PreparationPolicy & { deadlines: boolean };
/** #6278: an abandoned preparation that outlived the hard ceiling; it pins whatever its await holds until it settles. */
export interface AbandonedPreparation { request_id: string; operation: string; step: string | null; waiting_on: WaitingOn; claimed_at: string; abandoned_at: string; outlived_ceiling_at: string }
/** #6278: how long stop() waits on abandoned preparations after their abort before closing the engine. */
export const ABANDONED_STOP_GRACE_MS = 5_000;
/** #6278: abandoned preparations past the ceiling this process tolerates before it stops claiming and reports `restart_required`. */
export const DEFAULT_ZOMBIE_CAP = 1;
/** When this process started; on PGLite no claim written earlier can belong to a live owner. */
const PROCESS_STARTED_AT = new Date(performance.timeOrigin);
/** #5801: the phase a connection checkout belongs to, carried through its async chain. */
const phaseScope = new AsyncLocalStorage<{ observation: PhaseObservation; startedAt: number }>();

/** #5233: one-line, redacted, length-capped error text for the consumer's stderr line. */
/** #5929: the failed receipt's message plus, for an owner exception, its class, errno and gbrain frame (this log is owner-side). */
function failureLogText(row: WriteRequest): string | undefined {
  const extra = ownerExceptionLogText(row.error_detail);
  return row.error_message || extra ? `${row.error_message ?? ''}${extra}`.replaceAll('"', "'") : undefined;
}

function errorDetail(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string' || !message.trim()) return undefined;
  return redactConnectionInfo(message).replace(/\s+/g, ' ').replaceAll('"', "'").trim().slice(0, 200);
}

/** #6278: the token of the stamp the previous claim left, so `claimStateOf` reads its last step. */
function previousToken(stamp: unknown): string | null {
  const raw = typeof stamp === 'string' ? (() => { try { return JSON.parse(stamp) as unknown; } catch { return null; } })() : stamp;
  const token = raw && typeof raw === 'object' ? (raw as { token?: unknown }).token : undefined;
  return typeof token === 'string' ? token : null;
}

/**
 * #5401: one resident projection invocation takes up to this many pages and
 * starts no new page once the budget has passed since it began. When a write is
 * claimable at its start it takes the small batch, so the drain never delays
 * queued writes by more than about two page rebuilds.
 */
export const RESIDENT_PROJECTION_PAGES = 100;
export const RESIDENT_PROJECTION_BUDGET_MS = 250;
export const WRITE_WAITING_PROJECTION_PAGES = 2;

export async function runResidentProjectionInvocation(engine: BrainEngine, hostId: string, excludeRoots: string[],
  now: () => number = Date.now, signal?: AbortSignal) {
  // Advisory and bounded by the caller's signal: a probe that cannot answer
  // (for example behind a table lock) counts as a waiting write.
  const writesWaiting = publicationConcurrency(engine) > 0 && await hasClaimableWrite(engine, hostId, excludeRoots, signal).catch(() => true);
  return rebuildPendingPageProjections(engine, writesWaiting ? WRITE_WAITING_PROJECTION_PAGES : RESIDENT_PROJECTION_PAGES,
    { deadlineMs: RESIDENT_PROJECTION_BUDGET_MS, now, retryCooldown: true });
}

const PARKED_WORKER: Promise<void> = Promise.resolve();
/** `onLane`'s answer when the lane cannot be lent: the caller runs on the pool instead. */
export const LANE_BUSY = Symbol('gbrain.laneBusy');

/** `clock` (#6278): the claim's phase clock, for `enterClaimStep` at the preparer's await boundaries. */
export type PrepareMutation = (engine: BrainEngine, row: WriteRequest, config: GBrainConfig, signal?: AbortSignal, clock?: ClaimPhaseClock) => Promise<PreparedMutation>;
/** #6278: a consumer phase ended by its own deadline (server cancel or client-side discard), never a storage fault. */
export class PhaseDeadlineError extends Error {
  readonly code = 'deadline_exceeded';
  constructor(readonly phase: string, cause: unknown) {
    super(`Consumer phase ${phase} did not finish within its deadline.`, { cause });
    this.name = 'PhaseDeadlineError';
  }
}
/** A server-honoured cancel (57014) keeps its SQLSTATE as before; only a connection the engine had to discard is reclassified. */
const PHASE_DEADLINE_CODES = new Set(['CONNECTION_DESTROYED', 'CONNECTION_CLOSED']);
function isPhaseDeadlineOutcome(error: { name?: unknown; code?: unknown } | null): boolean {
  return !!error && typeof error.code === 'string' && PHASE_DEADLINE_CODES.has(error.code);
}

export class PersistenceConsumer {
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tickPromise: Promise<void> | undefined;
  private wakeRequested = false;
  private fullTickRequested = true;
  private idleDelayMs = 0;
  private timerDueAt = 0;
  private nextDelayMs: number | undefined;
  private topologyRetryAfter = new Map<string, number>();
  private idleLane: { conn: ReservedConnection; release: () => Promise<void> } | undefined;
  private idleLaneRetryAt = 0;
  /** Phase 4.4: a single write is publishing or admitting on the idle lane's connection. */
  private laneInUse = false;
  /** An idle probe is running on the lane; it is not lent until the probe settles. */
  private probeOnLane = false;
  private active = new Set<Promise<void>>();
  /** #5373: preparations and renewals that outlived their claim; stop() drains them before the engine closes. */
  private outlived = new Set<Promise<void>>();
  /** #6278: preparations whose claim the budget (or a lost claim, with the switch on) released; stop() gives them ABANDONED_STOP_GRACE_MS. */
  private abandoned = new Set<Promise<void>>();
  /** #6278: abandoned preparations past the ceiling, by request row id. */
  private zombies = new Map<string, AbandonedPreparation>();
  private policy: EffectivePreparationPolicy = { ...DEFAULT_PREPARATION_POLICY, deadlines: true };
  private activeRoots = new Set<string>();
  /** #5984 Phase 4.5: active roots whose only task is a foreground write publishing beside this process's lane groups. */
  private besideLanes = new Set<string>();
  /** #5984 lanes: running lane tasks per worktree. */
  private laneTasks = new Map<string, number>();
  private foregroundCounts = new Map<string, number>();
  /** #5984 Phase 4.5: the newest sequence when this process last claimed a head of each lane run (one head per foreground commit). */
  private laneHeadSeen = new Map<string, string>();
  /** #5984 Phase 4.5: roots where a foreground write this consumer claimed ahead of queued sync rows committed since it last claimed a sync row there. */
  private owesSyncTurn = new Set<string>();
  /** Requests this consumer claimed ahead of a queued sync row of their root. */
  private passedSync = new Set<string>();
  private rootRetryAfter = new Map<string, number>();
  private projectionWorker: Promise<unknown> | undefined;
  private effectsWorker: Promise<void> | undefined;
  private topologyWorker: Promise<unknown> | undefined;
  private maintenanceWorker: Promise<unknown> | undefined;
  private nextMaintenance = 0;
  private publishedSinceMaintenance = 0;
  private maintenanceVolume = 50;
  private lastScan = 0;
  private progressWake = false;
  /** Phase 4.3: this process admitted a write since the last tick; that tick claims before any scan. */
  private ownAdmission = false;
  private lastError: { code: string; at: string; phase?: string } | undefined;
  private abort = new AbortController();
  private phaseObservation: PhaseObservation | undefined;
  private phaseStartedAt = 0;
  private lastPhaseTiming: string | undefined;
  private loopDelay: IntervalHistogram | null | undefined;
  private unobserveCheckout: (() => void) | undefined;
  private phaseAttempts = 0;
  private lastLog: { key: string; at: number } | undefined;
  private lastPhaseError: string | undefined;
  private preparationAttempts = 0;
  private preparing = new Map<string, { request_id: string; started_at: string; deadline_exceeded: boolean; attempt: number }>();
  private executing = new Set<string>();
  private abandonedReleased = false;
  readonly hostId: string;
  constructor(readonly engine: BrainEngine, readonly config: GBrainConfig, readonly prepare: PrepareMutation,
    private opts: { hostId?: string; concurrency?: number; pollMs?: number; idleMaxMs?: number; phaseMs?: number; preparationMs?: number;
      /** Claim renewal cadence (default 10 s); each renewal runs under the `phaseMs` deadline. */
      renewalIntervalMs?: number;
      /** Claim lease length for single-request claims (default 30 s). A test seam, like the timings above. */
      claimLeaseMs?: number; onError?: (error: unknown) => void;
      onSettled?: (row: WriteRequest) => void;
      /** Engine graduation drain: claim, recover and publish requests only; effect, projection, topology and maintenance workers never start. */
      requestsOnly?: boolean;
      /** #6278 test seam: pins budgets, ceiling, attempt limit or the switch over the brain's config. */
      preparationBudgets?: Partial<EffectivePreparationPolicy>;
      /** #6278: abandoned preparations past the ceiling before this process stops claiming (default DEFAULT_ZOMBIE_CAP). */
      zombieCap?: number } = {}) {
    this.hostId = opts.hostId ?? localHostId();
  }
  private get checkoutObservable(): ((listener: () => void) => () => void) | undefined {
    const engine = this.engine as { onCheckout?: unknown };
    return typeof engine.onCheckout === 'function' ? (engine.onCheckout as (listener: () => void) => () => void).bind(this.engine) : undefined;
  }
  start(): void {
    this.stopping = false; this.abort = new AbortController(); this.fullTickRequested = true; this.idleDelayMs = this.pollMs;
    if (this.opts.requestsOnly) this.projectionWorker = this.effectsWorker = this.topologyWorker = this.maintenanceWorker = PARKED_WORKER;
    this.schedule(0);
  }
  /**
   * Work admitted by this process: tick now instead of waiting out the idle
   * backoff. Like a completed publication, it claims at once and leaves scans
   * to at most one pass per poll interval. `ownAdmission` (the waiter of a
   * write this process just admitted) makes that tick skip the scans and
   * claim directly; the scans keep their own cadence, and recovery records
   * still block the claim (claimableWriteSql).
   */
  wake(ownAdmission = false): void {
    if (ownAdmission) this.ownAdmission = true;
    this.progressWake = true; this.idleDelayMs = this.pollMs; this.schedule(0);
  }
  private get pollMs(): number { return this.opts.pollMs ?? 250; }
  private get idleMaxMs(): number { return Math.max(this.pollMs, this.opts.idleMaxMs ?? 5000); }
  private schedule(ms: number): void {
    if (this.stopping) return;
    if (ms === 0) this.fullTickRequested = true;
    if (ms === 0 && this.tickPromise) { this.wakeRequested = true; return; }
    if (this.timer && ms !== 0 && this.timerDueAt <= Date.now() + ms) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDueAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const afterProgress = this.progressWake;
      this.progressWake = false;
      void this.tick(afterProgress).finally(() => { const next = this.nextDelayMs ?? this.pollMs; this.nextDelayMs = undefined; this.schedule(next); });
    }, ms);
    this.timer.unref?.();
  }
  private backoff(): number {
    this.idleDelayMs = Math.min(Math.max(this.idleDelayMs, this.pollMs) * 2, this.idleMaxMs);
    return this.idleDelayMs;
  }
  /**
   * One statement on one connection that mirrors the selection predicates of
   * every worker a full tick fans out to. Rows those workers would skip
   * (retrying roots, capacity-blocked requests, failed projection jobs within
   * their retry window, topology recoveries that just failed to finish) do not
   * count, so unprocessable rows back off instead of pinning the fan-out.
   */
  private async hasWork(): Promise<boolean> {
    const now = Date.now();
    const excluded = [...this.activeRoots, ...[...this.rootRetryAfter].filter(([, at]) => at > now).map(([root]) => root)];
    for (const [id, at] of this.topologyRetryAfter) if (at <= now) this.topologyRetryAfter.delete(id);
    const retryingTopologies = [...this.topologyRetryAfter.keys()];
    const [row] = await this.phase('idle_probe', async signal => this.probeQuery<{ work: boolean }>(this.laneInUse ? undefined : await this.acquireIdleLane(signal), `SELECT (
      EXISTS (SELECT 1 FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
        WHERE ${claimableWriteSql(foregroundPrioritySql(), '$5::text[]')}
        AND ($3::boolean OR r.blocked_reason IS DISTINCT FROM 'writer_pool_capacity'))
      OR EXISTS (SELECT 1 FROM persistence_requests r JOIN persistence_worktrees w ON w.id=r.worktree_id
        WHERE w.owner_host_id=$1::uuid AND r.recovery IS NOT NULL AND NOT (r.worktree_id::text=ANY($2::text[])))
      OR EXISTS (SELECT 1 FROM persistence_requests r WHERE r.state='running' AND r.recovery IS NULL
        AND r.publication_started=false AND r.claim_expires_at<now()
        AND (r.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=r.worktree_id AND w.owner_host_id=$1::uuid)))
      OR EXISTS (SELECT 1 FROM persistence_effects e LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
        WHERE (e.state='queued' OR e.state='running' AND e.claim_expires_at<now()) AND e.next_attempt_at<=now()
        AND (e.worktree_id IS NULL OR w.owner_host_id=$1::uuid) AND (e.worktree_id IS NULL OR ${refreshFenceClear('e')}) AND e.recovery IS NULL
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND (e.kind='withdrawal-mirror' OR NOT EXISTS (SELECT 1 FROM persistence_effects mirror
          WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state<>'committed')))
      OR EXISTS (SELECT 1 FROM persistence_effects e JOIN persistence_worktrees w ON w.id=e.worktree_id
        WHERE e.recovery IS NOT NULL AND w.owner_host_id=$1::uuid AND e.next_attempt_at<=now())
      OR EXISTS (SELECT 1 FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation
        JOIN pages p ON p.source_id=s.id AND p.slug=j.slug
        WHERE p.deleted_at IS NULL AND NOT s.archived AND p.page_kind IN ('markdown','code')
        AND ${PROJECTION_RETRY_READY_SQL})
      OR EXISTS (SELECT 1 FROM persistence_topology_changes c
        JOIN persistence_worktrees w ON w.id=(c.recovery->>'worktreeId')::uuid
        WHERE c.recovery IS NOT NULL AND w.owner_host_id=$1::uuid AND NOT (c.id::text=ANY($4::text[])))
    ) AS work`, [this.hostId, excluded, publicationConcurrency(this.engine) > 0, retryingTopologies, [...this.laneTasks.keys()]], signal));
    return row?.work === true;
  }
  /**
   * postgres.js hands out idle connections first-in-first-out, so a pooled
   * probe every few seconds would keep ceil(idle_timeout / interval) sockets
   * alive. Idle probes therefore share one reserved connection; the rest of
   * the pool drains through idle_timeout. Pools too small to spare a long-hold
   * permit fall back to pooled probes. The lane always comes from the ordinary
   * pool, never the direct/session route, whose clients are scarcer (#5233).
   */
  private async acquireIdleLane(signal?: AbortSignal, forPublication = false): Promise<ReservedConnection | undefined> {
    if (this.idleLane) return this.idleLane.conn;
    if (this.engine.kind !== 'postgres' || this.stopping || Date.now() < this.idleLaneRetryAt) return undefined;
    const pool = (this.engine as { getPoolDiagnostics?: () => { poolMax: number | null; tracked: Record<string, number> } | null }).getPoolDiagnostics?.();
    // Only reserve from an otherwise idle pool: a saturated pool falls back to a cancellable pooled probe.
    // A single write's publication (Phase 4.4) also reserves it while at least two other connections stay free.
    const inUse = Object.values(pool?.tracked ?? {}).reduce((sum, count) => sum + Math.max(0, count), 0);
    if (!pool?.poolMax || pool.poolMax < 3 || (forPublication ? pool.poolMax - inUse < 3 : inUse > 0)) return undefined;
    const held = Promise.withResolvers<void>();
    const reserved = Promise.withResolvers<ReservedConnection>();
    const done = this.engine.withReservedConnection(async conn => { reserved.resolve(conn); await held.promise; }, { route: 'ordinary' })
      .catch(error => { reserved.reject(error); });
    const aborted = Promise.withResolvers<undefined>();
    const onAbort = () => aborted.resolve(undefined);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const conn = await Promise.race([reserved.promise, aborted.promise]);
      if (!conn) {
        reserved.promise.then(() => held.resolve(), () => {});
        return undefined;
      }
      this.idleLane = { conn, release: async () => { held.resolve(); await done; } };
      return conn;
    } catch {
      this.idleLaneRetryAt = Date.now() + 60_000;
      return undefined;
    } finally { signal?.removeEventListener('abort', onAbort); }
  }
  private async releaseIdleLane(): Promise<void> {
    if (this.laneInUse) return;
    const lane = this.idleLane;
    this.idleLane = undefined;
    await lane?.release();
  }
  /**
   * Phase 4.4: publishes a single write. On Postgres, with the
   * `single_write_group` switch on, its group-of-one transaction runs on the
   * idle lane's reserved connection (taken while at least two other pool
   * connections stay free, and kept across single-write ticks), so its prepared
   * statements survive the pool's idle timeout and stay warm from one
   * foreground write to the next; without the lane it publishes on the pool.
   */
  private async publishSingle(row: WriteRequest, prepared: PreparedMutation): Promise<{ done: WriteRequest; settled: boolean }> {
    // A waiter learns of the commit before the recovery record is cleared (the clear still runs under the worktree lock).
    let settled = false;
    const hooks = { committed: (rows: WriteRequest[]) => { settled = true; this.settled(rows[0]!); } };
    const published = await this.onLane(transaction => publishSingleWrite(this.engine, row, prepared, this.hostId, hooks, transaction));
    const done = published === LANE_BUSY ? await publishSingleWrite(this.engine, row, prepared, this.hostId, hooks) : published;
    return { done, settled: settled && done.state === 'committed' };
  }
  /**
   * Phase 4.4: runs `run` with transactions on the warm lane connection (the
   * single-write publication's, also lent to this process's own single-write
   * admission), or returns LANE_BUSY without running it when the lane is in
   * use, unavailable, or the `single_write_group` switch is off. A failure
   * that may have broken the connection (not a refusal or an SQL error the
   * transaction rolled back) gives the lane up for a minute.
   */
  async onLane<T>(run: (transaction: <R>(fn: (tx: BrainEngine) => Promise<R>) => Promise<R>) => Promise<T>): Promise<T | typeof LANE_BUSY> {
    if (this.engine.kind !== 'postgres' || this.stopping || this.laneInUse || !await writeSwitchOn(this.engine, 'single_write_group').catch(() => true)) return LANE_BUSY;
    const conn = await this.acquireIdleLane(undefined, true) as (ReservedConnection & Partial<ReservedTransactions>) | undefined;
    if (!conn?.transaction || this.laneInUse || this.probeOnLane || this.idleLane?.conn !== conn) return LANE_BUSY;
    this.laneInUse = true;
    try {
      return await run(fn => conn.transaction!(fn));
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (!(error instanceof OperationError) && !(typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) && this.idleLane?.conn === conn) {
        this.laneInUse = false; await this.releaseIdleLane(); this.idleLaneRetryAt = Date.now() + 60_000;
      }
      throw error;
    } finally { this.laneInUse = false; }
  }
  private async probeQuery<T>(lane: ReservedConnection | undefined, sql: string, params: unknown[], signal?: AbortSignal): Promise<T[]> {
    if (!lane) return this.engine.executeRaw<T>(sql, params, { signal });
    if (this.laneInUse) return this.engine.executeRaw<T>(sql, params, { signal });
    this.probeOnLane = true;
    const query = lane.executeRaw<T>(sql, params);
    void query.then(() => { this.probeOnLane = false; }, () => { this.probeOnLane = false; });
    if (!signal) return query;
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    try { return await Promise.race([query, aborted.promise]); }
    catch (error) {
      // The reserved query cannot be cancelled: stop using the lane now, return it to the pool once the query settles.
      const current = this.idleLane?.conn === lane ? this.idleLane : undefined;
      if (current) this.idleLane = undefined;
      this.idleLaneRetryAt = Date.now() + 60_000;
      void query.then(() => current?.release(), () => current?.release());
      throw error;
    } finally { signal.removeEventListener('abort', onAbort); }
  }
  /**
   * `afterProgress` marks the wake-up that follows a completed publication
   * or a local admission. Those ticks claim the next write at once and leave
   * root refresh and recovery/expiry/topology scans to at most one pass per
   * poll interval, the same bound an idle owner has.
   */
  async tick(afterProgress = false): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.doTick(afterProgress).catch(error => { this.report(error); }).finally(() => {
      this.tickPromise = undefined;
      if (this.wakeRequested) { this.wakeRequested = false; this.schedule(0); }
    });
    return this.tickPromise;
  }
  private async doTick(afterProgress: boolean): Promise<void> {
    if (this.stopping) return;
    const requested = this.fullTickRequested || this.active.size > 0;
    this.fullTickRequested = false;
    if (!requested) {
      let work: boolean;
      try { work = await this.hasWork(); }
      catch (error) {
        if (this.stopping) throw error;
        // One failure per tick: an unknown answer runs the full fan-out on the next tick.
        this.report(error);
        this.fullTickRequested = true;
        this.nextDelayMs = this.backoff();
        return;
      }
      if (this.stopping) return;
      if (!work) {
        this.nextDelayMs = this.backoff();
        if (!this.maintenanceWorker && Date.now() >= this.nextMaintenance) {
          this.nextMaintenance = Date.now() + 300_000;
          await this.phase('refresh_roots', signal => refreshManagedFilesystemRoots(this.engine,
            this.engine.kind === 'pglite' ? this.config.database_path : undefined, signal));
          // F4b: idle maintenance also refreshes stale PGLite planner statistics (a no-op on Postgres).
          this.maintenanceWorker = compactWriteReceipts(this.engine).then(() => maybeRefreshPlannerStats(this.engine, 'idle'))
            .catch(error => this.report(error)).finally(() => { this.maintenanceWorker = undefined; });
        }
        return;
      }
    }
    // Lane runs size themselves to the pool's long-hold budget; a single write keeps its warm lane.
    // The switches are read under the tick's phase deadline, so a saturated pool cannot hold the tick.
    const fast = await this.phase('switches', signal => readWriteSwitchSnapshot(this.engine, { signal }))
      .then(snapshot => {
        this.policy = { ...snapshot.preparation, deadlines: snapshot.switches.preparation_deadlines, ...this.opts.preparationBudgets };
        return snapshot.switches.single_write_group;
      }, async error => { await this.releaseIdleLane(); throw error; });
    if (laneRoots().length || this.engine.kind !== 'postgres' || !fast) await this.releaseIdleLane();
    this.idleDelayMs = this.pollMs;
    this.nextDelayMs = this.pollMs;
    const direct = afterProgress && this.ownAdmission && fast;
    this.ownAdmission = false;
    const scan = !direct && (!afterProgress || Date.now() - this.lastScan >= this.pollMs);
    if (scan) {
      this.lastScan = Date.now();
      await this.phase('refresh_roots', signal => refreshManagedFilesystemRoots(this.engine,
        this.engine.kind === 'pglite' ? this.config.database_path : undefined, signal));
    }
    if (this.stopping) return;
    if (scan && !this.topologyWorker) this.topologyWorker = import('./topology-recovery.ts')
      .then(({ recoverSourceTopologies }) => recoverSourceTopologies(this.engine, { hostId: this.hostId, limit: 2,
        onAttempt: (id, recovered) => { if (recovered) this.topologyRetryAfter.delete(id); else this.topologyRetryAfter.set(id, Date.now() + 30_000); } }))
      .catch(error => this.report(error)).finally(() => { this.topologyWorker = undefined; });
    if (!this.effectsWorker) this.effectsWorker = this.drainEffects().catch(error => this.report(error))
      .finally(() => { this.effectsWorker = undefined; });
    // Queue upkeep also follows publication volume, like autovacuum's scale
    // factor, so a busy owner never plans against a much smaller queue.
    if (!this.maintenanceWorker && (Date.now() >= this.nextMaintenance || this.publishedSinceMaintenance >= this.maintenanceVolume)) {
      this.nextMaintenance = Date.now() + 60_000;
      this.publishedSinceMaintenance = 0;
      this.maintenanceWorker = compactWriteReceipts(this.engine).then(() => vacuumPersistenceQueues(this.engine))
        .then(rows => { this.maintenanceVolume = 50 + Math.ceil(rows * 0.2); }).catch(error => this.report(error))
        .finally(() => { this.maintenanceWorker = undefined; });
    }
    if (!this.projectionWorker) this.projectionWorker = runResidentProjectionInvocation(this.engine, this.hostId,
      [...this.activeRoots, ...this.rootRetryAfter.keys()], Date.now, this.engine.kind === 'postgres'
        ? AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.opts.phaseMs ?? 5000)]) : undefined)
      .catch(error => this.report(error)).finally(() => { this.projectionWorker = undefined; });
    // Recover only our owner roots. Kernel exclusion, not elapsed heartbeat,
    // proves that a previous process can no longer be publishing this root.
    if (scan && this.engine.kind === 'pglite' && !this.abandonedReleased) {
      await this.phase('abandoned_claims', () => releaseAbandonedClaims(this.engine, PROCESS_STARTED_AT, this.policy.deadlines));
      this.abandonedReleased = true;
    }
    const now = Date.now();
    for (const [root, retryAt] of this.rootRetryAfter) if (retryAt <= now) this.rootRetryAfter.delete(root);
    if (scan) {
      const excluded = [...this.activeRoots, ...this.rootRetryAfter.keys()];
      const recovery = await this.phase('recovery_scan', signal => this.engine.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r
        JOIN persistence_worktrees w ON w.id=r.worktree_id
        WHERE w.owner_host_id=$1::uuid AND r.recovery IS NOT NULL AND NOT(r.worktree_id::text=ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier WHERE earlier.worktree_id=r.worktree_id
          AND earlier.recovery IS NOT NULL AND earlier.sequence<r.sequence)
        ORDER BY r.updated_at,r.sequence LIMIT 16`, [this.hostId, excluded], { signal }));
      for (const row of recovery) {
        const root = row.worktree_id!;
        // Always skip at least the next scheduled poll for an unresolved root.
        // This preserves its FIFO head while allowing the next root into LIMIT 16.
        const delay = Math.max(1000, (this.opts.pollMs ?? 250) * 2);
        this.rootRetryAfter.set(root, Date.now() + delay);
        try {
          const recovered = await this.phase('recovery', () => recoverPublication(this.engine, row.id, this.hostId));
          if (isTerminal(recovered)) this.settled(recovered);
          if (!recovered.recovery) this.rootRetryAfter.delete(root);
          else if (recovered.blocked_reason === 'unexpected_file_bytes') this.rootRetryAfter.set(root, Date.now() + Math.max(delay, 30_000));
        } catch (error) {
          this.rootRetryAfter.set(root, Date.now() + Math.max(delay, 30_000));
          this.report(error);
        }
      }
      // #6278: a claim that expired while its owner was preparing (the kill case) counts one preparation attempt.
      await this.phase('expired_claims', signal => this.engine.executeRaw(`WITH expired AS (
        SELECT r.id FROM persistence_requests r WHERE r.state='running' AND r.recovery IS NULL
        AND r.publication_started=false AND r.claim_expires_at<now() AND ${PERSISTENCE_PROTOCOL_PREDICATE}
        AND (r.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=r.worktree_id AND w.owner_host_id=$1::uuid))
        ORDER BY r.sequence LIMIT 100 FOR UPDATE OF r SKIP LOCKED)
        UPDATE persistence_requests r SET state='queued',execution_token=NULL,claim_expires_at=NULL,
          preparation_attempts=r.preparation_attempts+CASE WHEN $2::boolean THEN ${EXPIRED_PREPARING_CHARGE_SQL('r')} ELSE 0 END
        FROM expired WHERE r.id=expired.id`, [this.hostId, this.policy.deadlines], { signal }));
    }
    if (publicationConcurrency(this.engine) === 0) {
      await this.phase('capacity', signal => this.engine.executeRaw(`UPDATE persistence_requests SET blocked_reason='writer_pool_capacity'
        WHERE state='queued' AND blocked_reason IS DISTINCT FROM 'writer_pool_capacity' AND ${PERSISTENCE_PROTOCOL_PREDICATE}`, undefined, { signal }));
      return;
    }
    // #6278: at the zombie cap this process claims nothing more; status() says restart_required and the drain ends.
    if (this.restartRequired()) return;
    const concurrency = this.opts.concurrency ?? 2;
    // #5984: on a root whose lane groups run here, only a foreground write is claimed, to publish beside them.
    const laneRootKeys = [...this.laneTasks.keys()];
    const attemptedRoots = new Set([...this.activeRoots, ...this.rootRetryAfter.keys()]);
    while (!this.stopping && this.active.size - this.laneTaskCount() < concurrency) {
      const claimed = laneClaim();
      try {
        // A root where lanes run here owes the sync side no FIFO turn: the write publishes beside its groups.
        const row = await this.phase('claim', () => claimNextWrite(this.engine, this.hostId, this.opts.claimLeaseMs ?? 30_000, [...attemptedRoots],
          [...this.owesSyncTurn].filter(key => !laneRootKeys.includes(key)), laneRootKeys.filter(key => !attemptedRoots.has(key))));
        if (!row) break;
        if (String(row.intent?.kind ?? '').startsWith('managed_sync_')) this.owesSyncTurn.delete(row.worktree_id ?? `db:${row.source_incarnation}`);
        else if (row.passed_sync) this.passedSync.add(row.id);
        if (this.stopping) { await releaseUnpublishedClaim(this.engine, row, 'consumer_stopping'); break; }
        const key = row.worktree_id ?? `db:${row.source_incarnation}`;
        attemptedRoots.add(key);
        // #5984 lanes: the FIFO head of an open lane run runs as the run's first lane.
        if (laneOf(row)) { this.startLaneTask(row, key); continue; }
        if (this.activeRoots.has(key)) { await releaseUnpublishedClaim(this.engine, row, 'writer_busy'); break; }
        this.activeRoots.add(key);
        // Lane heads keep being claimed beside a foreground write on a lane root (it joins their lease).
        if (laneRootKeys.includes(key)) this.besideLanes.add(key);
        this.track(row, () => { this.activeRoots.delete(key); this.besideLanes.delete(key); }, key);
      } finally { claimed(); }
    }
    await this.claimLanes();
  }
  /** #5984 lanes: claims the next group heads of every open lane run in this process, up to its effective lane count. */
  private async claimLanes(): Promise<void> {
    for (const { worktreeId, run, capacity } of laneRoots()) {
      if (this.rootRetryAfter.has(worktreeId) || this.activeRoots.has(worktreeId) && !this.besideLanes.has(worktreeId)) continue;
      while (!this.stopping && (this.laneTasks.get(worktreeId) ?? 0) < capacity) {
        const claimed = laneClaim();
        try {
          const row = await this.phase('claim', () => claimNextLaneHead(this.engine, this.hostId, worktreeId, run, undefined, this.laneHeadSeen.get(run) ?? null));
          if (!row) break;
          this.laneHeadSeen.set(run, row.seen_sequence);
          this.owesSyncTurn.delete(worktreeId);
          this.startLaneTask(row, worktreeId);
        } finally { claimed(); }
      }
    }
  }
  private laneTaskCount(): number { let count = 0; for (const n of this.laneTasks.values()) count += n; return count; }
  private startLaneTask(row: WriteRequest, key: string): void {
    this.laneTasks.set(key, (this.laneTasks.get(key) ?? 0) + 1);
    const state = laneOf(row);
    const release = state ? laneTask(state) : () => undefined;
    this.track(row, () => { release(); const n = (this.laneTasks.get(key) ?? 1) - 1; if (n > 0) this.laneTasks.set(key, n); else this.laneTasks.delete(key); }, key);
  }
  private track(row: WriteRequest, done: () => void, key: string): void {
    let progressed = false;
    const root: RootHold = {};
    const task = this.executeOrGroup(row, root).then(result => { progressed = result; }).catch(error => this.report(error)).finally(() => {
      if (!progressed) this.rootRetryAfter.set(key, Date.now() + (this.opts.pollMs ?? 250));
      else { this.progressWake = true; this.publishedSinceMaintenance++; }
      this.active.delete(task);
      // The slot is free now; the root (or lane slot) waits for an abandoned preparation so nothing on it overtakes that work.
      if (root.until) void root.until.then(() => { done(); this.schedule(0); });
      else done();
      this.schedule(progressed ? 0 : this.opts.pollMs ?? 250);
    });
    this.active.add(task);
  }
  /** Effects keep pace with publication: full batches continue without waiting for the next tick. */
  private async drainEffects(): Promise<void> {
    const limit = 20;
    while (!this.stopping && await runPersistenceEffects(this.engine, this.config,
      { hostId: this.hostId, limit, signal: this.abort.signal }) >= limit);
  }
  foregroundCompletions(worktreeId: string): number { return this.foregroundCounts.get(worktreeId) ?? 0; }
  /** CEO-A7: this process holds the claim, so its outcome reaches waiters through `onSettled` without a read. */
  holds(id: string): boolean { return this.executing.has(id); }
  private settled(row: WriteRequest): boolean {
    // #5984 Phase 4.5: after a foreground write that went ahead of queued sync rows commits, this consumer's next
    // claim on its root is plain FIFO, so a stream of writes cannot starve the sync side.
    if (isTerminal(row) && this.passedSync.delete(row.id) && row.state === 'committed') this.owesSyncTurn.add(row.worktree_id ?? `db:${row.source_incarnation}`);
    try { this.opts.onSettled?.(row); } catch (error) { this.report(error); }
    return isTerminal(row);
  }
  /** #6278: abandoned preparations past the ceiling have reached this process's cap; it claims nothing more until it restarts. */
  restartRequired(): boolean { return this.zombies.size >= (this.opts.zombieCap ?? DEFAULT_ZOMBIE_CAP); }
  status() {
    const { deadlines, syncMs, maintenanceMs, ceilingMs, maxAttempts } = this.policy;
    return { accepting: !this.stopping, active_preparations: this.active.size, active_worktrees: this.activeRoots.size,
      sampled_at: new Date().toISOString(), observation_scope: 'current_process_reset_on_restart',
      preparation_attempts: this.preparationAttempts,
      phase: this.phaseObservation ? { ...this.phaseObservation, ...this.phaseTiming(this.phaseObservation, this.phaseStartedAt) } : null,
      preparations: [...this.preparing.values()].map(value => ({ ...value })),
      // #6278: deadlines in effect, preparations whose claim was released while they still ran, and the zombies past the ceiling.
      preparation_policy: { deadlines, sync_preparation_ms: syncMs, maintenance_preparation_ms: maintenanceMs, preparation_ceiling_ms: ceilingMs, max_preparation_attempts: maxAttempts },
      abandoned_preparations: this.abandoned.size,
      outlived_ceiling: [...this.zombies.values()].map(value => ({ ...value })),
      restart_required: this.restartRequired(),
      ...(this.lastError ? { last_error: { ...this.lastError } } : {}) };
  }
  /**
   * #5801: connection-wait and event-loop evidence for a phase. A checkout is
   * observed only after a connection was obtained inside this phase's async
   * chain; until then the phase reports how long it has been waiting.
   */
  private phaseTiming(observation: PhaseObservation, startedAt: number): { checkout?: 'not_observed'; conn_wait_ms?: number; loop_lag_ms?: number } {
    let lag: number | undefined;
    try { if (this.loopDelay) lag = Math.round(this.loopDelay.max / 1e6); } catch { /* fail-open */ }
    return {
      ...(this.unobserveCheckout && observation.first_conn_ms === undefined
        ? { checkout: 'not_observed' as const, conn_wait_ms: Math.round(performance.now() - startedAt) } : {}),
      ...(lag === undefined ? {} : { loop_lag_ms: lag }),
    };
  }
  private timingText(observation: PhaseObservation, startedAt: number): string {
    const fields: Record<string, unknown> = { first_conn_ms: observation.first_conn_ms, ...this.phaseTiming(observation, startedAt) };
    return Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => ` ${key}=${value}`).join('');
  }
  private async phase<T>(name: string, run: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    const observation: PhaseObservation = { name, started_at: new Date().toISOString(), deadline_exceeded: false, attempt: ++this.phaseAttempts };
    const startedAt = performance.now();
    this.phaseObservation = observation;
    this.phaseStartedAt = startedAt;
    this.unobserveCheckout ??= this.checkoutObservable?.(() => {
      const scope = phaseScope.getStore();
      if (scope && scope.observation.first_conn_ms === undefined) scope.observation.first_conn_ms = Math.round(performance.now() - scope.startedAt);
    });
    if (this.loopDelay === undefined) {
      try { this.loopDelay = monitorEventLoopDelay({ resolution: 10 }); this.loopDelay.enable(); } catch { this.loopDelay = null; }
    }
    try { this.loopDelay?.reset(); } catch { /* fail-open */ }
    const abort = new AbortController();
    const stop = () => abort.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort', stop, { once: true });
    if (this.stopping) stop();
    const timer = setTimeout(() => {
      observation.deadline_exceeded = true; abort.abort(); this.log(name, 'deadline_exceeded', undefined, this.timingText(observation, startedAt));
    }, this.opts.phaseMs ?? 5000);
    try { return await phaseScope.run({ observation, startedAt }, () => run(this.engine.kind === 'postgres' ? abort.signal : undefined)); }
    catch (error) {
      const cancelled = error as { name?: unknown; code?: unknown; message?: unknown } | null;
      if (this.stopping && abort.signal.aborted && abort.signal.reason === this.abort.signal.reason
        && (error === abort.signal.reason || cancelled?.name === 'AbortError'
          || cancelled?.code === '57014' && typeof cancelled.message === 'string'
            && /^(?:57014: )?canceling statement due to user request$/.test(cancelled.message))) {
        throw this.abort.signal.reason;
      }
      this.lastPhaseError = name; this.lastPhaseTiming = this.timingText(observation, startedAt);
      // #6278: past the phase deadline, the client-side discard of a round-trip a pooler never completed is the
      // deadline itself: the tick moves on instead of reporting storage_error.
      if (observation.deadline_exceeded && isPhaseDeadlineOutcome(cancelled)) throw new PhaseDeadlineError(name, error);
      throw error;
    }
    finally { clearTimeout(timer); this.abort.signal.removeEventListener('abort', stop); this.phaseObservation = undefined; }
  }
  private report(error: unknown): void {
    if (this.stopping && error === this.abort.signal.reason) return;
    if (error instanceof PhaseDeadlineError) {
      // The timer already logged deadline_exceeded for this phase: record it under the phase, hand it to onError
      // (fail-closed scheduling still sees one failure per tick), write no second line, and let the next tick run.
      this.lastError = { code: 'deadline_exceeded', at: new Date().toISOString(), phase: error.phase };
      this.lastPhaseError = undefined; this.lastPhaseTiming = undefined;
      this.opts.onError?.(error);
      return;
    }
    const code = (error as { code?: unknown })?.code;
    this.lastError = { code: typeof code === 'string' && (/^[A-Z0-9]{5}$/.test(code) || isWriteErrorCode(code)) ? code : 'storage_error', at: new Date().toISOString(),
      ...(this.lastPhaseError ? { phase: this.lastPhaseError } : {}) };
    if (this.opts.onError) this.opts.onError(error);
    else this.log(this.lastPhaseError ?? 'execution', this.lastError.code, errorDetail(error), this.lastPhaseError ? this.lastPhaseTiming : undefined);
    this.lastPhaseError = undefined;
    this.lastPhaseTiming = undefined;
  }
  private log(phase: string, code: string, detail?: string, timing = ''): void {
    const key = `${phase}:${code}`, at = Date.now();
    if (this.lastLog && (at - this.lastLog.at < 1000 || this.lastLog.key === key && at - this.lastLog.at < 30_000)) return;
    this.lastLog = { key, at };
    if (!this.opts.onError) process.stderr.write(`[persistence] phase=${phase} reason=${code}${detail ? ` message="${detail}"` : ''}${timing}`
      + '; unfinished work remains tracked; fix: gbrain sources writer status --json; docs: docs/ENGINES.md#persistence-consumer-log\n');
  }
  /** #5373: tracks work that outlived its claim until it settles; the returned promise never rejects. */
  private keepUntilSettled(work: Promise<unknown>): Promise<void> {
    const settled = work.then(() => undefined, () => undefined);
    this.outlived.add(settled);
    void settled.then(() => { this.outlived.delete(settled); });
    return settled;
  }
  private leaseTiming(): ClaimLeaseTiming {
    return { everyMs: this.opts.renewalIntervalMs ?? DEFAULT_CLAIM_LEASE_TIMING.everyMs, deadlineMs: this.opts.phaseMs ?? DEFAULT_CLAIM_LEASE_TIMING.deadlineMs };
  }
  /**
   * #6278: tracks a preparation whose claim is gone while it still runs. With
   * the deadlines switch on it goes to `abandoned` (stop() gives it a short
   * grace); off, to `outlived` as before (stop() waits for it). The returned
   * promise never rejects.
   */
  private keepAbandoned(work: Promise<unknown>): Promise<void> {
    if (!this.policy.deadlines) return this.keepUntilSettled(work);
    const settled = work.then(() => undefined, () => undefined);
    this.abandoned.add(settled);
    void settled.then(() => { this.abandoned.delete(settled); });
    return settled;
  }
  /**
   * #6278: the #5373 root barrier for an abandoned preparation, bounded by the
   * hard ceiling measured from the claim. At the ceiling the root is freed, the
   * request's counter is set to the limit (an overrun proves the await ignored
   * cancellation, so its next claim fails it `preparation_stalled`) and the
   * zombie stays tracked here and in status() until it settles.
   */
  private abandonedRootBlock(row: WriteRequest, clock: ClaimPhaseClock, settled: Promise<void>): Promise<void> {
    if (!this.policy.deadlines) return settled;
    let done = false;
    void settled.then(() => { done = true; });
    const remaining = Math.max(0, this.policy.ceilingMs - (Date.now() - clock.claimedAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ceiling = new Promise<void>(resolve => { timer = setTimeout(resolve, remaining); timer.unref?.(); });
    return Promise.race([settled, ceiling]).then(async () => {
      if (timer) clearTimeout(timer);
      if (done) return;
      const at = new Date().toISOString();
      this.zombies.set(row.id, { request_id: row.request_id, operation: row.operation, step: clock.step, waiting_on: clock.waitingOn,
        claimed_at: new Date(clock.claimedAt).toISOString(), abandoned_at: at, outlived_ceiling_at: at });
      void settled.then(() => { this.zombies.delete(row.id); });
      this.log('preparation', 'ceiling_exceeded', `request ${row.request_id} step=${clock.step ?? 'none'} waiting_on=${clock.waitingOn}${this.restartRequired() ? ' restart_required' : ''}`);
      await floorPreparationAttempts(this.engine, row.id, this.policy.maxAttempts).catch(error => this.report(error));
    });
  }
  private async execute(row: WriteRequest, root: RootHold): Promise<boolean> {
    let preparationActive = true;
    const observation = { request_id: row.request_id, started_at: new Date().toISOString(), deadline_exceeded: false, attempt: ++this.preparationAttempts };
    this.preparing.set(row.id, observation);
    this.executing.add(row.id);
    const policy = this.policy;
    // #6278: every kind has a budget with the switch on; off, only remember and intent-less put_page/edit_page (#5616) keep the 30 s one.
    const foregroundMs = this.opts.preparationMs ?? 30_000;
    const budget = policy.deadlines ? preparationBudgetMs(row, policy, foregroundMs) : preparationKind(row) === 'foreground' ? foregroundMs : undefined;
    // #6278: the clock carries the preparation's cancellation for `enterClaimStep` and, with the switch on, its deadline for the
    // server-side bound on lock-prone reads (boundedReads); a query takes the signal only on the foreground path (as before).
    const cancel = new AbortController();
    const clock = startClaimPhase(Date.now(), cancel.signal, policy.deadlines ? budget : undefined);
    // #6278: a request already at the attempt limit (a kill loop charged it at each reclaim) is finished without preparing again.
    if (policy.deadlines && (row.preparation_attempts ?? 0) >= policy.maxAttempts) {
      try {
        const previous = claimStateOf({ state: 'running', claim_phase: row.previous_claim_phase, execution_token: previousToken(row.previous_claim_phase) });
        const done = await finishPreparationStalled(this.engine, row, { step: previous?.step ?? null, waiting_on: previous?.waiting_on ?? 'unknown', limit: policy.maxAttempts }, false);
        this.log('preparation', 'preparation_stalled', failureLogText(done));
        return this.settled(done);
      } finally { this.preparing.delete(row.id); this.executing.delete(row.id); }
    }
    const prep = startPreparation(async signal => {
      signal.addEventListener('abort', () => cancel.abort(signal.reason), { once: true });
      await faultPoint('consumer:preparing', { requestId: row.request_id, sourceId: row.source_id, operation: row.operation, signal });
      // Phase 4.3: a single page write prepares against one config read instead of one per key.
      return this.prepare(this.engine.kind === 'postgres' && singleWrite(row)
        && await writeSwitchOn(this.engine, 'single_write_group').catch(() => true) ? await preparationConfigView(this.engine) : this.engine,
      row, this.config, budget !== undefined && preparationKind(row) === 'foreground' ? signal : undefined, clock);
    }, budget, { onDeadline: () => { observation.deadline_exceeded = true; this.log('preparation', 'deadline_exceeded'); } });
    const stop = () => prep.abort({ code: 'consumer_stopping' });
    this.abort.signal.addEventListener('abort', stop, { once: true });
    const lease = startClaimLease(
      signal => renewWriteClaim({ executeRaw: this.engine.executeRawDirect.bind(this.engine) }, row.id, row.execution_token!, this.opts.claimLeaseMs ?? 30_000,
        this.engine.kind === 'postgres' ? signal : undefined, claimPhaseStamp(clock, row.execution_token)),
      this.leaseTiming(), () => prep.abort({ code: 'claim_lost' }));
    const releaseReason = () => !lease.held ? 'claim_lost' : observation.deadline_exceeded ? 'preparation_deadline' : 'consumer_stopping';
    const stallInfo = () => ({ step: clock.step, waiting_on: clock.waitingOn, limit: policy.maxAttempts });
    // The budget passed (on the timer, or reported by a bounded read the server ended): the claim is released now, charged,
    // whether or not the preparer settles; its late result never publishes (#6278).
    const deadline = async (): Promise<boolean> => {
      root.until = this.abandonedRootBlock(row, clock, this.keepAbandoned(prep.work));
      if (!lease.held || this.stopping) { await releaseUnpublishedClaim(this.engine, row, releaseReason()); return false; }
      if ((row.preparation_attempts ?? 0) + 1 >= policy.maxAttempts) {
        const done = await finishPreparationStalled(this.engine, row, stallInfo(), true);
        this.log('preparation', 'preparation_stalled', failureLogText(done));
        return this.settled(done);
      }
      await releaseUnpublishedClaim(this.engine, row, 'preparation_deadline', { charge: true });
      return false;
    };
    try {
      // With the switch on the budget wins the race even against a preparer that ignores its signal; off, the preparer's own settlement decides.
      const raced = await lease.whileHeld(policy.deadlines ? prep.outcome : prep.work.then(result => ({ result })));
      if (raced === CLAIM_LOST) {
        root.until = this.abandonedRootBlock(row, clock, this.keepAbandoned(prep.work));
        await endLostLease(lease);
        await releaseUnpublishedClaim(this.engine, row, 'claim_lost');
        return false;
      }
      if ('deadline' in raced) return deadline();
      const prepared = raced.result;
      if (budget !== undefined && !prep.signal.aborted && prep.late()) prep.expire();
      if (!lease.held || this.stopping || prep.signal.aborted) {
        await releaseUnpublishedClaim(this.engine, row, releaseReason()); return false;
      }
      this.preparing.delete(row.id);
      preparationActive = false;
      enterClaimPhase(clock, 'publishing');
      await faultPoint('consumer:prepared', { requestId: row.request_id, sourceId: row.source_id, operation: row.operation });
      const { done, settled } = await this.publishSingle(row, prepared);
      if (done.state === 'failed') this.log('publication', done.error_code ?? 'storage_error', failureLogText(done));
      if (done.state === 'committed' && row.worktree_id && !String(row.intent?.kind).startsWith('managed_sync_')) {
        this.foregroundCounts.set(row.worktree_id, this.foregroundCompletions(row.worktree_id) + 1);
      }
      return settled ? isTerminal(done) : this.settled(done);
    } catch (error) {
      if (preparationActive && budget !== undefined && prep.late()) observation.deadline_exceeded = true;
      // #6278: a bounded read the server ended inside the budget (a shorter session lock_timeout) reports the deadline itself.
      if (preparationActive && policy.deadlines && !prep.signal.aborted && preparationAbortReason(error, prep.signal) === 'preparation_deadline') {
        prep.expire();
        return deadline();
      }
      // #6278: the preparer's rejection on our own abort (its reason, an AbortError, a cancelled statement) is a release, never a receipt.
      if (preparationActive && (prep.signal.aborted || observation.deadline_exceeded || preparationAbortReason(error, prep.signal))) {
        await releaseUnpublishedClaim(this.engine, row, releaseReason());
        return false;
      }
      const current = await getWriteRequestById(this.engine, row.id);
      if (current && !isTerminal(current) && current.execution_token === row.execution_token && !current.recovery) {
        const done = await finishUnpublishedFailure(this.engine, current, error, preparationActive ? 'preparation' : 'publication');
        if (done.state === 'failed') this.log(preparationActive ? 'preparation' : 'publication', done.error_code ?? 'storage_error', failureLogText(done));
        return this.settled(done);
      }
      throw error;
    } finally {
      const renewal = lease.end();
      if (renewal) this.keepUntilSettled(renewal);
      this.abort.signal.removeEventListener('abort', stop); this.preparing.delete(row.id); this.executing.delete(row.id);
    }
  }
  /** #5984: a claimed bulk sync head takes its directly following group members along; one row runs the single path. */
  private async executeOrGroup(row: WriteRequest, root: RootHold): Promise<boolean> {
    // #5984 admit-ahead: a window group whose predecessor did not commit is cancelled, never published after it.
    // A lane group may be claimed while its predecessor still publishes; its commit wait decides instead.
    // A bulk-sync group member released mid-group follows the member before it, not only the previous group (#6153 class).
    const lane = laneOf(row);
    const order = await claimedHeadOrder(this.engine, row, lane !== null);
    if (order === 'wait') { await releaseUnpublishedClaim(this.engine, row, 'group_member_waiting'); return false; }
    if (order) { for (const done of order) this.settled(done); return true; }
    const group = publicationGroupKey(row);
    if (!group || this.engine.kind !== 'postgres') return this.execute(row, root);
    // #6007: a put_pages batch publishes in groups of at most PAGE_BATCH_GROUP_MAX pages.
    const followers = await claimGroupFollowers(this.engine, row, group, group.startsWith('batch:') ? PAGE_BATCH_GROUP_MAX - 1 : 63);
    if (!followers.length && !lane) return this.execute(row, root);
    const rows = [row, ...followers];
    for (const member of rows) this.executing.add(member.id);
    try {
      return await executeClaimedGroup(this.engine, rows, { hostId: this.hostId, lane,
        prepare: (member, engine, signal, clock) => this.prepare(engine, member, this.config, signal, clock),
        lease: this.leaseTiming(), policy: this.policy, foregroundMs: this.opts.preparationMs ?? 30_000,
        leftRunning: (work, blocksRoot, abandoned) => {
          if (!blocksRoot) { this.keepUntilSettled(work); return; }
          // #6278: an abandoned member blocks its root until it settles or the ceiling passes; several abandoned members all hold it.
          const settled = this.keepAbandoned(work);
          const block = abandoned ? this.abandonedRootBlock(abandoned.row, abandoned.clock, settled) : settled;
          root.until = root.until ? Promise.all([root.until, block]).then(() => undefined) : block;
        },
        settled: done => {
          this.executing.delete(done.id);
          if (done.state === 'committed' && done.worktree_id && !String(done.intent?.kind).startsWith('managed_sync_')) {
            this.foregroundCounts.set(done.worktree_id, this.foregroundCompletions(done.worktree_id) + 1);
          }
          this.settled(done);
        } });
    } finally { for (const member of rows) this.executing.delete(member.id); }
  }
  /** Mandatory barrier: engine.close must be sequenced AFTER this promise. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.tickPromise;
    await this.releaseIdleLane();
    await Promise.allSettled([...this.active]);
    await this.releaseIdleLane();
    // #6278: abandoned preparations (their claims are released and their signals aborted) get a short grace, not forever;
    // renewals and publications in `outlived` keep their bounded waits.
    if (this.abandoned.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...this.abandoned]), new Promise<void>(resolve => { timer = setTimeout(resolve, ABANDONED_STOP_GRACE_MS); })]);
      if (timer) clearTimeout(timer);
    }
    while (this.outlived.size) await Promise.all([...this.outlived]);
    await this.projectionWorker;
    await this.effectsWorker;
    await this.topologyWorker;
    await this.maintenanceWorker;
    this.unobserveCheckout?.();
    this.unobserveCheckout = undefined;
    try { this.loopDelay?.disable(); } catch { /* fail-open */ }
    this.loopDelay = undefined;
  }
}
