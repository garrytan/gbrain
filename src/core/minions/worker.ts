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
import { RateLeaseUnavailableError } from './handlers/subagent.ts';
import { logLeasePressure } from './lease-pressure-audit.ts';
import {
  runLockRenewalTick,
  resolveLockRenewalKnobs,
  type LockRenewalDeps,
  type LockRenewalState,
} from './lock-renewal-tick.ts';
import { lockRenewalAudit } from '../audit/lock-renewal-audit.ts';
import { isRetryableConnError } from '../retry-matcher.ts';

/**
 * Abort reasons that signal infrastructure failure (PgBouncer outage,
 * connection drop, lock reclaimed by another worker) — NOT a job
 * defect. executeJob's catch block consults this set and SKIPS failJob
 * for these reasons, letting the stall detector requeue the row
 * cleanly without burning an attempt or dead-lettering the job.
 *
 * Codex C6 absorption (D8a): pre-v0.41.22.2, a PgBouncer blip during a
 * long-running job would lock-renewal-abort → handler throws → failJob
 * burns an attempt. That's wrong direction: the job's fine; the
 * infrastructure stumbled. Stall-detector reclaim is the correct path.
 *
 * Exported so tests can pin the named-constant contract (a future edit
 * to this set is a deliberate two-line change, not a silent regression).
 */
export const INFRASTRUCTURE_ABORT_REASONS = new Set<string>([
  'lock-renewal-failed',
  'lock-lost',
]);
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { evaluateQuietHours, type QuietHoursConfig } from './quiet-hours.ts';
import { readFileSync } from 'fs';

/**
 * Pure parser for /proc/self/status RSS fields. Returns bytes of
 * RssAnon + RssShmem when either field is present, or null when the
 * status text is from a kernel that doesn't expose those fields
 * (kernels older than 4.5) or the values are malformed. Exported so
 * the test suite can unit-test the field-presence + malformed-value
 * edge cases without mocking the filesystem.
 *
 * M1 fix: field-presence check, not value-presence check. The earlier
 * `if (anonKb > 0)` form conflated "field exists with value 0" with
 * "field missing", which mis-routed to VmRSS fallback in the legitimate
 * shmem-only worker case (RssAnon: 0 + RssShmem: 512).
 */
export function parseRssFromProcStatus(status: string): number | null {
  const anonMatch = status.match(/^RssAnon:\s+(\d+)/m);
  const shmemMatch = status.match(/^RssShmem:\s+(\d+)/m);
  if (anonMatch === null && shmemMatch === null) {
    return null;
  }
  const anonKb = parseInt(anonMatch?.[1] ?? '0', 10);
  const shmemKb = parseInt(shmemMatch?.[1] ?? '0', 10);
  if (isNaN(anonKb) || isNaN(shmemKb)) {
    return null;
  }
  return (anonKb + shmemKb) * 1024; // bytes
}

/**
 * Read accurate RSS from /proc/self/status (RssAnon + RssShmem).
 *
 * `process.memoryUsage().rss` returns VmRSS which includes file-backed mmap'd
 * pages (e.g. git packfiles). On a 96K-page brain repo, git operations can
 * inflate VmRSS to 7GB+ while actual heap usage is ~100MB. The kernel reclaims
 * file-backed pages under memory pressure — they're cache, not real usage.
 *
 * RssAnon = anonymous pages (heap, stack, anonymous mmap). RssShmem = shared
 * anonymous pages (IPC, tmpfs). Their sum is the non-file-backed resident
 * memory used for **per-process leak detection** — exactly the metric a leak
 * watchdog wants. It is NOT a full container-OOM metric: cgroup memory
 * pressure includes page cache, so a sibling container holding the page
 * cache hot can OOM us even at low anon+shmem. Use cgroup-aware monitoring
 * for that scenario; this helper is for the worker's own leak guard.
 *
 * Falls back to process.memoryUsage().rss on non-Linux, missing /proc, or
 * kernels older than 4.5 that don't expose RssAnon/RssShmem.
 *
 * `readStatus` is injectable for tests — production callers use the default,
 * which reads `/proc/self/status`.
 */
