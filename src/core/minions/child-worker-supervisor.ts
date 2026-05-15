/**
 * ChildWorkerSupervisor — Pure spawn-and-respawn core for child workers.
 *
 * Extracted from MinionSupervisor (src/core/minions/supervisor.ts) so it can
 * be reused by both MinionSupervisor (standalone `gbrain jobs supervisor`
 * daemon) and the autopilot command (src/commands/autopilot.ts). Pre-fix
 * those two had separate spawn loops with different crash-counting bugs;
 * this class is the single source of truth.
 *
 * RESPONSIBILITIES:
 *   - Spawn the child process (with optional tini wrapper for zombie reaping).
 *   - Await exit, classify the exit code, decide whether to respawn.
 *   - Track crash count and trip max_crashes for real failures (code != 0).
 *   - Track clean-restart budget for code=0 exits and apply backoff when
 *     the watchdog-drain rate exceeds the budget (D2 in plan).
 *   - Emit lifecycle events via injected callback.
 *
 * NON-RESPONSIBILITIES (these stay in the composing class):
 *   - PID file locking.
 *   - Signal handlers (SIGTERM/SIGINT).
 *   - process.exit() — composer decides what to do on max_crashes.
 *   - Health checks (DB probing, queue depth).
 *   - Audit-log writing (composer's onEvent decides where it lands).
 *
 * EXIT CLASSIFIER (post-D1/D2):
 *
 *   code === 0  -> crashCount UNCHANGED (preserves flap detection across
 *                  mixed exit sequences). Record clean-restart timestamp.
 *                  If clean-restart budget exceeded -> emit health_warn +
 *                  apply backoff. Else emit ms:0 backoff (immediate restart).
 *
 *   code !== 0  AND runDuration > stableRunResetMs -> crashCount = 1
 *                  (stable run forgives prior crash history).
 *
 *   code !== 0  AND runDuration <= stableRunResetMs -> crashCount++
 *                  (escalating exponential backoff).
 */

import { spawn, type ChildProcess } from 'child_process';
import { buildSpawnInvocation, detectTini } from './spawn-helpers.ts';
import { calculateBackoffMs } from './supervisor.ts';

export type ChildSupervisorEvent =
  | { kind: 'worker_spawned'; pid: number; tini: boolean }
  | { kind: 'worker_spawn_failed'; error: string; phase: 'sync' | 'async'; errnoCode?: string }
  | {
      kind: 'worker_exited';
      code: number | null;
      signal: NodeJS.Signals | null;
      runDurationMs: number;
      likelyCause: string;
      crashCount: number;
    }
  | {
      kind: 'backoff';
      ms: number;
      crashCount: number;
      reason: 'clean_exit' | 'crash' | 'budget_exceeded';
    }
  | {
      kind: 'health_warn';
      reason: 'clean_restart_budget_exceeded';
      count: number;
      windowMs: number;
    };

export interface ChildWorkerSupervisorOpts {
  /** Path to the gbrain CLI binary. */
  cliPath: string;
  /** Worker argv after cliPath (e.g. ['jobs', 'work', '--max-rss', '2048']). */
  args: string[];
  /** Child env. Defaults to a clone of process.env. */
  env?: NodeJS.ProcessEnv;
  /** Give up after this many consecutive code != 0 exits. */
  maxCrashes: number;
  /** Stable-run reset window: code != 0 after this duration resets crashCount to 1. Default 5 min. */
  stableRunResetMs?: number;

  /**
   * D2 clean-restart budget. Caps the rate of code=0 restarts so the
   * supervisor cannot tight-loop when the worker exits cleanly forever
   * (e.g. macOS RSS fallback path always over-threshold). When the count
   * of clean restarts inside `cleanRestartWindowMs` exceeds this number,
   * emit `health_warn` and apply `cleanRestartBudgetBackoffMs` before
   * the next spawn. Default 10.
   */
  cleanRestartBudget?: number;
  /** Sliding-window size for budget tracking. Default 60 seconds. */
  cleanRestartWindowMs?: number;
  /** Backoff applied when budget is exceeded. Default 1 second. */
  cleanRestartBudgetBackoffMs?: number;

  /**
   * Test-only override: minimum backoff in ms between child respawns.
   * Tests pass `1` to make crash-loops finish in < 1s. Not exposed via CLI.
   * @internal
   */
  _backoffFloorMs?: number;

