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
import { classifyWorkerExit } from './exit-classification.ts';
import { calculateBackoffMs } from './supervisor.ts';
import { WORKER_EXIT_RSS_WATCHDOG } from './worker-exit-codes.ts';

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
      reason: 'clean_exit' | 'crash' | 'budget_exceeded' | 'rss_watchdog' | 'wedge_restart';
    }
  | {
      kind: 'health_warn';
      reason: 'clean_restart_budget_exceeded' | 'rss_watchdog_loop';
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
   * v0.42.5.0 (issue #1678) — RSS-watchdog loop breaker, cause-keyed and
   * INDEPENDENT of crashCount/max_crashes. A watchdog drain
   * (WORKER_EXIT_RSS_WATCHDOG) means the worker hit its memory cap, not that
   * the code is defective — so it does NOT count toward max_crashes (that
   * would stop ALL job processing, worse than slow-looping). Instead we
   * always apply `watchdogBackoffMs` (so an instant-OOM-on-startup can't
   * hot-loop) and, when more than `watchdogLoopBudget` watchdog exits land
   * inside `watchdogLoopWindowMs`, emit a loud `rss_watchdog_loop` health_warn
   * so the operator sees "raise --max-rss" instead of chasing a phantom
   * connection/lock failure. NOTE: the stable-run reset that defeats
   * max_crashes for >5-min runs is exactly why a SEPARATE window is required
   * here — routing watchdog exits through the crash path would never trip.
   */
  watchdogLoopBudget?: number;
  /** Sliding window for the watchdog-loop breaker. Default 10 minutes. */
  watchdogLoopWindowMs?: number;
  /** Backoff applied after every watchdog drain. Default 30 seconds. */
  watchdogBackoffMs?: number;

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
  watchdogLoopBudget: 3,
  watchdogLoopWindowMs: 10 * 60 * 1000,
  watchdogBackoffMs: 30_000,
} as const;

export class ChildWorkerSupervisor {
  private readonly opts: ChildWorkerSupervisorOpts;
  private readonly tiniPath: string;
  private _crashCount = 0;
  private _lastExitCode: number | null = null;
  private _cleanRestartTimestamps: number[] = [];
  /** Sliding window of RSS-watchdog exit timestamps (issue #1678). Separate
   *  from crashCount so the >5-min stable-run reset can't defeat the breaker. */
  private _watchdogExitTimestamps: number[] = [];
  private _child: ChildProcess | null = null;
  private _inBackoff = false;
  private _lastStartTime = 0;
  /** issue #1801: set by restartCurrentChild() before a deliberate wedge
   *  SIGTERM so the exit handler skips crash accounting. Cleared on exit. */
  private _intentionalRestart = false;
  /** issue #1801: carried from the exit handler to applyBackoff so a wedge
   *  self-heal respawns immediately (ms:0) instead of paying crash backoff. */
  private _lastWasIntentionalRestart = false;

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
    // Gate on LIVENESS, not `.killed`. Node's `child.killed` flips true the
    // moment a signal has been *sent*, not when the process exits — so a guard
    // of `!this._child.killed` makes a follow-up SIGKILL (after an ignored
    // SIGTERM) a silent no-op. That bug bit both the wedge escalation AND the
    // existing shutdown() drain (issue #1801, Codex #1). Checking exitCode /
    // signalCode === null means "still running," so SIGKILL actually lands on a
    // process that ignored SIGTERM.
    const child = this._child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    }
  }

  /**
   * Wait for the current child to exit, bounded by `timeoutMs`. No-op if no
   * child is running. Used by composers' graceful-shutdown drains.
   *
   * Handles the already-exited case: if the child terminated between
   * `killChild('SIGTERM')` and this call (common on fast SIGTERM
   * responders), Node's `'exit'` event has already fired and a late
   * `once('exit', ...)` listener would never resolve. We probe
   * `child.exitCode !== null` first and short-circuit so clean shutdown
   * is sub-second instead of waiting out the full `timeoutMs`.
   */
  awaitChildExit(timeoutMs: number): Promise<void> {
    if (!this._child) return Promise.resolve();
    return this._awaitExit(this._child, timeoutMs);
  }

  /**
   * awaitChildExit, bound to a SPECIFIC captured child reference rather than
   * `this._child`. The wedge-restart path (issue #1801) must wait on the child
   * it SIGTERMed, not whatever `this._child` points at later — by the time the
   * grace window elapses, `run()` may have respawned a fresh child, and a
   * `this._child`-based wait/kill would hit the replacement (Codex #2).
   */
  private _awaitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    // Already exited? `exitCode` becomes non-null once Node has seen the
    // child terminate. `signalCode` is the symmetric flag for kill-signal
    // termination — checked too so a SIGKILLed child also short-circuits.
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
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
   * Intentional restart of the CURRENT child — the supervisor's wedge watchdog
   * (issue #1801) calls this when a worker is alive but making no forward
   * progress (dead pool, stuck handler). Captures the live child reference,
   * SIGTERMs it, waits up to `graceMs` on THAT captured ref, then SIGKILLs THAT
   * ref if it ignored SIGTERM. Operating on the captured reference (never
   * `this._child`) closes the race where `run()` respawns a fresh child during
   * the grace window (Codex #2). The exit is flagged intentional so it does NOT
   * count toward crashCount / max_crashes (Codex #3) — a deliberate self-heal,
   * not a worker defect; the caller bounds repetition via its wedge-restart
   * loop budget. `run()` respawns a fresh worker (and a fresh DB pool) on exit.
   */
  async restartCurrentChild(graceMs: number): Promise<void> {
    const child = this._child;
    if (!child) return;
    this._intentionalRestart = true;
    // SIGTERM the captured child (liveness-gated, same fix as killChild).
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
    await this._awaitExit(child, graceMs);
    // Escalate to SIGKILL only if the CAPTURED child is still alive — never the
    // respawned one.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
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
        // tracking and prune entries outside the sliding window. Routes
        // through the shared `classifyWorkerExit` helper so doctor.ts and
        // jobs.ts (audit-log consumers) read the same rule.
        this._lastExitCode = code;
        if (this._intentionalRestart) {
          // issue #1801: deliberate wedge self-heal (restartCurrentChild). Leave
          // crashCount UNTOUCHED — like the RSS watchdog — so a recurring wedge
          // never trips max_crashes and kills the daemon. A SIGTERM exit has
          // code=null, which classifyWorkerExit() (correctly) treats as a crash,
          // so without this guard the wedge restart would increment crashCount
          // (Codex #3). The supervisor's wedgeRestartLoopBudget bounds repetition.
          this._intentionalRestart = false;
          this._lastWasIntentionalRestart = true;
        } else if (code === WORKER_EXIT_RSS_WATCHDOG) {
          // issue #1678: RSS-watchdog drain. NOT a code defect — leave
          // crashCount untouched so it never trips max_crashes (which would
          // stop ALL job processing). Tracked in its own window so the
          // breaker survives the >5-min stable-run reset that defeats the
          // generic crash path.
          const nowMs = this.now();
          this._watchdogExitTimestamps.push(nowMs);
          const windowMs = this.opts.watchdogLoopWindowMs ?? DEFAULTS.watchdogLoopWindowMs;
          const cutoff = nowMs - windowMs;
          this._watchdogExitTimestamps = this._watchdogExitTimestamps.filter(
            (t) => t > cutoff,
          );
        } else if (classifyWorkerExit({ code }) === 'clean_exit') {
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
        if (this._lastWasIntentionalRestart) {
          // issue #1801: a deliberate wedge restart. Label it as such even
          // though the kill signal was SIGTERM/SIGKILL, so the audit summary
          // (supervisor-audit.ts CLEAN_EXIT_CAUSES) counts it as a self-heal,
          // not a crash.
          likelyCause = 'wedge_restart';
        } else if (signal === 'SIGKILL') {
          likelyCause = 'oom_or_external_kill';
        } else if (signal === 'SIGTERM') {
          likelyCause = 'graceful_shutdown';
        } else if (code === WORKER_EXIT_RSS_WATCHDOG) {
          likelyCause = 'rss_watchdog';
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
    if (this._lastWasIntentionalRestart) {
      // issue #1801: a deliberate wedge restart. Respawn immediately (a fresh
      // pool is the whole point of the self-heal) — no crash backoff, no
      // budget accounting (the supervisor's wedgeRestartLoopBudget owns that).
      this._lastWasIntentionalRestart = false;
      this.opts.onEvent({
        kind: 'backoff',
        ms: 0,
        crashCount: this._crashCount,
        reason: 'wedge_restart',
      });
      return;
    }

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

    // issue #1678: RSS-watchdog drain. Always back off (so an instant-OOM on
    // startup can't hot-loop) and, when more than `watchdogLoopBudget` drains
    // land inside the window, emit the loud `rss_watchdog_loop` alert. crashCount
    // is untouched (the worker is fine; the cap is too low), so this branch
    // never trips max_crashes — the workload keeps running, just paced + loud.
    if (this._lastExitCode === WORKER_EXIT_RSS_WATCHDOG) {
      const count = this._watchdogExitTimestamps.length;
      const budget = this.opts.watchdogLoopBudget ?? DEFAULTS.watchdogLoopBudget;
      const windowMs = this.opts.watchdogLoopWindowMs ?? DEFAULTS.watchdogLoopWindowMs;
      if (count > budget) {
        this.opts.onEvent({
          kind: 'health_warn',
          reason: 'rss_watchdog_loop',
          count,
          windowMs,
        });
      }
      const watchdogBackoff =
        this.opts._backoffFloorMs !== undefined
          ? this.opts._backoffFloorMs
          : this.opts.watchdogBackoffMs ?? DEFAULTS.watchdogBackoffMs;
      this.opts.onEvent({
        kind: 'backoff',
        ms: Math.round(watchdogBackoff),
        crashCount: this._crashCount,
        reason: 'rss_watchdog',
      });
      this._inBackoff = true;
      try {
        await this.sleep(watchdogBackoff);
      } finally {
        this._inBackoff = false;
      }
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
