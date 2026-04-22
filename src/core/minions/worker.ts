/**
 * MinionWorker — Concurrent in-process job worker with BullMQ-inspired patterns.
 *
 * Processes up to `concurrency` jobs simultaneously using a Promise pool.
 * Each job gets its own AbortController, lock renewal timer, and isolated state.
 *
 * Usage:
 *   const worker = new MinionWorker(engine);
 *   worker.register('sync', async (job) => { ... });
 *   worker.register('embed', async (job) => { ... });
 *   await worker.start(); // polls until SIGTERM
 */

import type { BrainEngine } from '../engine.ts';
import type {
  MinionJob, MinionJobContext, MinionHandler, MinionWorkerOpts,
  MinionQueueOpts, TokenUpdate,
} from './types.ts';
import { UnrecoverableError } from './types.ts';
import { MinionQueue } from './queue.ts';
import { calculateBackoff } from './backoff.ts';
import { randomUUID } from 'crypto';
import { evaluateQuietHours, type QuietHoursConfig } from './quiet-hours.ts';

/**
 * Read the quiet_hours JSONB column off a MinionJob, if present. The
 * column was added in schema migration v12; older rows + versions of
 * MinionJob that don't include the field return null.
 */
function readQuietHoursConfig(job: MinionJob): QuietHoursConfig | null {
  const cfg = (job as MinionJob & { quiet_hours?: unknown }).quiet_hours;
  if (!cfg || typeof cfg !== 'object') return null;
  return cfg as unknown as QuietHoursConfig;
}

/** Per-job in-flight state (isolated per job, not shared on the worker). */
interface InFlightJob {
  job: MinionJob;
  lockToken: string;
  lockTimer: ReturnType<typeof setInterval>;
  abort: AbortController;
  promise: Promise<void>;
}

export class MinionWorker {
  private queue: MinionQueue;
  private handlers = new Map<string, MinionHandler>();
  private running = false;
  private inFlight = new Map<number, InFlightJob>();
  private workerId = randomUUID();

  /** Fires only on worker process SIGTERM/SIGINT. Handlers that need to run
   *  shutdown-specific cleanup (e.g. shell handler's SIGTERM→SIGKILL sequence on
   *  its child) subscribe via `ctx.shutdownSignal`. Separated from the per-job
   *  abort controller so non-shell handlers don't get cancelled mid-flight on
   *  deploy restart — they still get the full 30s cleanup race instead. */
  private shutdownAbort = new AbortController();

  private opts: Required<MinionWorkerOpts>;

  constructor(
    private engine: BrainEngine,
    opts?: MinionWorkerOpts & MinionQueueOpts,
  ) {
    this.queue = new MinionQueue(engine, {
      maxSpawnDepth: opts?.maxSpawnDepth,
      maxAttachmentBytes: opts?.maxAttachmentBytes,
    });
    this.opts = {
      queue: opts?.queue ?? 'default',
      concurrency: opts?.concurrency ?? 1,
      lockDuration: opts?.lockDuration ?? 30000,
      stalledInterval: opts?.stalledInterval ?? 30000,
      maxStalledCount: opts?.maxStalledCount ?? 1,
      pollInterval: opts?.pollInterval ?? 5000,
    };
  }

  /** Register a handler for a job type. */
  register(name: string, handler: MinionHandler): void {
    this.handlers.set(name, handler);
  }

  /** Get registered handler names (used by claim query). */
  get registeredNames(): string[] {
    return Array.from(this.handlers.keys());
  }