  /** Lifecycle event callback. Composer routes these to its own log/audit channels. */
  onEvent: (event: ChildSupervisorEvent) => void;
  /** Called when crashCount reaches maxCrashes. Composer decides what to do (process.exit, shutdown, etc.). */
  onMaxCrashesExceeded: (count: number, max: number) => void;
  /** Accessor for the composer's stopping flag; loop exits when this returns true. */
  isStopping: () => boolean;

  /** Test seed for the clean-restart window. Defaults to Date.now. @internal */
  _now?: () => number;
}

const DEFAULTS = {
  stableRunResetMs: 5 * 60 * 1000,
  cleanRestartBudget: 10,
  cleanRestartWindowMs: 60_000,
  cleanRestartBudgetBackoffMs: 1_000,
} as const;

export class ChildWorkerSupervisor {
  private readonly opts: ChildWorkerSupervisorOpts;
  private readonly tiniPath: string;
  private _crashCount = 0;
  private _lastExitCode: number | null = null;
  private _cleanRestartTimestamps: number[] = [];
  private _child: ChildProcess | null = null;
  private _inBackoff = false;
  private _lastStartTime = 0;

  constructor(opts: ChildWorkerSupervisorOpts) {
    this.opts = opts;
    this.tiniPath = detectTini();
  }

  /** Read-only state surfaces for the composing class's health checks. */
  get childAlive(): boolean {
    return this._child !== null && this._child.exitCode === null;
  }
  get inBackoff(): boolean {
    return this._inBackoff;
  }
  get crashCount(): number {
    return this._crashCount;
  }
  /** Whether tini was detected at construction. Used by tests + worker_spawned event payload. */
  get isTiniDetected(): boolean {
    return this.tiniPath !== '';
  }

  /**
   * Send a signal to the live child (no-op if none). Used by composers'
   * shutdown paths. Idempotent — `kill('SIGTERM')` on a dead child is a no-op.
   */
  killChild(signal: NodeJS.Signals): void {
    if (this._child && !this._child.killed) {
      try {
        this._child.kill(signal);
      } catch {
        /* already dead */
      }
    }
  }

