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
import { EventEmitter } from 'events';
import { evaluateQuietHours, type QuietHoursConfig } from './quiet-hours.ts';

/** Reason payload emitted with `'unhealthy'` when self-health-check trips.
 *  CLI layer (jobs.ts:work) subscribes and decides whether to call process.exit. */
export type UnhealthyReason =
  | { reason: 'db_dead'; consecutiveFailures: number; message: string }
  | { reason: 'stalled'; waitingCount: number; idleMinutes: number };

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

/** Type-safe `on('unhealthy', ...)` for callers. */
export interface MinionWorker {
  on(event: 'unhealthy', listener: (info: UnhealthyReason) => void): this;
  emit(event: 'unhealthy', info: UnhealthyReason): boolean;
}

export class MinionWorker extends EventEmitter {
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

  /** Cumulative jobs that finished (success or failure). Used in watchdog log lines. */
  private jobsCompleted = 0;
  /** Idempotency latch for gracefulShutdown — per-job and periodic check sites can race. */
  private gracefulShutdownFired = false;

  private opts: Required<MinionWorkerOpts>;

  constructor(
    private engine: BrainEngine,
    opts?: MinionWorkerOpts & MinionQueueOpts,
  ) {
    super();
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
      maxRssMb: opts?.maxRssMb ?? 0,
      getRss: opts?.getRss ?? (() => process.memoryUsage().rss),
      rssCheckInterval: opts?.rssCheckInterval ?? 60000,
      healthCheckInterval: opts?.healthCheckInterval ?? 60000,
      stallWarnAfterMs: opts?.stallWarnAfterMs ?? 5 * 60_000,
      stallExitAfterMs: opts?.stallExitAfterMs ?? 10 * 60_000,
      dbFailExitAfter: opts?.dbFailExitAfter ?? 3,
      dbProbeTimeoutMs: opts?.dbProbeTimeoutMs ?? 10_000,
    };
    // Stall thresholds contract: exit MUST be strictly greater than warn.
    // If exit <= warn, the warn-then-exit semantics break: a single tick at
    // idle > warn would set stallWarningSince and the subsequent tick at
    // idle > exit could fire immediately without giving operators visibility.
    // Reject misconfigurations at construction time so the failure mode is
    // a loud throw on startup rather than a quiet contract violation.
    if (this.opts.stallExitAfterMs <= this.opts.stallWarnAfterMs) {
      throw new Error(
        `MinionWorkerOpts: stallExitAfterMs (${this.opts.stallExitAfterMs}) must be > ` +
        `stallWarnAfterMs (${this.opts.stallWarnAfterMs}). ` +
        `The contract is "warn first, exit later" — they cannot fire on the same tick.`,
      );
    }
  }

  /** Register a handler for a job type. */
  register(name: string, handler: MinionHandler): void {
    this.handlers.set(name, handler);
  }

  /** Get registered handler names (used by claim query). */
  get registeredNames(): string[] {
    return Array.from(this.handlers.keys());
  }

  /** Emit 'unhealthy' with a no-listener fallback. The default contract is
   *  fail-stop: pre-EventEmitter-refactor behavior was process.exit(1) inside
   *  the timer; the refactor moved that responsibility to the CLI subscriber.
   *  But direct API consumers without a listener would see emit() become a
   *  no-op AND `healthExited=true` permanently disabling monitoring — a
   *  silent regression. Solution: if no one subscribed, log and exit
   *  ourselves so the worker dies and the PM restarts it. Subscribers
   *  override this default by adding a listener before start(). */
  private emitUnhealthy(info: UnhealthyReason): void {
    if (this.listenerCount('unhealthy') === 0) {
      const detail = info.reason === 'db_dead'
        ? `DB unreachable (${info.consecutiveFailures} probes): ${info.message}`
        : `worker stalled (${info.waitingCount} waiting, ${info.idleMinutes}m idle)`;
      console.error(
        `[health] FATAL: ${detail}. No 'unhealthy' listener registered; ` +
        `defaulting to process.exit(1) for process-manager restart.`,
      );
      process.exit(1);
    }
    this.emit('unhealthy', info);
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
      try {
        const wallClockTimedOut = await this.queue.handleWallClockTimeouts(this.opts.lockDuration);
        if (wallClockTimedOut.length > 0) {
          console.log(`Wall-clock detector: dead-lettered ${wallClockTimedOut.length} jobs (wall-clock timeout exceeded)`);
        }
      } catch (e) {
        console.error('Wall-clock timeout detection error:', e instanceof Error ? e.message : String(e));
      }
    }, this.opts.stalledInterval);

    // Periodic RSS watchdog — closes the production-freeze regression where
    // all concurrency slots are wedged with zero job completions, so the
    // per-job check in executeJob().finally() never fires. Disabled when
    // maxRssMb is 0 (default for bare `gbrain jobs work`; supervisor sets 2048).
    let rssTimer: ReturnType<typeof setInterval> | null = null;
    if (this.opts.maxRssMb > 0) {
      rssTimer = setInterval(() => {
        this.checkMemoryLimit('periodic');
      }, this.opts.rssCheckInterval);
    }

    // Self-health-check — provides supervisor-grade monitoring for bare workers.
    // Disabled when running under a supervisor (GBRAIN_SUPERVISED=1) or when
    // healthCheckInterval is 0. Catches two failure modes that leave the process
    // alive but non-functional:
    //   1. DB connection death (Supabase/PgBouncer drops, network blip)
    //   2. Worker stall (event loop alive but not claiming/completing jobs)
    //
    // On failure, emits an `'unhealthy'` event with a structured reason. The
    // CLI layer (`src/commands/jobs.ts:work`) subscribes and decides whether to
    // call process.exit. Library code never calls process.exit directly so
    // MinionWorker stays embeddable in non-CLI contexts (tests, other hosts).
    //
    // Timer pattern: recursive setTimeout with a `running` flag, not setInterval.
    // setInterval queues callbacks even when the prior is still awaiting; on a
    // hung DB probe that piles up overlapping async checks racing on
    // `consecutiveDbFailures`. The recursive pattern guarantees one tick at a time.
    const isSupervisedChild = process.env.GBRAIN_SUPERVISED === '1';
    let healthTimer: ReturnType<typeof setTimeout> | null = null;
    if (!isSupervisedChild && this.opts.healthCheckInterval > 0) {
      let consecutiveDbFailures = 0;
      let lastKnownCompleted = this.jobsCompleted;
      let lastCompletionTime = Date.now();
      let stallWarningSince: number | null = null;
      let healthRunning = false;
      let healthExited = false;

      // Race executeRaw against a wall-clock deadline. A hung connection
      // (network-partitioned PgBouncer, deadlocked backend) would otherwise
      // hold the await forever — the recursive setTimeout's next tick is only
      // scheduled in `finally`, so a hung probe would silently disable the
      // entire health monitor. The timeout treats hangs as failures and feeds
      // them into `dbFailExitAfter`.
      const probeWithTimeout = async (): Promise<void> => {
        const ac = new AbortController();
        const timeoutMs = this.opts.dbProbeTimeoutMs;
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
          await Promise.race([
            this.engine.executeRaw('SELECT 1'),
            new Promise<never>((_, reject) => {
              ac.signal.addEventListener('abort', () => {
                reject(new Error(`probe timeout after ${timeoutMs}ms`));
              });
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };

      const runHealthCheck = async (): Promise<void> => {
        if (healthRunning || !this.running || healthExited) return;
        healthRunning = true;
        try {
          // --- 1. DB liveness probe ---
          try {
            await probeWithTimeout();
            consecutiveDbFailures = 0;
          } catch (e) {
            consecutiveDbFailures++;
            const msg = e instanceof Error ? e.message : String(e);
            console.error(
              `[health] DB probe failed (${consecutiveDbFailures}/${this.opts.dbFailExitAfter}): ${msg}`,
            );
            if (consecutiveDbFailures >= this.opts.dbFailExitAfter) {
              console.error(
                `[health] DB unreachable after ${this.opts.dbFailExitAfter} consecutive probes. ` +
                `Emitting 'unhealthy' for process-manager restart.`,
              );
              healthExited = true;
              this.emitUnhealthy({
                reason: 'db_dead',
                consecutiveFailures: consecutiveDbFailures,
                message: msg,
              });
            }
            return; // Skip stall check when DB is flaky
          }

          // --- 2. Stall detection ---
          if (this.jobsCompleted > lastKnownCompleted) {
            lastKnownCompleted = this.jobsCompleted;
            lastCompletionTime = Date.now();
            stallWarningSince = null;
          }

          const idleMs = Date.now() - lastCompletionTime;

          // Only check for stalls when no jobs are in-flight and it's been a while
          if (idleMs > this.opts.stallWarnAfterMs && this.inFlight.size === 0) {
            try {
              // Filter by registered handler names so a worker that doesn't
              // claim a particular job-name doesn't false-positive when those
              // jobs accumulate in `waiting`. Only counts work THIS worker would
              // actually have claimed.
              const handlerNames = this.registeredNames;
              const rows = handlerNames.length === 0
                ? [] as { cnt: string }[]
                : await this.engine.executeRaw<{ cnt: string }>(
                    `SELECT count(*)::text AS cnt FROM minion_jobs
                     WHERE status = 'waiting'
                       AND queue = $1
                       AND name = ANY($2::text[])`,
                    [this.opts.queue, handlerNames],
                  );
              const waiting = parseInt(rows[0]?.cnt ?? '0', 10);
              const idleMinutes = Math.round(idleMs / 60_000);
              if (waiting > 0) {
                // Two thresholds, both measured from `lastCompletionTime` (NOT
                // from when the warning fired). With defaults (warn=5min,
                // exit=10min), the first warning fires at idle=5min and the
                // unhealthy emit fires at idle=10min — matching the contract
                // documented in MinionWorkerOpts.
                if (!stallWarningSince) {
                  stallWarningSince = Date.now();
                  console.warn(
                    `[health] Possible stall: ${waiting} waiting job(s) for ` +
                    `registered handlers, 0 in-flight, ${idleMinutes}m since last completion`,
                  );
                } else if (idleMs > this.opts.stallExitAfterMs) {
                  console.error(
                    `[health] Worker stalled for ${Math.round(this.opts.stallExitAfterMs / 60_000)}+ ` +
                    `minutes with ${waiting} waiting job(s). Emitting 'unhealthy' for process-manager restart.`,
                  );
                  healthExited = true;
                  this.emitUnhealthy({
                    reason: 'stalled',
                    waitingCount: waiting,
                    idleMinutes,
                  });
                }
              } else {
                stallWarningSince = null; // Queue empty (for our handlers) — not stalled, just idle
              }
            } catch {
              // DB query failed — the liveness probe above will catch persistent failures
            }
          } else {
            stallWarningSince = null;
          }
        } finally {
          healthRunning = false;
          if (this.running && !healthExited) {
            healthTimer = setTimeout(runHealthCheck, this.opts.healthCheckInterval);
          }
        }
      };

      // First tick scheduled after one interval so newly-started workers have
      // a chance to do real work before the stall clock starts ticking.
      healthTimer = setTimeout(runHealthCheck, this.opts.healthCheckInterval);
    }

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
      if (rssTimer) clearInterval(rssTimer);
      if (healthTimer) clearTimeout(healthTimer); // recursive setTimeout pattern
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

  /** RSS watchdog. Called from the per-job finally and the periodic timer.
   *  Idempotent: returns early if already not running or already shut down.
   *  When threshold is exceeded, hands off to gracefulShutdown(). */
  private checkMemoryLimit(source: 'post-job' | 'periodic'): void {
    if (this.opts.maxRssMb <= 0) return;
    if (!this.running) return;
    if (this.gracefulShutdownFired) return;

    let rss = 0;
    try {
      rss = this.opts.getRss();
    } catch {
      // process.memoryUsage() effectively cannot throw, but be safe.
      return;
    }
    const rssMb = Math.round(rss / (1024 * 1024));
    if (rssMb < this.opts.maxRssMb) return;

    const ts = new Date().toISOString().slice(11, 19);
    console.warn(
      `[watchdog ${ts}] rss=${rssMb}MB threshold=${this.opts.maxRssMb}MB ` +
      `jobs_completed=${this.jobsCompleted} source=${source} — draining`,
    );
    this.gracefulShutdown('watchdog');
  }

  /** Trigger a unified-style graceful shutdown. Fires shutdownAbort + per-job
   *  aborts + running=false in that order so:
   *  1. Shell handlers (and anything subscribed to ctx.shutdownSignal) start
   *     their cleanup sequence (SIGTERM → 5s grace → SIGKILL on children).
   *  2. Cooperative handlers see ctx.signal.aborted and bail instead of
   *     waiting out the 30s drain.
   *  3. Main loop exits at the top of the next iteration.
   *  The existing 30s drain in start()'s finally then backstops genuinely
   *  uninterruptible work. */
  private gracefulShutdown(reason: string): void {
    if (this.gracefulShutdownFired) return;
    this.gracefulShutdownFired = true;
    if (!this.shutdownAbort.signal.aborted) {
      this.shutdownAbort.abort(new Error(reason));
    }
    for (const entry of this.inFlight.values()) {
      if (!entry.abort.signal.aborted) {
        entry.abort.abort(new Error(reason));
      }
    }
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
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    if (job.timeout_ms != null) {
      timeoutTimer = setTimeout(() => {
        if (!abort.signal.aborted) {
          console.warn(`Job ${job.id} (${job.name}) hit per-job timeout (${job.timeout_ms}ms), aborting`);
          abort.abort(new Error('timeout'));
        }
        // Safety net: if the handler doesn't resolve within 30s after abort,
        // force-evict from inFlight so the worker can pick up new jobs.
        // Without this, a handler that ignores AbortSignal wedges the worker
        // forever (the 98-waiting-0-active incident on 2026-04-24).
        graceTimer = setTimeout(() => {
          if (this.inFlight.has(job.id)) {
            console.warn(
              `Job ${job.id} (${job.name}) did not exit within 30s of abort. ` +
              `Force-evicting from inFlight to unblock worker. ` +
              `The handler is still running but the worker will claim new jobs.`
            );
            clearInterval(lockTimer);
            this.inFlight.delete(job.id);
            // Best-effort: mark as dead in DB so it doesn't get reclaimed
            this.queue.failJob(job.id, lockToken, 'handler ignored abort signal (force-evicted)', 'dead').catch(() => {});
          }
        }, 30_000);
      }, job.timeout_ms);
    }

    const promise = this.executeJob(job, lockToken, abort, lockTimer)
      .finally(() => {
        clearInterval(lockTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (graceTimer) clearTimeout(graceTimer);
        this.inFlight.delete(job.id);
        this.jobsCompleted += 1;
        this.checkMemoryLimit('post-job');
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
