/**
 * MinionSupervisor — Process manager for the Minion worker.
 *
 * Spawns `gbrain jobs work` as a child process and restarts it on crash
 * with exponential backoff. Provides health monitoring, PID file locking
 * (atomic via O_CREAT|O_EXCL), and graceful shutdown.
 *
 * ENGINE: Postgres only. PGLite uses an exclusive file lock that blocks
 * any separate worker process, so `gbrain jobs supervisor` cannot work
 * against a PGLite brain — `src/commands/jobs.ts` rejects that combination
 * at the CLI layer. The health-check SQL below assumes Postgres schema.
 *
 * Usage:
 *   gbrain jobs supervisor [--concurrency N] [--queue Q] [--pid-file PATH]
 *                          [--max-crashes N] [--health-interval N]
 *                          [--allow-shell-jobs] [--json]
 *
 * Design: the supervisor does NOT run the worker in-process. It spawns a
 * separate child so a misbehaving handler can't take down the supervisor.
 * Same isolation pattern as autopilot.ts but standalone and reusable.
 *
 * Exit codes (documented in CLI --help):
 *   0 clean shutdown (SIGTERM/SIGINT received, worker drained)
 *   1 max crashes exceeded (worker kept dying)
 *   2 another supervisor holds the PID lock
 *   3 PID file unwritable (permission / path error)
 */

import { detectTini } from './spawn-helpers.ts';
import {
  ChildWorkerSupervisor,
  type ChildSupervisorEvent,
} from './child-worker-supervisor.ts';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { dirname } from 'path';
import type { BrainEngine } from '../engine.ts';

export type SupervisorEvent =
  | 'started'
  | 'worker_spawned'
  | 'worker_exited'
  | 'worker_spawn_failed'
  | 'backoff'
  | 'health_warn'
  | 'health_error'
  | 'max_crashes_exceeded'
  | 'shutting_down'
  | 'stopped';

export interface SupervisorEmission {
  event: SupervisorEvent;
  ts: string;
  [key: string]: unknown;
}

export interface SupervisorOpts {
  /** Worker concurrency (passed to child). Default: 2. */
  concurrency: number;
  /** Queue name (passed to child). Default: 'default'. */
  queue: string;
  /** PID file path. Default: `${HOME}/.gbrain/supervisor.pid` (parent dir auto-created). */
  pidFile: string;
  /** Max consecutive crashes before giving up. Default: 10. */
  maxCrashes: number;
  /** Health check interval in ms. Default: 60000. */
  healthInterval: number;
  /** Path to the gbrain CLI executable (MUST be a compiled binary; .ts sources cannot be spawned). */
  cliPath: string;
  /** Allow shell jobs on child worker. Default: false. When true, sets GBRAIN_ALLOW_SHELL_JOBS=1 on child env. */
  allowShellJobs: boolean;
  /** JSON mode: emit JSONL events on stderr, reserve stdout for data payloads. Default: false. */
  json: boolean;
  /** RSS threshold (MB) passed to the spawned worker as `--max-rss N`.
   *  Default: 2048. Set to 0 to spawn the worker without a watchdog. */
  maxRssMb: number;
  /** Optional event sink (Lane C audit writer). Called for every lifecycle event. */
  onEvent?: (event: SupervisorEmission) => void;
  /**
   * Test-only override: minimum backoff in ms between child respawns. Default: undefined
   * (uses full `calculateBackoffMs()` curve). Tests pass `1` to make crash-loops finish
   * in < 1s. Not exposed via CLI.
   * @internal
   */
  _backoffFloorMs?: number;
}

export const DEFAULT_PID_FILE: string = (() => {
  const envOverride = process.env.GBRAIN_SUPERVISOR_PID_FILE;
  if (envOverride && envOverride.length > 0) return envOverride;
  const home = process.env.HOME ?? '/tmp';
  return `${home}/.gbrain/supervisor.pid`;
})();

const DEFAULTS: Omit<SupervisorOpts, 'cliPath'> = {
  concurrency: 2,
  queue: 'default',
  pidFile: DEFAULT_PID_FILE,
  maxCrashes: 10,
  healthInterval: 60_000,
  allowShellJobs: false,
  json: false,
  maxRssMb: 2048,
};

/** Calculate backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s cap. */
export function calculateBackoffMs(crashCount: number): number {
  const base = Math.min(1000 * Math.pow(2, Math.max(crashCount, 0)), 60_000);
  // Add 10% jitter
  return base + Math.random() * base * 0.1;
}