  /** Start the worker loop. Blocks until stopped. */
  async start(): Promise<void> {
    if (this.handlers.size === 0) {
      throw new Error('No handlers registered. Call worker.register(name, handler) before start().');
    }

    await this.queue.ensureSchema();
    this.running = true;

    // Graceful shutdown. Fires shutdownAbort so handlers subscribed to
    // `ctx.shutdownSignal` (currently: shell handler) can run their own cleanup
    // BEFORE the 30s cleanup race expires. Non-shell handlers ignore shutdown
    // and keep running — they get the full 30s window.
    const shutdown = () => {
      console.log('Minion worker shutting down...');
      this.running = false;
      if (!this.shutdownAbort.signal.aborted) {
        this.shutdownAbort.abort(new Error('shutdown'));
      }
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Stall + timeout detection on interval. Order matters: handleStalled FIRST
    // so a stalled job (lock_until expired) gets requeued before handleTimeouts'
    // `lock_until > now()` guard would skip it. Stall → retry, timeout → dead.
    const stalledTimer = setInterval(async () => {
      try {
        const { requeued, dead } = await this.queue.handleStalled();
        if (requeued.length > 0) console.log(`Stall detector: requeued ${requeued.length} jobs`);
        if (dead.length > 0) console.log(`Stall detector: dead-lettered ${dead.length} jobs`);
      } catch (e) {
        console.error('Stall detection error:', e instanceof Error ? e.message : String(e));
      }
      try {
        const timedOut = await this.queue.handleTimeouts();
        if (timedOut.length > 0) console.log(`Timeout detector: dead-lettered ${timedOut.length} jobs (timeout exceeded)`);
      } catch (e) {
        console.error('Timeout detection error:', e instanceof Error ? e.message : String(e));
      }
    }, this.opts.stalledInterval);

    try {
      while (this.running) {
        // Promote delayed jobs
        try {
          await this.queue.promoteDelayed();
        } catch (e) {
          console.error('Promotion error:', e instanceof Error ? e.message : String(e));
        }

        // Claim jobs up to concurrency limit
        if (this.inFlight.size < this.opts.concurrency) {
          const lockToken = `${this.workerId}:${Date.now()}`;
          const job = await this.queue.claim(
            lockToken,
            this.opts.lockDuration,
            this.opts.queue,
            this.registeredNames,
          );

          if (job) {
            // Quiet-hours gate: evaluated at claim time, not dispatch.
            // Config lives on the job record (jsonb column added in
            // schema migration v12). Worker releases the job back to the
            // queue on 'defer' or marks it cancelled on 'skip'.
            const quietCfg = readQuietHoursConfig(job);
            const verdict = evaluateQuietHours(quietCfg);
            if (verdict !== 'allow') {
              await this.handleQuietHoursDefer(job, lockToken, verdict);
            } else {
              this.launchJob(job, lockToken);
            }
          } else if (this.inFlight.size === 0) {
            // No jobs and nothing in flight, poll
            await new Promise(resolve => setTimeout(resolve, this.opts.pollInterval));
          } else {
            // Jobs are running but no new ones available, brief pause before re-checking
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } else {
          // At concurrency limit, wait briefly before re-checking for free slots
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } finally {
      clearInterval(stalledTimer);
      process.removeListener('SIGTERM', shutdown);
      process.removeListener('SIGINT', shutdown);

      // Graceful shutdown: wait for all in-flight jobs with timeout
      if (this.inFlight.size > 0) {
        console.log(`Waiting for ${this.inFlight.size} in-flight job(s) to finish (30s timeout)...`);
        const pending = Array.from(this.inFlight.values()).map(f => f.promise);
        await Promise.race([
          Promise.allSettled(pending),
          new Promise(resolve => setTimeout(resolve, 30000)),
        ]);
      }

      console.log('Minion worker stopped.');
    }
  }

  /**
   * Called when a claimed job falls inside its quiet-hours window. The
   * claim already set status='active' and held the lock; we reverse the
   * state transition (defer) or cancel outright (skip).
   *
   * 'defer' → status='waiting', lock cleared, delay_until bumped ahead by
   *   15 minutes so the same job doesn't immediately re-claim. Jobs will
   *   naturally pick up again once `now` exits the quiet window.
   * 'skip' → status='cancelled', final_status='skipped_quiet_hours'. The
   *   event is dropped.
   */
  private async handleQuietHoursDefer(job: MinionJob, lockToken: string, verdict: 'skip' | 'defer'): Promise<void> {
    try {
      if (verdict === 'skip') {
        // Route through MinionQueue.cancelJob so parent jobs in waiting-children
        // see the cancellation and roll up correctly. A direct status='cancelled'
        // UPDATE strands parents forever (no inbox, no dependency resolution).
        // Release our lock first so cancelJob's descendant walk sees a clean state.
        await this.engine.executeRaw(
          `UPDATE minion_jobs SET lock_token = NULL, lock_until = NULL, updated_at = now()
           WHERE id = $1 AND lock_token = $2`,
          [job.id, lockToken],
        );
        try {
          await this.queue.cancelJob(job.id);
        } catch {
          // cancelJob best-effort — if the parent rollup path errors, we still
          // want the job out of 'active' rather than re-claimed on next tick.
          await this.engine.executeRaw(
            `UPDATE minion_jobs
             SET status = 'cancelled', error_text = 'skipped_quiet_hours', updated_at = now()
             WHERE id = $1 AND status NOT IN ('completed','failed','dead')`,
            [job.id],
          );
        }
        console.log(`Quiet-hours skip: ${job.name} (id=${job.id})`);
      } else {
        // Defer: release back to delayed, push delay ~15 minutes to avoid
        // immediate re-claim loops when the claim query re-runs.
        await this.engine.executeRaw(
          `UPDATE minion_jobs
           SET status = 'delayed', lock_token = NULL, lock_until = NULL,
               delay_until = now() + interval '15 minutes',
               updated_at = now()
           WHERE id = $1 AND lock_token = $2`,
          [job.id, lockToken],
        );
        console.log(`Quiet-hours defer: ${job.name} (id=${job.id}) → retry after 15m`);
      }
    } catch (e) {
      console.error(`handleQuietHoursDefer error for job ${job.id}:`, e instanceof Error ? e.message : String(e));
    }
  }

  /** Stop the worker gracefully. */
  stop(): void {
    this.running = false;
  }

  /** Launch a job as an independent in-flight promise. */
  private launchJob(job: MinionJob, lockToken: string): void {
    const abort = new AbortController();

    // Start lock renewal (per-job timer, not shared)
    const lockTimer = setInterval(async () => {
      const renewed = await this.queue.renewLock(job.id, lockToken, this.opts.lockDuration);
      if (!renewed) {
        console.warn(`Lock lost for job ${job.id}, aborting execution`);
        clearInterval(lockTimer);
        abort.abort(new Error('lock-lost'));
      }
    }, this.opts.lockDuration / 2);

    // Per-job wall-clock timeout safety net. Cooperative: fires abort() so the
    // handler's signal flips. Handlers ignoring AbortSignal can't be force-killed
    // from JS; the DB-side handleTimeouts is the authoritative status flip.
    // The .finally clearTimeout below ensures process exit isn't delayed by a
    // dangling timer on normal completion.
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    if (job.timeout_ms != null) {
      timeoutTimer = setTimeout(() => {
        if (!abort.signal.aborted) {
          console.warn(`Job ${job.id} (${job.name}) hit per-job timeout (${job.timeout_ms}ms), aborting`);
          abort.abort(new Error('timeout'));
        }
      }, job.timeout_ms);
    }

    const promise = this.executeJob(job, lockToken, abort, lockTimer)
      .finally(() => {
        clearInterval(lockTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this.inFlight.delete(job.id);
      });

    this.inFlight.set(job.id, { job, lockToken, lockTimer, abort, promise });
  }

  private async executeJob(
    job: MinionJob,
    lockToken: string,
    abort: AbortController,
    lockTimer: ReturnType<typeof setInterval>,
  ): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) {
      await this.queue.failJob(job.id, lockToken, `No handler for job type '${job.name}'`, 'dead');
      return;
    }

    // Build job context with per-job AbortSignal + shared shutdown signal.
    // Most handlers only care about `signal` (timeout / cancel / lock-loss).
    // `shutdownSignal` is separate: fires only on worker process SIGTERM/SIGINT.
    // Handlers that need to run cleanup before worker exit (shell handler's
    // SIGTERM→5s→SIGKILL on its child) subscribe to shutdownSignal too.
    const context: MinionJobContext = {
      id: job.id,
      name: job.name,
      data: job.data,
      attempts_made: job.attempts_made,
      signal: abort.signal,
      shutdownSignal: this.shutdownAbort.signal,
      updateProgress: async (progress: unknown) => {
        await this.queue.updateProgress(job.id, lockToken, progress);
      },
      updateTokens: async (tokens: TokenUpdate) => {
        await this.queue.updateTokens(job.id, lockToken, tokens);
      },
      log: async (message: string | Record<string, unknown>) => {
        const value = typeof message === 'string' ? message : JSON.stringify(message);
        await this.engine.executeRaw(
          `UPDATE minion_jobs SET stacktrace = COALESCE(stacktrace, '[]'::jsonb) || to_jsonb($1::text),
            updated_at = now()
           WHERE id = $2 AND status = 'active' AND lock_token = $3`,
          [value, job.id, lockToken]
        );
      },
      isActive: async () => {
        const rows = await this.engine.executeRaw<{ id: number }>(
          `SELECT id FROM minion_jobs WHERE id = $1 AND status = 'active' AND lock_token = $2`,
          [job.id, lockToken]
        );
        return rows.length > 0;
      },
      readInbox: async () => {
        return this.queue.readInbox(job.id, lockToken);
      },
    };

    try {
      const result = await handler(context);

      clearInterval(lockTimer);

      // Complete the job (token-fenced)
      const completed = await this.queue.completeJob(
        job.id,
        lockToken,
        result != null ? (typeof result === 'object' ? result as Record<string, unknown> : { value: result }) : undefined,
      );

      if (!completed) {
        console.warn(`Job ${job.id} completion dropped (lock token mismatch, job was reclaimed)`);
        return;
      }
      // resolveParent is folded into queue.completeJob() (same transaction as
      // status flip + token rollup + child_done), so a process crash here can't
      // strand the parent in waiting-children.
    } catch (err) {
      clearInterval(lockTimer);

      // If the per-job abort fired, derive the reason from signal.reason (set
      // by whichever site aborted: 'timeout' / 'cancel' / 'lock-lost'). We call
      // failJob unconditionally — the DB match on status='active' + lock_token
      // makes it idempotent: if another path (handleTimeouts, cancelJob, stall)
      // already flipped status, our call no-ops cleanly. The prior silent-return
      // left jobs stranded in 'active' until a secondary sweep, breaking
      // timeout/cancel contracts downstream callers rely on.
      let errorText: string;
      if (abort.signal.aborted) {
        const reason = abort.signal.reason instanceof Error
          ? abort.signal.reason.message
          : String(abort.signal.reason || 'aborted');
        errorText = `aborted: ${reason}`;
      } else {
        errorText = err instanceof Error ? err.message : String(err);
      }

      const isUnrecoverable = err instanceof UnrecoverableError;
      const attemptsExhausted = job.attempts_made + 1 >= job.max_attempts;

      let newStatus: 'delayed' | 'failed' | 'dead';
      if (isUnrecoverable || attemptsExhausted) {
        newStatus = 'dead';
      } else {
        newStatus = 'delayed';
      }

      const backoffMs = newStatus === 'delayed' ? calculateBackoff({
        backoff_type: job.backoff_type,
        backoff_delay: job.backoff_delay,
        backoff_jitter: job.backoff_jitter,
        attempts_made: job.attempts_made + 1,
      }) : 0;

      const failed = await this.queue.failJob(job.id, lockToken, errorText, newStatus, backoffMs);
      if (!failed) {
        console.warn(`Job ${job.id} failure dropped (lock token mismatch)`);
        return;
      }
      // Parent-failure hook (fail_parent / remove_dep / ignore / continue) is
      // folded into queue.failJob() in the same transaction as the child status
      // flip + remove_on_fail delete. Worker stays out of multi-statement
      // crash-window territory.

      if (newStatus === 'delayed') {
        console.log(`Job ${job.id} (${job.name}) failed, retrying in ${Math.round(backoffMs)}ms (attempt ${job.attempts_made + 1}/${job.max_attempts})`);
      } else {
        console.log(`Job ${job.id} (${job.name}) permanently failed: ${errorText}`);
      }
    }
  }
}
