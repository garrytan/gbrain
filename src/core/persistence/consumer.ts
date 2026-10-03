import type { BrainEngine, ReservedConnection } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { CLAIMABLE_WRITE_SQL, claimNextWrite, compactWriteReceipts, hasClaimableWrite, getWriteRequestById, releaseUnpublishedClaim, renewWriteClaim, vacuumPersistenceQueues } from './journal.ts';
import { finishUnpublishedFailure, publishMutation, recoverPublication, type PreparedMutation } from './coordinator.ts';
import { localHostId } from './identity.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { PROJECTION_RETRY_READY_SQL, rebuildPendingPageProjections } from '../page-state/projections.ts';
import { publicationConcurrency } from './pool-capacity.ts';
import { runPersistenceEffects } from './effects.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { isWriteErrorCode } from './types.ts';
import { redactConnectionInfo } from '../audit/redact-connection-info.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

type PhaseObservation = { name: string; started_at: string; deadline_exceeded: boolean; attempt: number; first_conn_ms?: number };
/** #5801: the phase a connection checkout belongs to, carried through its async chain. */
const phaseScope = new AsyncLocalStorage<{ observation: PhaseObservation; startedAt: number }>();

/** #5233: one-line, redacted, length-capped error text for the consumer's stderr line. */
function errorDetail(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string' || !message.trim()) return undefined;
  return redactConnectionInfo(message).replace(/\s+/g, ' ').replaceAll('"', "'").trim().slice(0, 200);
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

export type PrepareMutation = (engine: BrainEngine, row: WriteRequest, config: GBrainConfig, signal?: AbortSignal) => Promise<PreparedMutation>;
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
  private active = new Set<Promise<void>>();
  private abandoned = new Set<Promise<unknown>>();
  /** Roots whose abandoned preparation still runs; kept busy so the next request on the root waits. */
  private rootHolds = new Map<string, Promise<unknown>>();
  private activeRoots = new Set<string>();
  private foregroundCounts = new Map<string, number>();
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
  readonly hostId: string;
  constructor(readonly engine: BrainEngine, readonly config: GBrainConfig, readonly prepare: PrepareMutation,
    private opts: { hostId?: string; concurrency?: number; pollMs?: number; idleMaxMs?: number; phaseMs?: number; preparationMs?: number; renewalIntervalMs?: number; onError?: (error: unknown) => void } = {}) {
    this.hostId = opts.hostId ?? localHostId();
  }
  private get checkoutObservable(): ((listener: () => void) => () => void) | undefined {
    const engine = this.engine as { onCheckout?: unknown };
    return typeof engine.onCheckout === 'function' ? (engine.onCheckout as (listener: () => void) => () => void).bind(this.engine) : undefined;
  }
  start(): void { this.stopping = false; this.abort = new AbortController(); this.fullTickRequested = true; this.idleDelayMs = this.pollMs; this.schedule(0); }
  /**
   * Work admitted by this process: tick now instead of waiting out the idle
   * backoff. Like a completed publication, it claims at once and leaves scans
   * to at most one pass per poll interval.
   */
  wake(): void { this.progressWake = true; this.idleDelayMs = this.pollMs; this.schedule(0); }
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
    const [row] = await this.phase('idle_probe', async signal => this.probeQuery<{ work: boolean }>(await this.acquireIdleLane(signal), `SELECT (
      EXISTS (SELECT 1 FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
        WHERE ${CLAIMABLE_WRITE_SQL}
        AND ($3::boolean OR r.blocked_reason IS DISTINCT FROM 'writer_pool_capacity'))
      OR EXISTS (SELECT 1 FROM persistence_requests r JOIN persistence_worktrees w ON w.id=r.worktree_id
        WHERE w.owner_host_id=$1::uuid AND r.recovery IS NOT NULL AND NOT (r.worktree_id::text=ANY($2::text[])))
      OR EXISTS (SELECT 1 FROM persistence_requests r WHERE r.state='running' AND r.recovery IS NULL
        AND r.publication_started=false AND r.claim_expires_at<now()
        AND (r.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=r.worktree_id AND w.owner_host_id=$1::uuid)))
      OR EXISTS (SELECT 1 FROM persistence_effects e LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
        WHERE (e.state='queued' OR e.state='running' AND e.claim_expires_at<now()) AND e.next_attempt_at<=now()
        AND (e.worktree_id IS NULL OR w.owner_host_id=$1::uuid) AND e.recovery IS NULL
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
    ) AS work`, [this.hostId, excluded, publicationConcurrency(this.engine) > 0, retryingTopologies], signal));
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
  private async acquireIdleLane(signal?: AbortSignal): Promise<ReservedConnection | undefined> {
    if (this.idleLane) return this.idleLane.conn;
    if (this.engine.kind !== 'postgres' || this.stopping || Date.now() < this.idleLaneRetryAt) return undefined;
    const pool = (this.engine as { getPoolDiagnostics?: () => { poolMax: number | null; tracked: Record<string, number> } | null }).getPoolDiagnostics?.();
    // Only reserve from an otherwise idle pool: a saturated pool falls back to a cancellable pooled probe.
    if (!pool?.poolMax || pool.poolMax < 3 || Object.values(pool.tracked).some(count => count > 0)) return undefined;
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
    const lane = this.idleLane;
    this.idleLane = undefined;
    await lane?.release();
  }
  private async probeQuery<T>(lane: ReservedConnection | undefined, sql: string, params: unknown[], signal?: AbortSignal): Promise<T[]> {
    if (!lane) return this.engine.executeRaw<T>(sql, params, { signal });
    const query = lane.executeRaw<T>(sql, params);
    if (!signal) return query;
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    try { return await Promise.race([query, aborted.promise]); }
    catch (error) {
      // The reserved query cannot be cancelled: stop using the lane now, return it to the pool once the query settles.
      const current = this.idleLane;
      if (current?.conn === lane) this.idleLane = undefined;
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
          this.maintenanceWorker = compactWriteReceipts(this.engine).catch(error => this.report(error))
            .finally(() => { this.maintenanceWorker = undefined; });
        }
        return;
      }
    }
    await this.releaseIdleLane();
    this.idleDelayMs = this.pollMs;
    this.nextDelayMs = this.pollMs;
    const scan = !afterProgress || Date.now() - this.lastScan >= this.pollMs;
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
          if (!recovered.recovery) this.rootRetryAfter.delete(root);
          else if (recovered.blocked_reason === 'unexpected_file_bytes') this.rootRetryAfter.set(root, Date.now() + Math.max(delay, 30_000));
        } catch (error) {
          this.rootRetryAfter.set(root, Date.now() + Math.max(delay, 30_000));
          this.report(error);
        }
      }
      await this.phase('expired_claims', signal => this.engine.executeRaw(`WITH expired AS (
        SELECT r.id FROM persistence_requests r WHERE r.state='running' AND r.recovery IS NULL
        AND r.publication_started=false AND r.claim_expires_at<now() AND ${PERSISTENCE_PROTOCOL_PREDICATE}
        AND (r.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=r.worktree_id AND w.owner_host_id=$1::uuid))
        ORDER BY r.sequence LIMIT 100 FOR UPDATE OF r SKIP LOCKED)
        UPDATE persistence_requests r SET state='queued',execution_token=NULL,claim_expires_at=NULL
        FROM expired WHERE r.id=expired.id`, [this.hostId], { signal }));
    }
    if (publicationConcurrency(this.engine) === 0) {
      await this.phase('capacity', signal => this.engine.executeRaw(`UPDATE persistence_requests SET blocked_reason='writer_pool_capacity'
        WHERE state='queued' AND blocked_reason IS DISTINCT FROM 'writer_pool_capacity' AND ${PERSISTENCE_PROTOCOL_PREDICATE}`, undefined, { signal }));
      return;
    }
    const concurrency = this.opts.concurrency ?? 2;
    const attemptedRoots = new Set([...this.activeRoots, ...this.rootRetryAfter.keys()]);
    while (!this.stopping && this.active.size < concurrency) {
      const row = await this.phase('claim', () => claimNextWrite(this.engine, this.hostId, 30_000, [...attemptedRoots]));
      if (!row) break;
      if (this.stopping) { await releaseUnpublishedClaim(this.engine, row, 'consumer_stopping'); break; }
      const key = row.worktree_id ?? `db:${row.source_incarnation}`;
      attemptedRoots.add(key);
      if (this.activeRoots.has(key)) { await releaseUnpublishedClaim(this.engine, row, 'writer_busy'); break; }
      this.activeRoots.add(key);
      let progressed = false;
      const task = this.execute(row).then(result => { progressed = result; }).catch(error => this.report(error)).finally(() => {
        if (!progressed) this.rootRetryAfter.set(key, Date.now() + (this.opts.pollMs ?? 250));
        else { this.progressWake = true; this.publishedSinceMaintenance++; }
        this.active.delete(task);
        const hold = this.rootHolds.get(key);
        this.rootHolds.delete(key);
        if (hold) void hold.then(() => { this.activeRoots.delete(key); this.schedule(0); }, () => { this.activeRoots.delete(key); this.schedule(0); });
        else this.activeRoots.delete(key);
        this.schedule(progressed ? 0 : this.opts.pollMs ?? 250);
      });
      this.active.add(task);
    }
  }
  /** Effects keep pace with publication: full batches continue without waiting for the next tick. */
  private async drainEffects(): Promise<void> {
    const limit = 20;
    while (!this.stopping && await runPersistenceEffects(this.engine, this.config,
      { hostId: this.hostId, limit, signal: this.abort.signal }) >= limit);
  }
  foregroundCompletions(worktreeId: string): number { return this.foregroundCounts.get(worktreeId) ?? 0; }
  status() {
    return { accepting: !this.stopping, active_preparations: this.active.size, active_worktrees: this.activeRoots.size,
      sampled_at: new Date().toISOString(), observation_scope: 'current_process_reset_on_restart',
      preparation_attempts: this.preparationAttempts,
      phase: this.phaseObservation ? { ...this.phaseObservation, ...this.phaseTiming(this.phaseObservation, this.phaseStartedAt) } : null,
      preparations: [...this.preparing.values()].map(value => ({ ...value })),
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
      this.lastPhaseError = name; this.lastPhaseTiming = this.timingText(observation, startedAt); throw error;
    }
    finally { clearTimeout(timer); this.abort.signal.removeEventListener('abort', stop); this.phaseObservation = undefined; }
  }
  private report(error: unknown): void {
    if (this.stopping && error === this.abort.signal.reason) return;
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
  private drainOnStop(promise: Promise<unknown>): void {
    this.abandoned.add(promise);
    void promise.then(() => this.abandoned.delete(promise), () => this.abandoned.delete(promise));
  }
  private async execute(row: WriteRequest): Promise<boolean> {
    let renewing: Promise<void> | undefined;
    let claimLive = true;
    let closed = false;
    let preparationActive = true;
    const abort = new AbortController();
    const claimLost = Promise.withResolvers<void>();
    const loseClaim = () => {
      if (!claimLive) return;
      claimLive = false;
      abort.abort({ code: 'claim_lost' });
      claimLost.resolve();
    };
    const observation = { request_id: row.request_id, started_at: new Date().toISOString(), deadline_exceeded: false, attempt: ++this.preparationAttempts };
    this.preparing.set(row.id, observation);
    const stop = () => abort.abort({ code: 'consumer_stopping' });
    this.abort.signal.addEventListener('abort', stop, { once: true });
    // edit_page (#5616) builds its content during preparation like put_page, so it shares the deadline.
    const bounded = row.operation === 'remember' || (row.operation === 'put_page' || row.operation === 'edit_page') && !row.intent?.kind;
    const budget = this.opts.preparationMs ?? 30_000;
    const deadline = performance.now() + budget;
    const timeout = bounded ? setTimeout(() => {
      observation.deadline_exceeded = true;
      abort.abort({ code: 'preparation_deadline' });
      this.log('preparation', 'deadline_exceeded');
    }, budget) : undefined;
    const interval = setInterval(() => {
      if (closed || renewing) return;
      const renewalAbort = new AbortController();
      const deadline = setTimeout(() => { loseClaim(); renewalAbort.abort(); }, this.opts.phaseMs ?? 5000);
      let task!: Promise<void>;
      task = renewWriteClaim({ executeRaw: this.engine.executeRawDirect.bind(this.engine) }, row.id, row.execution_token!, 30_000,
        this.engine.kind === 'postgres' ? renewalAbort.signal : undefined).then(live => { if (!live) loseClaim(); })
        .catch(() => { loseClaim(); }).finally(() => { clearTimeout(deadline); if (renewing === task) renewing = undefined; });
      renewing = task;
    // Tests can shorten the lease-renewal cadence; production keeps the existing 10s cadence.
    }, this.opts.renewalIntervalMs ?? 10_000);
    interval.unref?.();
    try {
      const preparation = this.prepare(this.engine, row, this.config, bounded ? abort.signal : undefined)
        .then(prepared => ({ kind: 'prepared' as const, prepared }), error => ({ kind: 'error' as const, error }));
      const result = await Promise.race([preparation, claimLost.promise.then(() => ({ kind: 'claim_lost' as const }))]);
      if (result.kind === 'claim_lost') {
        this.drainOnStop(preparation);
        this.rootHolds.set(row.worktree_id ?? `db:${row.source_incarnation}`, preparation);
        await releaseUnpublishedClaim(this.engine, row, 'claim_lost');
        return false;
      }
      if (result.kind === 'error') throw result.error;
      const prepared = result.prepared;
      if (timeout) clearTimeout(timeout);
      if (bounded && performance.now() >= deadline && !abort.signal.aborted) {
        observation.deadline_exceeded = true;
        abort.abort({ code: 'preparation_deadline' });
        this.log('preparation', 'deadline_exceeded');
      }
      if (!claimLive || this.stopping || abort.signal.aborted) {
        await releaseUnpublishedClaim(this.engine, row, !claimLive ? 'claim_lost' : observation.deadline_exceeded ? 'preparation_deadline' : 'consumer_stopping'); return false;
      }
      this.preparing.delete(row.id);
      preparationActive = false;
      const done = await publishMutation(this.engine, row, prepared, this.hostId);
      if (done.state === 'committed' && row.worktree_id && !String(row.intent?.kind).startsWith('managed_sync_')) {
        this.foregroundCounts.set(row.worktree_id, this.foregroundCompletions(row.worktree_id) + 1);
      }
      return isTerminal(done);
    } catch (error) {
      if (preparationActive && bounded && performance.now() >= deadline) observation.deadline_exceeded = true;
      if (preparationActive && (abort.signal.aborted || observation.deadline_exceeded)) {
        await releaseUnpublishedClaim(this.engine, row, !claimLive ? 'claim_lost' : observation.deadline_exceeded ? 'preparation_deadline' : 'consumer_stopping');
        return false;
      }
      const current = await getWriteRequestById(this.engine, row.id);
      if (current && !isTerminal(current) && current.execution_token === row.execution_token && !current.recovery) {
        return isTerminal(await finishUnpublishedFailure(this.engine, current, error));
      }
      throw error;
    } finally {
      closed = true; clearInterval(interval); if (timeout) clearTimeout(timeout);
      this.abort.signal.removeEventListener('abort', stop); this.preparing.delete(row.id);
      if (renewing) this.drainOnStop(renewing);
    }
  }
  /** Mandatory barrier: engine.close must be sequenced AFTER this promise. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.tickPromise;
    await this.releaseIdleLane();
    await Promise.allSettled([...this.active]);
    while (this.abandoned.size) await Promise.allSettled([...this.abandoned]);
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