/** Check if a PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Exit codes for documented agent branching. */
export const ExitCodes = {
  CLEAN: 0,
  MAX_CRASHES: 1,
  LOCK_HELD: 2,
  PID_UNWRITABLE: 3,
} as const;

export class MinionSupervisor {
  private opts: SupervisorOpts;
  private engine: BrainEngine;
  /**
   * Inner spawn-and-respawn core. Created lazily in `start()` so options
   * passed via DEFAULTS merge are visible. Stays null when `stopping` is
   * tripped before `start()` runs (test edge case).
   */
  private childSupervisor: ChildWorkerSupervisor | null = null;
  /** Path to tini binary for zombie reaping, or empty string when absent. */
  private readonly tiniPath: string;
  private stopping = false;
  private healthInFlight = false;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private exitListener: (() => void) | null = null;
  private sigtermListener: (() => void) | null = null;
  private sigintListener: (() => void) | null = null;
  private lockAcquired = false;
  private consecutiveHealthFailures = 0;

  constructor(engine: BrainEngine, opts: Partial<SupervisorOpts> & { cliPath: string }) {
    this.engine = engine;
    this.opts = { ...DEFAULTS, ...opts };

    // Detect tini for zombie reaping. Resolved once at construction so we
    // don't shell out on every respawn. Belt-and-suspenders with the
    // SIGCHLD handler in cli.ts — tini catches children spawned by native
    // addons that bypass the JS event loop. ChildWorkerSupervisor detects
    // independently; both calls hit the same `which tini` lookup.
    this.tiniPath = detectTini();
  }

  /**
   * Read-only accessor for whether tini was detected at construction.
   * Used by `test/supervisor-tini.test.ts` to verify the wiring without
   * exposing the resolved path. Returns true when `worker_spawned` events
   * will include `tini: true` in their payload.
   */
  get isTiniDetected(): boolean {
    return this.tiniPath !== '';
  }

  /**
   * Emit a lifecycle event. In JSON mode, writes a JSONL record to stderr.
   * In human mode, writes a human-readable log line to stdout (info) or
   * stderr (warn/error). Also calls `opts.onEvent` if set (Lane C audit
   * writer hooks here).
   */
  private emit(event: SupervisorEvent, fields: Record<string, unknown> = {}): void {
    const emission: SupervisorEmission = {
      event,
      ts: new Date().toISOString(),
      ...fields,
    };

    if (this.opts.json) {
      // stderr is the event channel; stdout stays clean for data (e.g., --detach payload).
      try {
        process.stderr.write(JSON.stringify(emission) + '\n');
      } catch { /* best effort */ }
    } else {
      const ts = emission.ts.slice(11, 19);
      const detail = Object.entries(fields)
        .filter(([k]) => k !== 'event' && k !== 'ts')
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      const isWarn = event === 'health_warn' || event === 'health_error' ||
                     event === 'worker_spawn_failed' || event === 'max_crashes_exceeded';
      const line = `[supervisor ${ts}] ${event}${detail ? ' ' + detail : ''}`;
      if (isWarn) {
        console.warn(line);
      } else {
        console.log(line);
      }
    }

    // Audit sink (Lane C plumbs this).
    if (this.opts.onEvent) {
      try { this.opts.onEvent(emission); } catch { /* best effort */ }
    }
  }

