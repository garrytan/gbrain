import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { claimNextWrite, compactWriteReceipts, getWriteRequestById, releaseUnpublishedClaim, renewWriteClaim } from './journal.ts';
import { finishUnpublishedFailure, publishMutation, recoverPublication, type PreparedMutation } from './coordinator.ts';
import { localHostId } from './identity.ts';
import { isTerminal, type WriteRequest } from './model.ts';
import { refreshManagedFilesystemRoots } from './filesystem-guard.ts';
import { rebuildPendingPageProjections } from '../page-state/projections.ts';
import { publicationConcurrency } from './pool-capacity.ts';
import { runPersistenceEffects } from './effects.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { isWriteErrorCode } from './types.ts';

export type PrepareMutation = (engine: BrainEngine, row: WriteRequest, config: GBrainConfig, signal?: AbortSignal) => Promise<PreparedMutation>;
export class PersistenceConsumer {
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tickPromise: Promise<void> | undefined;
  private wakeRequested = false;
  private active = new Set<Promise<void>>();
  private activeRoots = new Set<string>();
  private foregroundCounts = new Map<string, number>();
  private rootRetryAfter = new Map<string, number>();
  private projectionWorker: Promise<unknown> | undefined;
  private effectsWorker: Promise<void> | undefined;
  private topologyWorker: Promise<unknown> | undefined;
  private maintenanceWorker: Promise<unknown> | undefined;
  private nextMaintenance = 0;
  private lastError: { code: string; at: string; phase?: string } | undefined;
  private abort = new AbortController();
  private phaseObservation: { name: string; started_at: string; deadline_exceeded: boolean; attempt: number } | undefined;
  private phaseAttempts = 0;
  private lastLog: { key: string; at: number } | undefined;
  private lastPhaseError: string | undefined;
  private preparationAttempts = 0;
  private preparing = new Map<string, { request_id: string; started_at: string; deadline_exceeded: boolean; attempt: number }>();
  readonly hostId: string;
  constructor(readonly engine: BrainEngine, readonly config: GBrainConfig, readonly prepare: PrepareMutation,
    private opts: { hostId?: string; concurrency?: number; pollMs?: number; phaseMs?: number; preparationMs?: number; onError?: (error: unknown) => void } = {}) {
    this.hostId = opts.hostId ?? localHostId();
  }
  start(): void { this.stopping = false; this.abort = new AbortController(); this.schedule(0); }
  private schedule(ms: number): void {
    if (this.stopping) return;
    if (ms === 0 && this.tickPromise) { this.wakeRequested = true; return; }
    if (this.timer && ms !== 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().finally(() => this.schedule(this.opts.pollMs ?? 250)); }, ms);
    this.timer.unref?.();
  }
  async tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.doTick().catch(error => { this.report(error); }).finally(() => {
      this.tickPromise = undefined;
      if (this.wakeRequested) { this.wakeRequested = false; this.schedule(0); }
    });
    return this.tickPromise;
  }
  private async doTick(): Promise<void> {
    if (this.stopping) return;
    await this.phase('refresh_roots', signal => refreshManagedFilesystemRoots(this.engine,
      this.engine.kind === 'pglite' ? this.config.database_path : undefined, signal));
    if (this.stopping) return;
    if (!this.topologyWorker) this.topologyWorker = import('./topology-recovery.ts')
      .then(({ recoverSourceTopologies }) => recoverSourceTopologies(this.engine, { hostId: this.hostId, limit: 2 }))
      .catch(error => this.report(error)).finally(() => { this.topologyWorker = undefined; });
    if (!this.effectsWorker) this.effectsWorker = runPersistenceEffects(this.engine, this.config,
      { hostId: this.hostId, limit: 2, signal: this.abort.signal }).catch(error => this.report(error))
      .finally(() => { this.effectsWorker = undefined; });
    if (!this.maintenanceWorker && Date.now() >= this.nextMaintenance) {
      this.nextMaintenance = Date.now() + 60_000;
      this.maintenanceWorker = compactWriteReceipts(this.engine).catch(error => this.report(error))
        .finally(() => { this.maintenanceWorker = undefined; });
    }
    if (!this.projectionWorker) this.projectionWorker = rebuildPendingPageProjections(this.engine, 2)
      .catch(error => this.report(error)).finally(() => { this.projectionWorker = undefined; });
    // Recover only our owner roots. Kernel exclusion, not elapsed heartbeat,
    // proves that a previous process can no longer be publishing this root.
    const now = Date.now();
    for (const [root, retryAt] of this.rootRetryAfter) if (retryAt <= now) this.rootRetryAfter.delete(root);
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
        this.active.delete(task); this.activeRoots.delete(key); this.schedule(progressed ? 0 : this.opts.pollMs ?? 250);
      });
      this.active.add(task);
    }
  }
  foregroundCompletions(worktreeId: string): number { return this.foregroundCounts.get(worktreeId) ?? 0; }
  status() {
    return { accepting: !this.stopping, active_preparations: this.active.size, active_worktrees: this.activeRoots.size,
      sampled_at: new Date().toISOString(), observation_scope: 'current_process_reset_on_restart',
      preparation_attempts: this.preparationAttempts,
      phase: this.phaseObservation ? { ...this.phaseObservation } : null,
      preparations: [...this.preparing.values()].map(value => ({ ...value })),
      ...(this.lastError ? { last_error: { ...this.lastError } } : {}) };
  }
  private async phase<T>(name: string, run: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    const observation = { name, started_at: new Date().toISOString(), deadline_exceeded: false, attempt: ++this.phaseAttempts };
    this.phaseObservation = observation;
    const abort = new AbortController();
    const stop = () => abort.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort', stop, { once: true });
    if (this.stopping) stop();
    const timer = setTimeout(() => { observation.deadline_exceeded = true; abort.abort(); this.log(name, 'deadline_exceeded'); }, this.opts.phaseMs ?? 5000);
    try { return await run(this.engine.kind === 'postgres' ? abort.signal : undefined); }
    catch (error) {
      const cancelled = error as { name?: unknown; code?: unknown; message?: unknown } | null;
      if (this.stopping && abort.signal.aborted && abort.signal.reason === this.abort.signal.reason
        && (error === abort.signal.reason || cancelled?.name === 'AbortError'
          || cancelled?.code === '57014' && typeof cancelled.message === 'string'
            && /^(?:57014: )?canceling statement due to user request$/.test(cancelled.message))) {
        throw this.abort.signal.reason;
      }
      this.lastPhaseError = name; throw error;
    }
    finally { clearTimeout(timer); this.abort.signal.removeEventListener('abort', stop); this.phaseObservation = undefined; }
  }
  private report(error: unknown): void {
    if (this.stopping && error === this.abort.signal.reason) return;
    const code = (error as { code?: unknown })?.code;
    this.lastError = { code: typeof code === 'string' && (/^[A-Z0-9]{5}$/.test(code) || isWriteErrorCode(code)) ? code : 'storage_error', at: new Date().toISOString(),
      ...(this.lastPhaseError ? { phase: this.lastPhaseError } : {}) };
    if (this.opts.onError) this.opts.onError(error);
    else this.log(this.lastPhaseError ?? 'execution', this.lastError.code);
    this.lastPhaseError = undefined;
  }
  private log(phase: string, code: string): void {
    const key = `${phase}:${code}`, at = Date.now();
    if (this.lastLog && (at - this.lastLog.at < 1000 || this.lastLog.key === key && at - this.lastLog.at < 30_000)) return;
    this.lastLog = { key, at };
    if (!this.opts.onError) process.stderr.write(`[persistence] phase=${phase} reason=${code}; unfinished work remains tracked; inspect writer status.\n`);
  }
  private async execute(row: WriteRequest): Promise<boolean> {
    let renewing: Promise<unknown> | undefined;
    let claimLive = true;
    let closed = false;
    let preparationActive = true;
    const abort = new AbortController();
    const observation = { request_id: row.request_id, started_at: new Date().toISOString(), deadline_exceeded: false, attempt: ++this.preparationAttempts };
    this.preparing.set(row.id, observation);
    const stop = () => abort.abort({ code: 'consumer_stopping' });
    this.abort.signal.addEventListener('abort', stop, { once: true });
    const bounded = row.operation === 'remember' || row.operation === 'put_page' && !row.intent?.kind;
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
      const deadline = setTimeout(() => { claimLive = false; renewalAbort.abort(); }, this.opts.phaseMs ?? 5000);
      renewing = renewWriteClaim({ executeRaw: this.engine.executeRawDirect.bind(this.engine) }, row.id, row.execution_token!, 30_000,
        this.engine.kind === 'postgres' ? renewalAbort.signal : undefined).then(live => { claimLive &&= live; })
        .catch(() => { claimLive = false; }).finally(() => { clearTimeout(deadline); renewing = undefined; });
    }, 10_000);
    interval.unref?.();
    try {
      const prepared = await this.prepare(this.engine, row, this.config, bounded ? abort.signal : undefined);
      if (timeout) clearTimeout(timeout);
      if (bounded && performance.now() >= deadline && !abort.signal.aborted) {
        observation.deadline_exceeded = true;
        abort.abort({ code: 'preparation_deadline' });
        this.log('preparation', 'deadline_exceeded');
      }
      if (!claimLive || this.stopping || abort.signal.aborted) {
        await releaseUnpublishedClaim(this.engine, row, observation.deadline_exceeded ? 'preparation_deadline' : 'consumer_stopping'); return false;
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
        await releaseUnpublishedClaim(this.engine, row, observation.deadline_exceeded ? 'preparation_deadline' : 'consumer_stopping');
        return false;
      }
      const current = await getWriteRequestById(this.engine, row.id);
      if (current && !isTerminal(current) && current.execution_token === row.execution_token && !current.recovery) {
        return isTerminal(await finishUnpublishedFailure(this.engine, current, error));
      }
      throw error;
    } finally {
      closed = true; clearInterval(interval); if (timeout) clearTimeout(timeout);
      this.abort.signal.removeEventListener('abort', stop); this.preparing.delete(row.id); await renewing;
    }
  }
  /** Mandatory barrier: engine.close must be sequenced AFTER this promise. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.tickPromise;
    await Promise.allSettled([...this.active]);
    await this.projectionWorker;
    await this.effectsWorker;
    await this.topologyWorker;
    await this.maintenanceWorker;
  }
}