  /**
   * Wait for the current child to exit, bounded by `timeoutMs`. No-op if no
   * child is running. Used by composers' graceful-shutdown drains.
   */
  awaitChildExit(timeoutMs: number): Promise<void> {
    if (!this._child) return Promise.resolve();
    const child = this._child;
    return new Promise<void>((resolve) => {
      let settled = false;
      const onExit = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', onExit);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        child.removeListener('exit', onExit);
        resolve();
      }, timeoutMs);
    });
  }

  /**
   * Run the spawn-and-respawn loop. Resolves when:
   *   1. composer.isStopping() returns true, OR
   *   2. crashCount reaches maxCrashes (after firing onMaxCrashesExceeded).
   */
  async run(): Promise<void> {
    while (!this.opts.isStopping() && this._crashCount < this.opts.maxCrashes) {
      await this.spawnOnce();

      if (this.opts.isStopping()) return;

      if (this._crashCount >= this.opts.maxCrashes) {
        this.opts.onMaxCrashesExceeded(this._crashCount, this.opts.maxCrashes);
        return;
      }

      await this.applyBackoff();
    }
  }

  /** Single spawn lifecycle: spawn -> await exit -> classify. */
  private spawnOnce(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.opts.isStopping()) {
        resolve();
        return;
      }

      const env = this.opts.env ?? { ...process.env };
      this._lastStartTime = this.now();

      const { cmd: spawnCmd, args: spawnArgs } = buildSpawnInvocation(
        this.tiniPath,
        this.opts.cliPath,
        this.opts.args,
      );

      let child: ChildProcess;
      try {
        child = spawn(spawnCmd, spawnArgs, {
          stdio: 'inherit',
          env,
        });
      } catch (err: unknown) {
        // Synchronous spawn error (e.g. invalid cliPath shape). Count as a crash.
        this.opts.onEvent({
          kind: 'worker_spawn_failed',
          error: err instanceof Error ? err.message : String(err),
          phase: 'sync',
        });
        this._crashCount++;
        this._lastExitCode = null;
        resolve();
        return;
      }

      this._child = child;

      this.opts.onEvent({
        kind: 'worker_spawned',
        pid: child.pid ?? -1,
        tini: this.tiniPath !== '',
      });

      // Async spawn errors (ENOENT, EACCES). Node fires 'error' first, then
      // 'exit' with code=null. We log the error; the 'exit' handler increments
      // crashCount as usual so the restart loop bounds permanent misconfigs
      // via max_crashes.
      child.on('error', (err) => {
        this.opts.onEvent({
          kind: 'worker_spawn_failed',
          error: err.message,
          phase: 'async',
          errnoCode: (err as NodeJS.ErrnoException).code,
        });
      });

      child.on('exit', (code, signal) => {
        this._child = null;

        if (this.opts.isStopping()) {
          resolve();
          return;
        }

        const runDuration = this.now() - this._lastStartTime;

        // D1: code=0 is a clean exit (watchdog drain, graceful stop, etc.).
        // Don't touch crashCount — preserves flap detection across mixed
        // exit sequences. D2: record the clean-restart timestamp for budget
        // tracking and prune entries outside the sliding window.
        this._lastExitCode = code;
        if (code === 0) {
          const nowMs = this.now();
          this._cleanRestartTimestamps.push(nowMs);
          const windowMs = this.opts.cleanRestartWindowMs ?? DEFAULTS.cleanRestartWindowMs;
          const cutoff = nowMs - windowMs;
          this._cleanRestartTimestamps = this._cleanRestartTimestamps.filter(
            (t) => t > cutoff,
          );
        } else {
          const resetMs = this.opts.stableRunResetMs ?? DEFAULTS.stableRunResetMs;
          if (runDuration > resetMs) {
            // Stable-run reset: forgive prior crash history.
            this._crashCount = 1;
          } else {
            this._crashCount++;
          }
        }

        // Likely-cause heuristic, kept verbatim from MinionSupervisor.
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

        this.opts.onEvent({
          kind: 'worker_exited',
          code: code ?? null,
          signal: signal ?? null,
          runDurationMs: runDuration,
          likelyCause,
          crashCount: this._crashCount,
        });

        resolve();
      });
    });
  }

  /** Compute and apply backoff based on the most recent exit classifier. */
  private async applyBackoff(): Promise<void> {
    if (this._lastExitCode === 0) {
      // D2: check the clean-restart budget. If exceeded, emit health_warn
      // and apply a fixed cooldown so the next spawn isn't instant. This
      // bounds the worst case on platforms where Diff 2's RssAnon helper
      // falls back to VmRSS (macOS, kernel <4.5, restricted containers).
      const budget = this.opts.cleanRestartBudget ?? DEFAULTS.cleanRestartBudget;
      const windowMs = this.opts.cleanRestartWindowMs ?? DEFAULTS.cleanRestartWindowMs;
      if (this._cleanRestartTimestamps.length > budget) {
        this.opts.onEvent({
          kind: 'health_warn',
          reason: 'clean_restart_budget_exceeded',
          count: this._cleanRestartTimestamps.length,
          windowMs,
        });
        const cooldown =
          this.opts._backoffFloorMs !== undefined
            ? this.opts._backoffFloorMs
            : this.opts.cleanRestartBudgetBackoffMs ?? DEFAULTS.cleanRestartBudgetBackoffMs;
        this.opts.onEvent({
          kind: 'backoff',
          ms: Math.round(cooldown),
          crashCount: this._crashCount,
          reason: 'budget_exceeded',
        });
        this._inBackoff = true;
        try {
          await this.sleep(cooldown);
        } finally {
          this._inBackoff = false;
        }
        return;
      }
      // Within budget — immediate restart.
      this.opts.onEvent({
        kind: 'backoff',
        ms: 0,
        crashCount: this._crashCount,
        reason: 'clean_exit',
      });
      return;
    }

    // code != 0: exponential backoff scaled by crashCount-1 (retry-attempt
    // index). On first crash: crashCount=1, exponent=0 -> 1s. After stable-
    // run reset: crashCount=1 again -> 1s fresh cycle.
    const backoff =
      this.opts._backoffFloorMs !== undefined
        ? this.opts._backoffFloorMs
        : calculateBackoffMs(this._crashCount - 1);

    this.opts.onEvent({
      kind: 'backoff',
      ms: Math.round(backoff),
      crashCount: this._crashCount,
      reason: 'crash',
    });

    this._inBackoff = true;
    try {
      await this.sleep(backoff);
    } finally {
      this._inBackoff = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private now(): number {
    return this.opts._now ? this.opts._now() : Date.now();
  }
}