  /** Start the supervisor. Blocks until stopped or max crashes exceeded. */
  async start(): Promise<void> {
    // 1. PID file lock (atomic via O_CREAT|O_EXCL).
    const lockResult = this.acquirePidLock();
    if (lockResult === 'held') {
      // Another supervisor owns the lock — exit code 2.
      process.exit(ExitCodes.LOCK_HELD);
    }
    if (lockResult === 'unwritable') {
      // PID path isn't writable — exit code 3 with helpful hint.
      process.exit(ExitCodes.PID_UNWRITABLE);
    }

    // 2. Cleanup on process exit (covers any exit path including process.exit).
    this.exitListener = () => {
      try {
        if (existsSync(this.opts.pidFile)) {
          const contents = readFileSync(this.opts.pidFile, 'utf8').trim().split('\n')[0];
          if (contents === String(process.pid)) {
            unlinkSync(this.opts.pidFile);
          }
        }
      } catch { /* best effort */ }
    };
    process.on('exit', this.exitListener);

    // 3. Signal handlers (tracked refs; removed on shutdown for test lifecycle hygiene).
    this.sigtermListener = () => { void this.shutdown('SIGTERM', ExitCodes.CLEAN); };
    this.sigintListener = () => { void this.shutdown('SIGINT', ExitCodes.CLEAN); };
    process.on('SIGTERM', this.sigtermListener);
    process.on('SIGINT', this.sigintListener);

    // 4. Health monitoring. Skip when healthInterval=0 — that's the explicit
     // "disable" contract documented on `--health-interval 0`. setInterval(0)
     // would be a tight DB-hammering loop, not the no-op users expect.
    if (this.opts.healthInterval > 0) {
      this.healthTimer = setInterval(() => { void this.healthCheck(); }, this.opts.healthInterval);
    }

    // 5. Announce start.
    this.emit('started', {
      supervisor_pid: process.pid,
      pid_file: this.opts.pidFile,
      concurrency: this.opts.concurrency,
      queue: this.opts.queue,
      max_crashes: this.opts.maxCrashes,
    });

    // 6. Run the supervise loop (respawn on crash, bounded by maxCrashes).
    await this.runSuperviseLoop();
  }

  /** Unified shutdown path. Reason becomes the audit event name; exitCode is process exit. */
  private async shutdown(reason: string, exitCode: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    this.emit('shutting_down', { reason, exit_code: exitCode });

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    if (this.childSupervisor) {
      this.childSupervisor.killChild('SIGTERM');
      await this.childSupervisor.awaitChildExit(35_000);
      // If the child is still up after the 35s drain window, escalate.
      if (this.childSupervisor.childAlive) {
        this.childSupervisor.killChild('SIGKILL');
      }
    }

    // Remove signal handlers so tests that spin up multiple supervisors on
    // the same process don't accumulate listeners. `process.on('exit', ...)`
    // is kept registered — it needs to fire synchronously on the final exit.
    if (this.sigtermListener) {
      process.removeListener('SIGTERM', this.sigtermListener);
      this.sigtermListener = null;
    }
    if (this.sigintListener) {
      process.removeListener('SIGINT', this.sigintListener);
      this.sigintListener = null;
    }

    this.emit('stopped', { reason, exit_code: exitCode });
    process.exit(exitCode);
  }

  /**
   * Acquire PID file lock atomically via O_CREAT|O_EXCL.
   *
   * Returns:
   *   'acquired'   — lock is ours, safe to proceed.
   *   'held'       — another live supervisor owns the lock (exit code 2).
   *   'unwritable' — can't write to the PID path (permission / missing parent, exit code 3).
   */
  private acquirePidLock(): 'acquired' | 'held' | 'unwritable' {
    // Ensure parent directory exists. Idempotent; creates ~/.gbrain on fresh installs.
    try {
      mkdirSync(dirname(this.opts.pidFile), { recursive: true });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        console.error(
          `Cannot create PID file directory ${dirname(this.opts.pidFile)}: ${
            err instanceof Error ? err.message : String(err)
          }. Set GBRAIN_SUPERVISOR_PID_FILE or pass --pid-file to a writable location.`
        );
        return 'unwritable';
      }
    }