export function getAccurateRss(
  readStatus: () => string = () => readFileSync('/proc/self/status', 'utf8'),
): number {
  try {
    const status = readStatus();
    const parsed = parseRssFromProcStatus(status);
    if (parsed !== null) return parsed;
  } catch {
    // Non-Linux or /proc unavailable
  }
  return process.memoryUsage().rss;
}

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
  /**
   * Set true when the RSS watchdog (not a normal SIGTERM) initiated the
   * drain. The CLI handler (src/commands/jobs.ts case 'work') reads this
   * AFTER start() resolves and exits the process with
   * WORKER_EXIT_RSS_WATCHDOG so the supervisor can classify the drain as
   * `rss_watchdog` instead of a clean exit. The worker deliberately does
   * NOT set process.exitCode itself — that would leak a non-zero code into
   * embedding hosts (tests, other process owners) that call start()/stop()
   * in-process. Ownership of process exit stays with the CLI, same as the
   * engine-disconnect boundary.
   */
  private _rssWatchdogTriggered = false;
  /** Peak observed RSS (MB) this process lifetime — surfaced in the watchdog
   *  drain line and the 80% soft-warn so operators can size --max-rss. */
  private _peakRssMb = 0;
  /** Latch so the 80%-of-cap soft-warn fires once per crossing, not every check. */
  private _softWarnFired = false;

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
      getRss: opts?.getRss ?? getAccurateRss,
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

  /**
   * True when the RSS watchdog drained this worker (vs a normal SIGTERM
   * shutdown). The CLI handler reads this after `start()` resolves to set
   * the distinct WORKER_EXIT_RSS_WATCHDOG process exit code. See the field
   * comment on `_rssWatchdogTriggered` for the ownership rationale.
   */
  get rssWatchdogTriggered(): boolean {
    return this._rssWatchdogTriggered;
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
          let job: MinionJob | null;
          try {
            job = await this.queue.claim(
              lockToken,
              this.opts.lockDuration,
              this.opts.queue,
              this.registeredNames,
            );
          } catch (e) {
            // issue #1678 (Codex #1): a reaped pooler socket / nulled instance
            // pool throws a retryable conn error here. Blind-retrying claim is
            // UNSAFE — if the UPDATE...RETURNING committed but the connection
            // died before the row reached us, a retry would claim a SECOND
            // job (invisible active job, no renewal, later stall). So instead:
            // reconnect once and let the NEXT poll tick re-claim against a live
            // pool. Non-retryable errors propagate (real bug → PM restart).
            if (!isRetryableConnError(e)) throw e;
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[worker] claim hit a connection error; reconnecting, retry on next tick: ${msg}`);
            const reconnect = (this.engine as { reconnect?: () => Promise<void> }).reconnect;
            if (reconnect) {
              try { await reconnect.call(this.engine); }
              catch (re) {
                console.error(`[worker] reconnect after claim error failed: ${re instanceof Error ? re.message : String(re)}`);
              }
            }
            await new Promise(resolve => setTimeout(resolve, this.opts.pollInterval));
            continue;
          }

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

      // The worker does NOT disconnect the engine: it doesn't own the
      // engine's lifecycle. The caller (CLI handler at src/commands/jobs.ts
      // case 'work', or a test fixture) is responsible for disconnect when
      // it has finished using the engine. Earlier wave's experiment of
      // calling engine.disconnect() here violated ownership and broke
      // every test that shared a single engine across multiple
      // worker.start() / worker.stop() cycles (PGLiteEngine kills its
      // single _db connection; PostgresEngine.disconnect was non-idempotent
      // and clobbered the global db singleton on the second call). The
      // pool-slot-release intent is now handled in the CLI handler which
      // does own the engine.
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
    if (rssMb > this._peakRssMb) this._peakRssMb = rssMb;

    // Names of the jobs in flight when memory crested — the diagnostic an
    // operator needs to know WHICH job kind is the memory hog.
    const inFlightKinds = Array.from(this.inFlight.values()).map(f => f.job.name);

    // 80%-of-cap soft warn: fires once per crossing (re-arms once RSS drops
    // back under the line) so operators get a heads-up BEFORE the kill rather
    // than a silent death. Cheap: one extra comparison per check.
    const softLine = Math.floor(this.opts.maxRssMb * 0.8);
    if (rssMb < this.opts.maxRssMb) {
      if (rssMb >= softLine && !this._softWarnFired) {
        this._softWarnFired = true;
        const ts = new Date().toISOString().slice(11, 19);
        console.warn(
          `[watchdog ${ts}] approaching cap: rss=${rssMb}MB (${Math.round((rssMb / this.opts.maxRssMb) * 100)}% of ${this.opts.maxRssMb}MB) ` +
          `peak=${this._peakRssMb}MB in_flight=${inFlightKinds.join(',') || 'none'} — next overshoot will drain. ` +
          `Raise --max-rss if this job kind legitimately needs more.`,
        );
      } else if (rssMb < softLine) {
        this._softWarnFired = false;
      }
      return;
    }

    this._rssWatchdogTriggered = true;
    const ts = new Date().toISOString().slice(11, 19);
    console.warn(
      `[watchdog ${ts}] rss=${rssMb}MB threshold=${this.opts.maxRssMb}MB peak=${this._peakRssMb}MB ` +
      `jobs_completed=${this.jobsCompleted} in_flight=${inFlightKinds.join(',') || 'none'} source=${source} — draining ` +
      `(raise --max-rss if this is legitimate working set, not a leak)`,
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

  /**
   * Launch a job as an independent in-flight promise.
   *
   * v0.41.22.2 hardening — the lock-renewal cathedral wave (closes the
   * production unhandledRejection crash class + 4 codex outside-voice
   * gaps). The renewal timer now wraps a pure `runLockRenewalTick`
   * call from `src/core/minions/lock-renewal-tick.ts` rather than
   * inlining `setInterval(async () => { await renewLock(...) })` —
   * which would let any throw escape to `process.on('unhandledRejection')`
   * and crash the worker (the v0.41.22.1 bug).
   *
   * State machine guarded by:
   *   - `cancelled` flag set in the finally block so an in-flight
   *     renewLock that resolves after the job ended bails cleanly (D1)
   *   - `tickInFlight` re-entrancy guard so overlapping ticks during a
   *     PgBouncer stall don't pile concurrent connection acquisitions
   *     on an already-saturated pool
   *   - `Promise.race(renewLock, timeoutPromise)` inside the tick so a
   *     hung connection can't wedge the re-entrancy guard forever (D6 / codex C3)
   *   - time-based abort (`Date.now() - lastSuccessfulRenewalAt >=
   *     lockDuration - safetyMargin`) so we voluntarily release BEFORE
   *     the stall detector can reclaim the row (D6 / codex C2)
   *
   * Universal grace-eviction (D8b / codex C7): the 30s force-evict
   * safety net fires for ANY abort reason, not just `job.timeout_ms`.
   * Handlers that ignore AbortSignal won't wedge the inFlight slot
   * forever on lock-renewal aborts.
   *
   * Second unhandledRejection vector (D7 / codex C5): the stored
   * `executeJob(...).finally(...)` promise gets an explicit `.catch()`
   * so an unhandled rejection inside the finally/catch chain (e.g.,
   * `failJob` throwing during the same DB outage) can't propagate to
   * the process-level handler and crash the daemon.
   */
  private launchJob(job: MinionJob, lockToken: string): void {
    const abort = new AbortController();

    // --- D1: cancellation flag for the in-flight renewal IIFE ---
    let cancelled = false;
    // --- re-entrancy guard for overlapping ticks during PgBouncer stalls ---
    let tickInFlight = false;

    // --- D3: pure-function lock renewal ---
    const knobs = resolveLockRenewalKnobs(process.env, this.opts.lockDuration);
    const renewalState: LockRenewalState = {
      jobId: job.id,
      jobName: job.name,
      lockToken,
      lockDurationMs: this.opts.lockDuration,
      knobs,
      lastSuccessfulRenewalAt: Date.now(),
      consecutiveFailures: 0,
      cancelled: () => cancelled,
    };
    // issue #1678 (Codex #2): hand the tick a bounded reconnect-once hook when
    // the engine owns a pool that a transaction-mode pooler can reap. Postgres
    // exposes reconnect(); PGLite (no pooler) doesn't, so the hook is absent
    // and the tick keeps its legacy no-reconnect behavior.
    const engineReconnect = (this.engine as { reconnect?: () => Promise<void> }).reconnect;
    const renewalDeps: LockRenewalDeps = {
      renewLock: (id, tok, dur) => this.queue.renewLock(id, tok, dur),
      audit: lockRenewalAudit,
      now: Date.now,
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      ...(engineReconnect ? { reconnect: () => engineReconnect.call(this.engine) } : {}),
    };

    const lockTimer = setInterval(() => {
      if (tickInFlight) return;
      tickInFlight = true;
      void runLockRenewalTick(renewalDeps, renewalState)
        .then((result) => {
          if (cancelled) return;
          switch (result.kind) {
            case 'ok':
            case 'cancelled':
              return;
            case 'lock_lost':
              if (!abort.signal.aborted) {
                console.warn(`Lock lost for job ${job.id}, aborting execution`);
                clearInterval(lockTimer);
                abort.abort(new Error('lock-lost'));
              }
              return;
            case 'should_abort':
              if (!abort.signal.aborted) {
                clearInterval(lockTimer);
                abort.abort(new Error(result.reason));
              }
              return;
          }
        })
        .catch((err) => {
          // Belt-and-suspenders. runLockRenewalTick's own try/catch
          // should make this unreachable, but a stray throw from the
          // .then handler itself (console.warn EPIPE on a piped worker
          // for instance) would otherwise propagate to
          // unhandledRejection and crash the daemon — the exact bug
          // class this whole wave exists to close.
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[worker] runLockRenewalTick post-handler error: ${msg}`);
        })
        .finally(() => {
          tickInFlight = false;
        });
    }, this.opts.lockDuration / 2);

    // --- D8b: universal grace-eviction timer ---
    // Fires for ANY abort reason (not just job.timeout_ms). Without
    // this generalization, lock-renewal aborts could leave the inFlight
    // slot wedged forever if the handler ignores AbortSignal.
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    abort.signal.addEventListener('abort', () => {
      // Avoid scheduling a second grace timer if abort fires again
      // (e.g., timeout + lock-renewal-failed close to each other).
      if (graceTimer != null) return;
      graceTimer = setTimeout(() => {
        if (this.inFlight.has(job.id)) {
          const reason = abort.signal.reason instanceof Error
            ? abort.signal.reason.message
            : String(abort.signal.reason);
          console.warn(
            `Job ${job.id} (${job.name}) did not exit within 30s of abort (reason: ${reason}). ` +
            `Force-evicting from inFlight to unblock worker. ` +
            `The handler is still running but the worker will claim new jobs.`
          );
          clearInterval(lockTimer);
          this.inFlight.delete(job.id);
          // D8a: don't failJob if the abort was infrastructure. The
          // stall detector will reclaim the row cleanly because the
          // lock has expired (lock-renewal aborts only fire after
          // lockDuration - safetyMargin elapsed without renewal).
          if (!INFRASTRUCTURE_ABORT_REASONS.has(reason)) {
            this.queue.failJob(
              job.id,
              lockToken,
              'handler ignored abort signal (force-evicted)',
              'dead',
            ).catch(() => {});
          }
        }
      }, 30_000);
    });

    // Per-job wall-clock timeout (timer-armed only if `timeout_ms` was
    // set on the job; the grace-evict pattern above now lives outside
    // this branch).
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
        // D1: signal in-flight IIFE to bail at its next checkpoint so
        // a renewLock resolution that lands after the job ended
        // doesn't write a misleading audit event or abort an
        // already-dead controller.
        cancelled = true;
        clearInterval(lockTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (graceTimer) clearTimeout(graceTimer);
        this.inFlight.delete(job.id);
        this.jobsCompleted += 1;
        this.checkMemoryLimit('post-job');
      })
      // D7 / codex C5: close the SECOND unhandledRejection vector. If
      // executeJob's catch path throws (e.g., failJob's executeRaw
      // throws during the same DB outage that caused lock renewal to
      // fail), the rejection would otherwise escape to
      // process.on('unhandledRejection') and crash the daemon.
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[worker] executeJob unhandled error for job ${job.id} (${job.name}): ${msg}`);
        try {
          lockRenewalAudit.logExecuteJobRejected(job.id, job.name, err);
        } catch { /* audit best-effort */ }
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
      let abortReason: string | null = null;
      if (abort.signal.aborted) {
        abortReason = abort.signal.reason instanceof Error
          ? abort.signal.reason.message
          : String(abort.signal.reason || 'aborted');
        errorText = `aborted: ${abortReason}`;
      } else {
        errorText = err instanceof Error ? err.message : String(err);
      }

      // v0.41.22.2 (D8a / codex C6): infrastructure aborts (lock-renewal-failed,
      // lock-lost) are NOT job defects — they're connection / coordination
      // failures the stall detector will reclaim cleanly. Calling failJob here
      // would burn an attempt or dead-letter the job for what's really a
      // PgBouncer blip; that's a worse outcome than the v0.41.22.1 crash it
      // replaces. The lock has already expired (lock-renewal-failed only fires
      // after lockDuration - safetyMargin elapsed without renewal), so the
      // stall detector will pick the row up on its next poll and another
      // worker will claim it cleanly.
      if (abortReason !== null && INFRASTRUCTURE_ABORT_REASONS.has(abortReason)) {
        console.log(
          `Job ${job.id} (${job.name}) released after infrastructure abort (${abortReason}); ` +
          `stall detector will requeue (no attempt burned)`,
        );
        return;
      }

      // v0.41 Bug 2: lease-full bounces don't burn attempts.
      //
      // Pre-v0.41 every non-`UnrecoverableError` routed to `delayed` with
      // exponential backoff BUT still incremented `attempts_made`. After 3
      // lease-full bounces the job hit `max_attempts` and dead-lettered
      // with message `rate lease "..." full (N/M)` — operators saw a
      // "dead" job and assumed real failure. The field-report dead-letter
      // loop is exactly this path.
      //
      // Detect `RateLeaseUnavailableError` BEFORE the attempts-exhaustion
      // gate and route through `queue.releaseLeaseFullJob` which mirrors
      // `failJob` minus the `attempts_made` increment. Audit row to
      // `minion_lease_pressure_log` so operators see pressure live in
      // `gbrain doctor` + `gbrain jobs stats lease_pressure`.
      const isLeaseFull = err instanceof RateLeaseUnavailableError;
      if (isLeaseFull) {
        const leaseErr = err as RateLeaseUnavailableError;
        // 1-3s jittered backoff. Not the exponential curve — this is "yield
        // the slot, try again soon", not "give up after a few tries."
        const leaseBackoffMs = 1000 + Math.floor(Math.random() * 2000);
        const released = await this.queue.releaseLeaseFullJob(
          job.id, lockToken, errorText, leaseBackoffMs,
        );
        if (!released) {
          console.warn(`Job ${job.id} lease-full release dropped (lock token mismatch)`);
          return;
        }
        // Audit row write is best-effort — never blocks the bypass path.
        // Denormalized columns persist past `gbrain jobs prune` so post-NULL
        // forensic queries still see context (Eng D8 / codex pass-3 #7).
        await logLeasePressure(this.engine, {
          job_id: job.id,
          lease_key: leaseErr.key,
          active_at_bounce: leaseErr.active,
          max_concurrent: Number.isFinite(leaseErr.max) ? leaseErr.max : -1,
          queue_name: job.queue,
          job_name: job.name,
          // Best-effort context — populated when we can. The worker doesn't
          // always know the model at catch time (model is resolved inside
          // the handler), so leave NULL when unavailable. The doctor check's
          // aggregate queries handle NULL gracefully.
          model: null,
          provider: null,
          root_owner_id: job.parent_job_id ?? null,
        });
        console.log(
          `Job ${job.id} (${job.name}) lease-full, re-queuing in ${Math.round(leaseBackoffMs)}ms (no attempt burned)`,
        );
        return;
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
