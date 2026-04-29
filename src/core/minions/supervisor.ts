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

import { spawn, type ChildProcess } from 'child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
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
  private child: ChildProcess | null = null;
  private crashCount = 0;
  private lastStartTime = 0;
  private stopping = false;
  private inBackoff = false;
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

    // 4. Health monitoring.
    this.healthTimer = setInterval(() => { void this.healthCheck(); }, this.opts.healthInterval);

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

    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* already dead */ }
      await Promise.race([
        new Promise<void>(r => this.child!.once('exit', () => r())),
        new Promise<void>(r => setTimeout(() => r(), 35_000)),
      ]);
      if (this.child && !this.child.killed) {
        try { this.child.kill('SIGKILL'); } catch { /* already dead */ }
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

  /** Run the supervise loop: spawn child, await exit, backoff+retry or give up. */
  private async runSuperviseLoop(): Promise<void> {
    while (!this.stopping && this.crashCount < this.opts.maxCrashes) {
      await this.spawnOnce();

      if (this.stopping) return;

      if (this.crashCount >= this.opts.maxCrashes) {
        this.emit('max_crashes_exceeded', {
          crash_count: this.crashCount,
          max_crashes: this.opts.maxCrashes,
        });
        await this.shutdown('max_crashes', ExitCodes.MAX_CRASHES);
        return;
      }

      // crashCount - 1 is the retry-attempt index (0-based exponent for backoff math).
      // On first crash: crashCount=1, backoff exponent=0 → 1s.
      // After stable-run reset: crashCount=1 again → 1s fresh cycle.
      // Test-only: _backoffFloorMs short-circuits to a fixed tiny value so integration
      // tests can exercise crash loops in < 1s without waiting for the real curve.
      const backoff = this.opts._backoffFloorMs !== undefined
        ? this.opts._backoffFloorMs
        : calculateBackoffMs(this.crashCount - 1);

      this.emit('backoff', { ms: Math.round(backoff), crash_count: this.crashCount });

      this.inBackoff = true;
      try {
        await new Promise<void>(r => setTimeout(r, backoff));
      } finally {
        this.inBackoff = false;
      }
    }
  }

  /** Spawn the worker child once and await its exit. Updates `this.crashCount`. */
  private spawnOnce(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopping) { resolve(); return; }

      const args = [
        'jobs', 'work',
        '--concurrency', String(this.opts.concurrency),
        '--queue', this.opts.queue,
      ];
      if (this.opts.maxRssMb > 0) {
        args.push('--max-rss', String(this.opts.maxRssMb));
      }

      // Build child env. Explicit handling for GBRAIN_ALLOW_SHELL_JOBS:
      // inherit only when caller opts in, otherwise strip from the clone.
      const env: Record<string, string | undefined> = { ...process.env };
      if (this.opts.allowShellJobs) {
        env.GBRAIN_ALLOW_SHELL_JOBS = '1';
      } else {
        delete env.GBRAIN_ALLOW_SHELL_JOBS;
      }

      this.lastStartTime = Date.now();

      let child: ChildProcess;
      try {
        child = spawn(this.opts.cliPath, args, {
          stdio: 'inherit',
          env,
        });
      } catch (err: unknown) {
        // Synchronous spawn error (e.g., invalid cliPath shape). Count as a crash.
        this.emit('worker_spawn_failed', {
          cli_path: this.opts.cliPath,
          error: err instanceof Error ? err.message : String(err),
          phase: 'sync',
        });
        this.crashCount++;
        resolve();
        return;
      }

      this.child = child;

      this.emit('worker_spawned', { pid: child.pid, cli_path: this.opts.cliPath });

      // Async spawn errors (ENOENT, EACCES after the fork/exec). Node fires
      // 'error' first, then 'exit' with code=null. We log the error; the
      // 'exit' handler increments crashCount as usual so the restart loop
      // continues (max-crashes bounds this for permanent misconfigs).
      child.on('error', (err) => {
        this.emit('worker_spawn_failed', {
          cli_path: this.opts.cliPath,
          error: err.message,
          code: (err as NodeJS.ErrnoException).code ?? 'unknown',
          phase: 'async',
        });
      });

      child.on('exit', (code, signal) => {
        this.child = null;

        if (this.stopping) {
          resolve();
          return;
        }

        // Stable-run reset: if the worker ran > 5min before crashing, we forgive
        // prior crash history and treat this as the first crash of a new cycle
        // (crashCount = 1, so backoff math uses retry-index 0 = 1s).
        const runDuration = Date.now() - this.lastStartTime;
        if (runDuration > 5 * 60 * 1000) {
          this.crashCount = 1;
        } else {
          this.crashCount++;
        }

        const exitReason = signal ? `signal ${signal}` : `code ${code ?? 'null'}`;

        // Classify the likely cause for easier debugging
        let likelyCause: string;
        if (signal === 'SIGKILL') {
          likelyCause = 'oom_or_external_kill';
        } else if (signal === 'SIGTERM') {
          likelyCause = 'graceful_shutdown';
        } else if (code === 1) {
          likelyCause = 'runtime_error';
        } else if (code === 0) {
          likelyCause = 'clean_exit';
        } else {
          likelyCause = 'unknown';
        }

        this.emit('worker_exited', {
          code: code ?? null,
          signal: signal ?? null,
          reason: exitReason,
          likely_cause: likelyCause,
          crash_count: this.crashCount,
          max_crashes: this.opts.maxCrashes,
          run_duration_ms: runDuration,
        });

        resolve();
      });
    });
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
      const workerAlive = this.child != null && this.child.exitCode === null;
      if (!workerAlive && !this.stopping && !this.inBackoff) {
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