    return this.tryAtomicCreate();
  }

  private tryAtomicCreate(): 'acquired' | 'held' | 'unwritable' {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — fails with EEXIST if the file exists.
      const fd = openSync(this.opts.pidFile, 'wx');
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      this.lockAcquired = true;
      return 'acquired';
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') {
        // File exists — check if the owner is alive.
        let existingPid = -1;
        try {
          const contents = readFileSync(this.opts.pidFile, 'utf8').trim().split('\n')[0];
          existingPid = parseInt(contents, 10);
        } catch { /* corrupt file */ }

        if (!isNaN(existingPid) && existingPid > 0 && isProcessAlive(existingPid)) {
          console.error(`Supervisor already running (PID: ${existingPid}). Exiting.`);
          return 'held';
        }

        // Stale PID file — unlink and retry atomic create once.
        try { unlinkSync(this.opts.pidFile); } catch { /* race with another stale-cleaner; retry will EEXIST again */ }
        try {
          const fd = openSync(this.opts.pidFile, 'wx');
          try {
            writeSync(fd, String(process.pid));
          } finally {
            closeSync(fd);
          }
          this.lockAcquired = true;
          return 'acquired';
        } catch (retryErr) {
          const retryCode = (retryErr as NodeJS.ErrnoException)?.code;
          if (retryCode === 'EEXIST') {
            // Someone else won the race. Treat as held.
            console.error(`Another supervisor took the PID lock during stale cleanup. Exiting.`);
            return 'held';
          }
          console.error(
            `Cannot write PID file ${this.opts.pidFile}: ${
              retryErr instanceof Error ? retryErr.message : String(retryErr)
            }`
          );
          return 'unwritable';
        }
      }

      console.error(
        `Cannot write PID file ${this.opts.pidFile}: ${
          err instanceof Error ? err.message : String(err)
        }. Set GBRAIN_SUPERVISOR_PID_FILE or pass --pid-file to a writable location.`
      );
      return 'unwritable';
    }
  }

  /**
   * Run the supervise loop. Constructs a ChildWorkerSupervisor with the
   * D1 lastExitCode classifier + D2 clean-restart budget baked in, then
   * defers spawn/respawn/backoff to it. Maps the inner ChildSupervisorEvent
   * stream to MinionSupervisor's existing SupervisorEvent emit() channel
   * so JSONL audit consumers see byte-compatible output.
   */
  private async runSuperviseLoop(): Promise<void> {
    const workerArgs = [
      'jobs', 'work',
      '--concurrency', String(this.opts.concurrency),
      '--queue', this.opts.queue,
    ];
    if (this.opts.maxRssMb > 0) {
      workerArgs.push('--max-rss', String(this.opts.maxRssMb));
    }

    // Build child env. Explicit handling for GBRAIN_ALLOW_SHELL_JOBS:
    // inherit only when caller opts in, otherwise strip from the clone.
    const env: Record<string, string | undefined> = { ...process.env };
    if (this.opts.allowShellJobs) {
      env.GBRAIN_ALLOW_SHELL_JOBS = '1';
    } else {
      delete env.GBRAIN_ALLOW_SHELL_JOBS;
    }
    // Signal to the child worker that it's running under a supervisor.
    // The worker's self-health-check (DB probes, stall detection) is
    // redundant when the supervisor already provides these — setting
    // this env var causes the worker to skip its own health timer.
    env.GBRAIN_SUPERVISED = '1';

    this.childSupervisor = new ChildWorkerSupervisor({
      cliPath: this.opts.cliPath,
      args: workerArgs,
      env,
      maxCrashes: this.opts.maxCrashes,
      _backoffFloorMs: this.opts._backoffFloorMs,
      isStopping: () => this.stopping,
      onMaxCrashesExceeded: (count, max) => {
        this.emit('max_crashes_exceeded', {
          crash_count: count,
          max_crashes: max,
        });
        void this.shutdown('max_crashes', ExitCodes.MAX_CRASHES);
      },
      onEvent: (event) => this.relayChildEvent(event),
    });

    await this.childSupervisor.run();
  }

  /**
   * Map ChildSupervisorEvent (the inner core's emission shape) to the
   * existing SupervisorEvent emit channel. The wire shape of audit JSONL
   * is unchanged — same event names, same field names, same payload
   * coverage. The `reason='budget_exceeded'` backoff variant is a new
   * additive field; pre-existing consumers ignore unknown fields.
   */
  private relayChildEvent(event: ChildSupervisorEvent): void {
    switch (event.kind) {
      case 'worker_spawned':
        this.emit('worker_spawned', {
          pid: event.pid >= 0 ? event.pid : undefined,
          cli_path: this.opts.cliPath,
          ...(event.tini ? { tini: true } : {}),
        });
        return;

      case 'worker_spawn_failed':
        this.emit('worker_spawn_failed', {
          cli_path: this.opts.cliPath,
          error: event.error,
          phase: event.phase,
          ...(event.errnoCode ? { code: event.errnoCode } : {}),
        });
        return;

      case 'worker_exited': {
        const exitReason = event.signal
          ? `signal ${event.signal}`
          : `code ${event.code ?? 'null'}`;
        this.emit('worker_exited', {
          code: event.code,
          signal: event.signal,
          reason: exitReason,
          likely_cause: event.likelyCause,
          crash_count: event.crashCount,
          max_crashes: this.opts.maxCrashes,
          run_duration_ms: event.runDurationMs,
        });
        return;
      }

      case 'backoff':
        this.emit('backoff', {
          ms: event.ms,
          crash_count: event.crashCount,
          reason: event.reason,
        });
        return;

      case 'health_warn':
        this.emit('health_warn', {
          reason: event.reason,
          count: event.count,
          window_ms: event.windowMs,
          queue: this.opts.queue,
        });
        return;
    }
  }

  /**
   * Periodic health check — queries DB for queue health indicators.
   *
   * POSTGRES-ONLY. The supervisor cannot run against PGLite (exclusive
   * file lock blocks the separate worker process). The CLI layer rejects
   * that combination; we assume Postgres here.
   *
   * F9 guard: skip if a previous check is still in flight (hung DB
   * connection shouldn't stack duplicate checks).
   */
  private async healthCheck(): Promise<void> {
    if (this.healthInFlight) return;
    this.healthInFlight = true;

    try {
      // Blocker 2+3+6: single FILTER query scoped to this.opts.queue.
      // 'stalled' = active jobs whose lock_until has passed (matches
      // queue.ts:848 handleStalled() definition — same set that the queue
      // itself will requeue/dead-letter on next tick).
      const rows = await this.engine.executeRaw<{
        stalled: string;
        waiting: string;
        last_completed: string | null;
      }>(
        `SELECT
           count(*) FILTER (WHERE status = 'active' AND lock_until < now())::text AS stalled,
           count(*) FILTER (WHERE status = 'waiting')::text AS waiting,
           max(updated_at) FILTER (WHERE status = 'completed')::text AS last_completed
         FROM minion_jobs
         WHERE queue = $1`,
        [this.opts.queue],
      );

      // Reset consecutive failure counter on successful health check
      this.consecutiveHealthFailures = 0;

      const row = rows[0] ?? { stalled: '0', waiting: '0', last_completed: null };
      const stalledCount = parseInt(row.stalled ?? '0', 10);
      const waitingCount = parseInt(row.waiting ?? '0', 10);
      const lastCompleted = row.last_completed ? new Date(row.last_completed) : null;

      const now = Date.now();
      const minutesSinceCompletion = lastCompleted
        ? Math.round((now - lastCompleted.getTime()) / 60_000)
        : null;

      // F2 (per-threshold warns) — each is a distinct health_warn with reason.
      if (stalledCount > 10) {
        this.emit('health_warn', {
          reason: 'stalled_jobs',
          count: stalledCount,
          queue: this.opts.queue,
        });
      }

      if (waitingCount > 0 && minutesSinceCompletion !== null && minutesSinceCompletion > 30) {
        this.emit('health_warn', {
          reason: 'no_recent_completions',
          waiting_count: waitingCount,
          minutes_since_completion: minutesSinceCompletion,
          queue: this.opts.queue,
        });
      }

      // F4: suppress "worker not alive" warn while we're in the expected
      // null-child window (crash-exit → backoff-sleep → next-spawn).
      const cs = this.childSupervisor;
      const workerAlive = cs !== null && cs.childAlive;
      const inBackoff = cs !== null && cs.inBackoff;
      if (!workerAlive && !this.stopping && !inBackoff) {
        this.emit('health_warn', {
          reason: 'worker_not_alive',
          queue: this.opts.queue,
        });
      }
    } catch (e) {
      this.consecutiveHealthFailures++;
      const errMsg = e instanceof Error ? e.message : String(e);

      if (this.consecutiveHealthFailures >= 3) {
        // DB connection is likely dead. Emit a degraded warning.
        this.emit('health_warn', {
          reason: 'db_connection_degraded',
          consecutive_failures: this.consecutiveHealthFailures,
          error: errMsg,
          queue: this.opts.queue,
        });
        // Attempt to reconnect the engine if it supports it
        try {
          if ('reconnect' in this.engine && typeof (this.engine as Record<string, unknown>).reconnect === 'function') {
            await (this.engine as unknown as { reconnect(): Promise<void> }).reconnect();
            this.consecutiveHealthFailures = 0;
            this.emit('health_warn', {
              reason: 'db_reconnected',
              queue: this.opts.queue,
            });
          }
        } catch (reconnErr) {
          this.emit('health_error', {
            error: `reconnect failed: ${reconnErr instanceof Error ? reconnErr.message : String(reconnErr)}`,
            reconnect_failed: true,
            queue: this.opts.queue,
          });
        }
      } else {
        // Non-fatal single failure
        this.emit('health_error', {
          error: errMsg,
          queue: this.opts.queue,
        });
      }
    } finally {
      this.healthInFlight = false;
    }
  }
}
