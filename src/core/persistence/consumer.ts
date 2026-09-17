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

export type PrepareMutation = (engine: BrainEngine, row: WriteRequest, config: GBrainConfig) => Promise<PreparedMutation>;
export class PersistenceConsumer {
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tickPromise: Promise<void> | undefined;
  private active = new Set<Promise<void>>();
  private activeRoots = new Set<string>();
  private foregroundCounts = new Map<string, number>();
  private recoveryRetryAfter = new Map<string, number>();
  private projectionWorker: Promise<unknown> | undefined;
  private effectsWorker: Promise<void> | undefined;
  private topologyWorker: Promise<unknown> | undefined;
  private maintenanceWorker: Promise<unknown> | undefined;
  private nextMaintenance = 0;
  private lastError: { code: string; at: string } | undefined;
  private abort = new AbortController();
  readonly hostId: string;
  constructor(readonly engine: BrainEngine, readonly config: GBrainConfig, readonly prepare: PrepareMutation,
    private opts: { hostId?: string; concurrency?: number; pollMs?: number; onError?: (error: unknown) => void } = {}) {
    this.hostId = opts.hostId ?? localHostId();
  }
  start(): void { this.stopping = false; this.abort = new AbortController(); this.schedule(0); }
  private schedule(ms: number): void {
    if (this.stopping || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick().finally(() => this.schedule(this.opts.pollMs ?? 250)); }, ms);
    this.timer.unref?.();
  }
  async tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.doTick().catch(error => { this.report(error); }).finally(() => { this.tickPromise = undefined; });
    return this.tickPromise;
  }
  private async doTick(): Promise<void> {
    if (this.stopping) return;
    await refreshManagedFilesystemRoots(this.engine, this.engine.kind === 'pglite' ? this.config.database_path : undefined);
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
    for (const [root, retryAt] of this.recoveryRetryAfter) if (retryAt <= now) this.recoveryRetryAfter.delete(root);
    const excluded = [...this.activeRoots, ...this.recoveryRetryAfter.keys()];
    const recovery = await this.engine.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r
      JOIN persistence_worktrees w ON w.id=r.worktree_id
      WHERE w.owner_host_id=$1::uuid AND r.recovery IS NOT NULL AND NOT(r.worktree_id::text=ANY($2::text[]))
      AND NOT EXISTS (SELECT 1 FROM persistence_requests earlier WHERE earlier.worktree_id=r.worktree_id
        AND earlier.recovery IS NOT NULL AND earlier.sequence<r.sequence)
      ORDER BY r.updated_at,r.sequence LIMIT 16`, [this.hostId, excluded]);
    for (const row of recovery) {
      const root = row.worktree_id!;
      // Always skip at least the next scheduled poll for an unresolved root.
      // This preserves its FIFO head while allowing the next root into LIMIT 16.
      const delay = Math.max(1000, (this.opts.pollMs ?? 250) * 2);
      this.recoveryRetryAfter.set(root, Date.now() + delay);
      try {
        const recovered = await recoverPublication(this.engine, row.id, this.hostId);
        if (!recovered.recovery) this.recoveryRetryAfter.delete(root);
        else if (recovered.blocked_reason === 'unexpected_file_bytes') this.recoveryRetryAfter.set(root, Date.now() + Math.max(delay, 30_000));
      } catch (error) {
        this.recoveryRetryAfter.set(root, Date.now() + Math.max(delay, 30_000));
        this.report(error);
      }
    }
    await this.engine.executeRaw(`UPDATE persistence_requests r SET state='queued',execution_token=NULL,claim_expires_at=NULL
      WHERE r.state='running' AND r.recovery IS NULL AND r.claim_expires_at<now()
      AND (r.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=r.worktree_id AND w.owner_host_id=$1::uuid))`, [this.hostId]);
    if (publicationConcurrency(this.engine) === 0) {
      await this.engine.executeRaw(`UPDATE persistence_requests SET blocked_reason='writer_pool_capacity'
        WHERE state='queued' AND blocked_reason IS DISTINCT FROM 'writer_pool_capacity'`);
      return;
    }
    const concurrency = this.opts.concurrency ?? 2;
    const attemptedRoots = new Set(this.activeRoots);
    while (!this.stopping && this.active.size < concurrency) {
      const row = await claimNextWrite(this.engine, this.hostId, 30_000, [...attemptedRoots]);
      if (!row) break;
      const key = row.worktree_id ?? `db:${row.source_incarnation}`;
      attemptedRoots.add(key);
      if (this.activeRoots.has(key)) { await releaseUnpublishedClaim(this.engine, row, 'writer_busy'); break; }
      this.activeRoots.add(key);
      const task = this.execute(row).catch(error => this.report(error)).finally(() => {
        this.active.delete(task); this.activeRoots.delete(key); this.schedule(0);
      });
      this.active.add(task);
    }
  }
  foregroundCompletions(worktreeId: string): number { return this.foregroundCounts.get(worktreeId) ?? 0; }
  status(): { accepting: boolean; active_preparations: number; active_worktrees: number; last_error?: { code: string; at: string } } {
    return { accepting: !this.stopping, active_preparations: this.active.size, active_worktrees: this.activeRoots.size,
      ...(this.lastError ? { last_error: { ...this.lastError } } : {}) };
  }
  private report(error: unknown): void {
    const code = (error as { code?: unknown })?.code;
    this.lastError = { code: typeof code === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(code) ? code : 'storage_error', at: new Date().toISOString() };
    if (this.opts.onError) this.opts.onError(error);
    else process.stderr.write('[persistence] Consumer paused after a storage error; inspect writer status.\n');
  }
  private async execute(row: WriteRequest): Promise<void> {
    let renewing: Promise<unknown> | undefined;
    let claimLive = true;
    let closed = false;
    const interval = setInterval(() => {
      if (closed || renewing) return;
      renewing = renewWriteClaim({ executeRaw: this.engine.executeRawDirect.bind(this.engine) }, row.id, row.execution_token!).then(live => { claimLive &&= live; })
        .catch(() => { claimLive = false; }).finally(() => { renewing = undefined; });
    }, 10_000);
    interval.unref?.();
    try {
      const prepared = await this.prepare(this.engine, row, this.config);
      if (!claimLive || this.stopping) { await releaseUnpublishedClaim(this.engine, row, 'consumer_stopping'); return; }
      const done = await publishMutation(this.engine, row, prepared, this.hostId);
      if (done.state === 'committed' && row.worktree_id && !String(row.intent?.kind).startsWith('managed_sync_')) {
        this.foregroundCounts.set(row.worktree_id, this.foregroundCompletions(row.worktree_id) + 1);
      }
    } catch (error) {
      const current = await getWriteRequestById(this.engine, row.id);
      if (current && !isTerminal(current) && current.execution_token === row.execution_token && !current.recovery) await finishUnpublishedFailure(this.engine, current, error);
      else throw error;
    } finally { closed = true; clearInterval(interval); await renewing; }
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
