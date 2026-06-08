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
import { resolveDefaultMaxRssMb } from './rss-default.ts';
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
import { tryAcquireDbLock, type DbLockHandle } from '../db-lock.ts';
import { currentBrainId } from './worker-registry.ts';

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
   *  When omitted, the constructor auto-sizes cgroup-aware via
   *  resolveDefaultMaxRssMb() (issue #1678) instead of a flat default.
   *  Set to 0 to spawn the worker without a watchdog. */
  maxRssMb: number;
  /** Niceness (issue #1815) the operator requested via `--nice` / `GBRAIN_NICE`,
   *  or undefined to inherit. When set, the worker is spawned with `--nice N` so
   *  it re-applies the value (the supervisor itself is reniced by the CLI layer,
   *  before construction). The apply RESULT is computed in jobs.ts and passed in
   *  here purely so the `started` audit event records what actually happened —
   *  the supervisor does not call setPriority. */
  nice_requested?: number;
  /** Effective niceness of the supervisor process after its own renice attempt. */
  nice_effective?: number;
  /** Error string if the supervisor's own renice failed (e.g. EPERM). */
  nice_error?: string;
  /**
   * issue #1801 — progress watchdog. When a child is alive but makes no forward
   * progress on claimable work for this many minutes (waiting_claimable > 0 and
   * active_healthy == 0 across `wedgeRestartChecks` consecutive health checks),
   * the supervisor forcibly restarts it so the respawn rebuilds a fresh DB pool.
   * Set to 0 to DISABLE the wedge watchdog. Default: 15.
   */
  wedgeRestartMinutes: number;
  /** Consecutive wedged health checks required before a restart fires (hysteresis). Default: 3. */
  wedgeRestartChecks: number;
  /** Max wedge restarts inside `wedgeRestartLoopWindowMs` before the supervisor
   *  stops restarting and emits `wedge_restart_loop` (alert-only — a dead-pool
   *  wedge resolves in one restart; a loop means restart isn't the fix). Default: 3. */
  wedgeRestartLoopBudget: number;
  /** Sliding window for the wedge-restart loop breaker, ms. Default: 30 min. */
  wedgeRestartLoopWindowMs: number;
  /** After a (re)spawn, suppress wedge evaluation for this long so a fresh
   *  worker gets a fair claim window before the wedge clock applies (the DB's
   *  last_completed is still stale right after a restart). Default: 2× healthInterval. */
  startupGraceMs: number;
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
  // #1849: key the default pidfile on the brain id so two DIFFERENT brains
  // under one HOME don't share `supervisor.pid` and falsely block each other's
  // pidfile guard. Derived from config (no DB connect), so it's safe to
  // resolve at module load — `status`/`stop` need a cheap path before the
  // engine connects. The queue-scoped DB lock (supervisorLockId) is the real
  // singleton authority; this just removes the common-case footgun.
  let brainId = 'default';
  try { brainId = currentBrainId(); } catch { /* fallback 'default' */ }
  return `${home}/.gbrain/supervisor-${brainId}.pid`;
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
  // issue #1801 progress-watchdog defaults. Conservative: a dead-pool wedge is
  // caught faster by the worker's own DB probe (fix #2, ~3 min); this 15-min
  // watchdog is the cause-agnostic backstop for non-DB wedges (stuck handler,
  // deadlock) so it deliberately fires slower to avoid racing fix #2.
  wedgeRestartMinutes: 15,
  wedgeRestartChecks: 3,
  wedgeRestartLoopBudget: 3,
  wedgeRestartLoopWindowMs: 30 * 60_000,
  startupGraceMs: 120_000, // overridden to 2× healthInterval in the constructor
};

/**
 * Build the argv the supervisor uses to spawn `gbrain jobs work`. Extracted from
 * runSuperviseLoop so it's unit-testable (issue #1815, Codex). Appends `--nice N`
 * when the operator requested a niceness, alongside the existing concurrency /
 * queue / max-rss flags. The spawned worker re-applies the niceness to itself;
 * niceness also inherits to the worker's own children automatically.
 */
export function buildWorkerArgs(
  opts: Pick<SupervisorOpts, 'concurrency' | 'queue' | 'maxRssMb' | 'nice_requested'>,
): string[] {
  const args = [
    'jobs', 'work',
    '--concurrency', String(opts.concurrency),
    '--queue', opts.queue,
  ];
  if (opts.maxRssMb > 0) {
    args.push('--max-rss', String(opts.maxRssMb));
  }
  if (opts.nice_requested !== undefined) {
    args.push('--nice', String(opts.nice_requested));
  }
  return args;
}

/** Grace before SIGKILL when restarting a wedged child — reuses the 35s
 *  shutdown() drain window (issue #1801, D3). */
const WEDGE_RESTART_GRACE_MS = 35_000;

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

/**
 * issue #1801 — queue + name-scoped wedge signals. Exported (with the SQL) so
 * the FILTER semantics are testable against a real engine (PGLite) without
 * spinning a supervisor process:
 *   - `activeHealthy` counts only LIVE-lock active rows, so an expired-lock
 *     active row (a worker that died mid-job) does NOT mask the wedge (Codex #6).
 *   - `waitingClaimable` counts waiting OR due-delayed (delay_until <= now) rows
 *     whose name the worker can claim — due-delayed because a dead pool means
 *     promoteDelayed never ran (Codex #5/#7).
 *   - `lastCompletedClaimable` is freshness of progress on claimable names only.
 */
export interface WedgeSignals {
  stalled: number;
  activeHealthy: number;
  waiting: number;
  waitingClaimable: number;
  lastCompleted: Date | null;
  lastCompletedClaimable: Date | null;
}

export async function queryWedgeSignals(
  engine: BrainEngine,
  queue: string,
  handlerNames: string[],
): Promise<WedgeSignals> {
  const rows = await engine.executeRaw<{
    stalled: string;
    active_healthy: string;
    waiting: string;
    waiting_claimable: string;
    last_completed: string | null;
    last_completed_claimable: string | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'active' AND lock_until < now())::text AS stalled,
       count(*) FILTER (WHERE status = 'active' AND lock_until > now())::text AS active_healthy,
       count(*) FILTER (WHERE status = 'waiting')::text AS waiting,
       count(*) FILTER (WHERE (status = 'waiting'
                          OR (status = 'delayed' AND delay_until <= now()))
                         AND name = ANY($2::text[]))::text AS waiting_claimable,
       max(updated_at) FILTER (WHERE status = 'completed')::text AS last_completed,
       max(updated_at) FILTER (WHERE status = 'completed'
                               AND name = ANY($2::text[]))::text AS last_completed_claimable
     FROM minion_jobs
     WHERE queue = $1`,
    [queue, handlerNames],
  );
  const row = rows[0] ?? {
    stalled: '0', active_healthy: '0', waiting: '0',
    waiting_claimable: '0', last_completed: null, last_completed_claimable: null,
  };
  return {
    stalled: parseInt(row.stalled ?? '0', 10),
    activeHealthy: parseInt(row.active_healthy ?? '0', 10),
    waiting: parseInt(row.waiting ?? '0', 10),
    waitingClaimable: parseInt(row.waiting_claimable ?? '0', 10),
    lastCompleted: row.last_completed ? new Date(row.last_completed) : null,
    lastCompletedClaimable: row.last_completed_claimable
      ? new Date(row.last_completed_claimable)
      : null,
  };
}

/** Exit codes for documented agent branching. */
export const ExitCodes = {
  CLEAN: 0,
  MAX_CRASHES: 1,
  LOCK_HELD: 2,
  PID_UNWRITABLE: 3,
  // #1849: the queue-scoped DB lock was lost mid-run (refresh failed past the
  // threshold). Exit non-zero so the process manager restarts us cleanly
  // rather than risk two live supervisors on one queue.
  LOCK_LOST: 4,
} as const;

/**
 * #1849: queue-scoped supervisor singleton DB lock.
 *
 * The pidfile guard is mutually exclusive only per pidfile PATH — two
 * supervisors with different $HOME / --pid-file both acquire and run on the
 * same (db, queue) with conflicting --max-rss. The DB lock makes the mutex
 * domain match the protected resource (the database + queue), regardless of
 * pidfile path. TTL > refresh-interval × max-failures so we always exit
 * before our lock could lapse and let a second supervisor take over.
 */
const SUPERVISOR_LOCK_TTL_MIN = 5;
const SUPERVISOR_LOCK_REFRESH_MS = 60_000;
const SUPERVISOR_LOCK_REFRESH_MAX_FAILURES = 3; // 3 × 60s = 180s < 5min TTL

/**
 * #1849: the queue-scoped supervisor singleton lock id. Keyed ONLY on the
 * queue, because the lock ROW lives inside the target database — the (database)
 * half of the mutex domain is physical, not part of the key. Keying on a
 * config-derived DB identity (the prior `currentDbIdentity()`) was a bug: two
 * supervisors pointed at the SAME physical database via different-but-equivalent
 * URLs/config paths (pooler vs direct port, host alias, trailing params) hashed
 * to different ids and BOTH acquired the "singleton" lock in the one shared
 * locks table. Queue-only keying makes same-DB + same-queue collide correctly,
 * while different physical databases never collide (separate locks tables).
 * Exported so `gbrain doctor` queries the same row to surface the holder +
 * effective --max-rss.
 */
export function supervisorLockId(queue: string): string {
  return `gbrain-supervisor:${queue}`;
}

/**
 * #1849 (doctor): pure classification of the supervisor singleton state from
 * the DB lock holder vs the local pidfile holder. Compares host+pid (bare pid
 * is meaningless across hosts/containers — Codex #25).
 *
 *   - `no_lock`  — no live lock holder (nothing to assert).
 *   - `single`   — the live lock holder IS the local pidfile holder. Healthy.
 *   - `mismatch` — a live lock holder differs from the local pidfile holder:
 *                  a second supervisor likely ran with a different --max-rss.
 */
export function classifySupervisorSingleton(args: {
  lockLive: boolean;
  lockHolderHost: string | null;
  lockHolderPid: number | null;
  localHost: string;
  localPid: number | null;
}): 'no_lock' | 'single' | 'mismatch' {
  if (!args.lockLive || args.lockHolderHost === null || args.lockHolderPid === null) {
    return 'no_lock';
  }
  if (args.localPid === null) return 'mismatch';
  const matches = args.lockHolderHost === args.localHost && args.lockHolderPid === args.localPid;
  return matches ? 'single' : 'mismatch';
}

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
  // #1849: queue-scoped DB singleton lock (the real authority) + its refresh
  // timer and consecutive-failure counter (fail-safe exit before TTL lapse).
  private dbLock: DbLockHandle | null = null;
  private lockRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private lockRefreshFailures = 0;
  // issue #1801 progress-watchdog state.
  /** Job names the spawned worker can actually claim. Derived once at start()
   *  from registerBuiltinHandlers so the wedge scopes to real claimable work
   *  (no false-positive on unhandled names). Empty = watchdog inert. */
  private handlerNames: string[] = [];
  /** Consecutive health checks that saw the wedge condition. */
  private consecutiveWedgedChecks = 0;
  /** Timestamps of recent wedge restarts (loop-breaker window). */
  private wedgeRestartTimestamps: number[] = [];
  /** Whether the `wedge_restart_loop` give-up alert has already fired for the
   *  current exhausted window — so it emits once, not every health tick. Re-arms
   *  when a real restart fires again (window drained below budget). */
  private wedgeLoopAlerted = false;
  /** True while a restartCurrentChild() is in flight (suppresses re-escalation). */
  private escalationInFlight = false;
  /** Wall-clock of the most recent child spawn (startup-grace anchor). */
  private childStartedAt: number | null = null;

  constructor(engine: BrainEngine, opts: Partial<SupervisorOpts> & { cliPath: string }) {
    this.engine = engine;
    this.opts = { ...DEFAULTS, ...opts };

    // issue #1678 (Codex #4): when the caller didn't pin an explicit cap,
    // auto-size cgroup-aware instead of the flat DEFAULTS.maxRssMb footgun.
    // The CLI (jobs.ts supervisor) already resolves this and passes a concrete
    // number; this covers direct-API / programmatic construction so the
    // standalone supervisor never silently runs on the old 2048 default.
    if (opts.maxRssMb === undefined) {
      this.opts.maxRssMb = resolveDefaultMaxRssMb();
    }

    // issue #1801: default the startup grace to 2× the health interval so a
    // freshly (re)spawned worker gets at least two health ticks to claim work
    // before the wedge clock can fire. Honors an explicit override.
    if (opts.startupGraceMs === undefined) {
      this.opts.startupGraceMs = this.opts.healthInterval * 2;
    }

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
   * @internal Test seams for the issue #1801 wedge watchdog. The escalation
   * state machine (counter / thresholds / startup grace / loop budget) is hard
   * to exercise via the real spawn loop, so tests inject a fake child supervisor
   * + wedge state and drive a single health check directly.
   */
  _setChildSupervisorForTests(
    cs: Pick<ChildWorkerSupervisor, 'childAlive' | 'inBackoff' | 'restartCurrentChild'>,
  ): void {
    this.childSupervisor = cs as unknown as ChildWorkerSupervisor;
  }
  /** @internal */
  _setWedgeStateForTests(s: { handlerNames?: string[]; childStartedAt?: number | null }): void {
    if (s.handlerNames !== undefined) this.handlerNames = s.handlerNames;
    if (s.childStartedAt !== undefined) this.childStartedAt = s.childStartedAt;
  }
  /** @internal Run one health check (the timer body) synchronously. */
  async _healthCheckOnceForTests(): Promise<void> {
    await this.healthCheck();
  }
  /** @internal */
  get _consecutiveWedgedChecksForTests(): number {
    return this.consecutiveWedgedChecks;
  }
  /** @internal */
  get _wedgeRestartCountForTests(): number {
    return this.wedgeRestartTimestamps.length;
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
    //    Installed BEFORE the DB-lock acquisition below: acquirePidLock just
    //    wrote OUR pid into the pidfile, so any early `process.exit` after this
    //    point (notably the LOCK_HELD path in 1b) MUST clean it up or it leaves
    //    a stale pidfile that blocks the next start on this path. The listener
    //    only unlinks when the file still holds our pid, so it's a no-op on the
    //    'held'/'unwritable' paths above (those never created our pidfile).
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

    // 1b. #1849: queue-scoped DB singleton lock — the REAL authority. A second
    // supervisor with a different $HOME / --pid-file passes the pidfile check
    // above but loses here, so it can't run a conflicting --max-rss worker on
    // the same (db, queue). Keyed on the queue alone; the database half of the
    // mutex is physical (the lock row lives in this DB).
    this.dbLock = await tryAcquireDbLock(this.engine, this.supervisorLockId(), SUPERVISOR_LOCK_TTL_MIN);
    if (!this.dbLock) {
      console.error(
        `Supervisor already running for queue '${this.opts.queue}' on this database ` +
        `(another supervisor holds the queue lock, regardless of pidfile path). Exiting.`,
      );
      // The exit listener installed above removes the pidfile we just created.
      process.exit(ExitCodes.LOCK_HELD);
    }
    // Refresh the lock on its own timer (independent of healthInterval, which
    // can be 0/disabled) so the TTL never lapses while we're alive.
    this.lockRefreshTimer = setInterval(() => { void this.refreshDbLock(); }, SUPERVISOR_LOCK_REFRESH_MS);

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
      // #1849: record the EFFECTIVE --max-rss so `gbrain doctor` can surface
      // the cap a rogue second supervisor would have fought over.
      max_rss_mb: this.opts.maxRssMb,
      // Niceness (issue #1815): record requested + effective so doctor/status can
      // surface a failed renice even for a detached supervisor whose stderr is gone.
      ...(this.opts.nice_requested !== undefined ? { nice_requested: this.opts.nice_requested } : {}),
      ...(this.opts.nice_effective !== undefined ? { nice_effective: this.opts.nice_effective } : {}),
      ...(this.opts.nice_error ? { nice_error: this.opts.nice_error } : {}),
    });

    // 6. Derive the claimable job-name set for the wedge watchdog (issue #1801).
    //    Done before the loop so the first health check can scope correctly.
    await this.deriveHandlerNames();

    // 7. Run the supervise loop (respawn on crash, bounded by maxCrashes).
    await this.runSuperviseLoop();
  }

  /**
   * issue #1801: derive the exact set of job names the spawned worker can claim,
   * by running the real `registerBuiltinHandlers` against a throwaway worker (never
   * started — no timers, no DB) and reading `registeredNames`. Zero duplication vs
   * a hand-maintained constant, and it auto-tracks every future handler (Codex
   * #16). Lazy-imported to avoid the supervisor.ts ↔ jobs.ts / worker.ts import
   * cycle. On any failure the watchdog stays inert (empty names → waiting_claimable
   * is always 0 → no restart) rather than risk a misscoped kill — the worker's own
   * DB probe (fix #2) still covers the dead-pool case.
   */
  private async deriveHandlerNames(): Promise<void> {
    try {
      const [{ MinionWorker }, { registerBuiltinHandlers }] = await Promise.all([
        import('./worker.ts'),
        import('../../commands/jobs.ts'),
      ]);
      const probe = new MinionWorker(this.engine, {
        queue: this.opts.queue,
        healthCheckInterval: 0,
      });
      // `shell` is always registered regardless of allowShellJobs (the env only
      // gates execution), so registeredNames is a static set — `quiet` just
      // suppresses the informational startup lines during derivation.
      await registerBuiltinHandlers(probe, this.engine, { quiet: true });
      this.handlerNames = [...probe.registeredNames];
    } catch (e) {
      this.handlerNames = [];
      this.emit('health_warn', {
        reason: 'wedge_watchdog_inert',
        error: e instanceof Error ? e.message : String(e),
        queue: this.opts.queue,
      });
    }
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

    // #1849: stop refreshing + release the DB singleton lock so a clean
    // restart (or a different host) can re-acquire immediately instead of
    // waiting out the TTL. release() is best-effort; the TTL covers a crash.
    if (this.lockRefreshTimer) {
      clearInterval(this.lockRefreshTimer);
      this.lockRefreshTimer = null;
    }
    if (this.dbLock) {
      const lock = this.dbLock;
      this.dbLock = null;
      try { await lock.release(); } catch { /* best-effort; TTL fallback covers it */ }
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

  /** #1849: the queue-scoped DB lock id for this supervisor's queue. */
  private supervisorLockId(): string {
    return supervisorLockId(this.opts.queue);
  }

  /** @internal Test seam: inject a fake DB lock to drive refresh-failure paths. */
  _setDbLockForTests(lock: DbLockHandle | null): void {
    this.dbLock = lock;
  }
  /** @internal Test seam: run one refresh tick synchronously. */
  async _refreshDbLockForTests(): Promise<void> {
    await this.refreshDbLock();
  }

  /**
   * #1849 (F1A): refresh the DB lock; FAIL SAFE on loss. If refresh keeps
   * throwing, our TTL will eventually lapse and a second supervisor could take
   * over the queue — the exact bug. So past the failure threshold (still well
   * inside the TTL window) we stop claiming and exit non-zero; the process
   * manager restarts a single clean supervisor. A single transient blip is
   * tolerated (counter resets on the next success).
   */
  private async refreshDbLock(): Promise<void> {
    if (!this.dbLock || this.stopping) return;
    try {
      await this.dbLock.refresh();
      this.lockRefreshFailures = 0;
    } catch (e) {
      this.lockRefreshFailures++;
      this.emit('health_warn', {
        reason: 'supervisor_lock_refresh_failed',
        consecutive_failures: this.lockRefreshFailures,
        error: e instanceof Error ? e.message : String(e),
        queue: this.opts.queue,
      });
      if (this.lockRefreshFailures >= SUPERVISOR_LOCK_REFRESH_MAX_FAILURES) {
        this.emit('health_error', {
          reason: 'supervisor_lock_lost',
          queue: this.opts.queue,
        });
        await this.shutdown('supervisor_lock_lost', ExitCodes.LOCK_LOST);
      }
    }
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
    const workerArgs = buildWorkerArgs(this.opts);

    // Build child env. Explicit handling for GBRAIN_ALLOW_SHELL_JOBS:
    // inherit only when caller opts in, otherwise strip from the clone.
    const env: Record<string, string | undefined> = { ...process.env };
    if (this.opts.allowShellJobs) {
      env.GBRAIN_ALLOW_SHELL_JOBS = '1';
    } else {
      delete env.GBRAIN_ALLOW_SHELL_JOBS;
    }
    // Signal to the child worker that it's running under a supervisor.
    // issue #1801: the worker's DB-liveness probe STILL runs under supervision
    // (it's the only "is MY pool dead" signal; the supervisor watches a
    // different connection). This env var only makes the worker skip its STALL
    // detection — the supervisor's progress watchdog owns forward-progress.
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
        // issue #1801: anchor the startup grace + reset the wedge counter so a
        // fresh child is judged on its own forward progress, not the prior
        // (possibly wedged) one's stale DB state.
        this.childStartedAt = Date.now();
        this.consecutiveWedgedChecks = 0;
        this.emit('worker_spawned', {
          pid: event.pid >= 0 ? event.pid : undefined,
          cli_path: this.opts.cliPath,
          ...(event.tini ? { tini: true } : {}),
          ...(this.opts.nice_requested !== undefined ? { nice: this.opts.nice_requested } : {}),
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
          // issue #1678 (A3): the supervisor knows the --max-rss it spawned
          // with; name it in the OOM-loop alert so the operator's fix
          // ("raise --max-rss") is one glance away. Peak RSS stays in the
          // worker's own stderr line (the supervisor never sees it).
          ...(event.reason === 'rss_watchdog_loop' ? { max_rss_mb: this.opts.maxRssMb } : {}),
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
      const sig = await queryWedgeSignals(this.engine, this.opts.queue, this.handlerNames);

      // Reset consecutive failure counter on successful health check
      this.consecutiveHealthFailures = 0;

      const stalledCount = sig.stalled;
      const activeHealthyCount = sig.activeHealthy;
      const waitingCount = sig.waiting;
      const waitingClaimableCount = sig.waitingClaimable;

      const now = Date.now();
      const minutesSinceCompletion = sig.lastCompleted
        ? Math.round((now - sig.lastCompleted.getTime()) / 60_000)
        : null;
      const minutesSinceClaimable = sig.lastCompletedClaimable
        ? Math.round((now - sig.lastCompletedClaimable.getTime()) / 60_000)
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

      // issue #1801 — progress watchdog. A child that is ALIVE but makes no
      // forward progress on claimable work is invisible to liveness checks
      // (the dead-pool zombie that caused the 15h halt). Restart it so the
      // respawn rebuilds a fresh DB pool.
      //
      //   - active_healthy === 0 is the real guard: a worker mid-job holds a
      //     live lock (active_healthy > 0) and resets the counter; an expired-
      //     lock active row does NOT suppress (Codex #6).
      //   - waiting_claimable > 0: there is work THIS worker could claim
      //     (name-scoped; incl. due-delayed) (Codex #5/#7).
      //   - claimable progress is stale (or never happened) past the window.
      //   - startup grace: a freshly (re)spawned worker gets a fair claim
      //     window before the wedge clock applies (Codex #9/#10).
      const childAgeMs = this.childStartedAt !== null ? now - this.childStartedAt : 0;
      const pastStartupGrace = childAgeMs > this.opts.startupGraceMs;
      const claimableStale =
        minutesSinceClaimable === null || minutesSinceClaimable > this.opts.wedgeRestartMinutes;
      const wedged =
        this.opts.wedgeRestartMinutes > 0 &&
        waitingClaimableCount > 0 &&
        activeHealthyCount === 0 &&
        claimableStale &&
        workerAlive &&
        !inBackoff &&
        !this.stopping &&
        !this.escalationInFlight &&
        pastStartupGrace;

      if (wedged) {
        this.consecutiveWedgedChecks++;
        if (this.consecutiveWedgedChecks >= this.opts.wedgeRestartChecks) {
          await this.escalateWedgedWorker(waitingClaimableCount, minutesSinceClaimable);
        }
      } else {
        this.consecutiveWedgedChecks = 0;
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

  /**
   * issue #1801: forcibly restart an alive-but-wedged child. Bounded by a
   * sliding-window loop budget — a dead-pool wedge resolves in exactly one
   * restart (fresh process ⇒ fresh pool), so repeated restarts inside the
   * window mean restart isn't the fix (e.g. a deterministically-failing
   * handler); switch to alert-only via `wedge_restart_loop` instead of
   * thrashing. The kill mechanics live in ChildWorkerSupervisor.restartCurrentChild
   * (owns child identity + the intentional-restart crash accounting).
   *
   * Awaited inside healthCheck()'s try, so `healthInFlight` keeps the next
   * health tick from overlapping the ~grace-bounded restart, and
   * `escalationInFlight` keeps the wedge predicate from re-firing.
   */
  private async escalateWedgedWorker(
    waitingClaimable: number,
    minutesSinceCompletion: number | null,
  ): Promise<void> {
    const cs = this.childSupervisor;
    if (!cs) return;

    const now = Date.now();
    this.wedgeRestartTimestamps = this.wedgeRestartTimestamps.filter(
      (t) => t > now - this.opts.wedgeRestartLoopWindowMs,
    );
    // `>=` so the budget is a real ceiling (the Nth restart is the last allowed,
    // not the N+1th) — issue #1801 Codex #13.
    if (this.wedgeRestartTimestamps.length >= this.opts.wedgeRestartLoopBudget) {
      // Give up restarting (restart isn't fixing it). Alert ONCE on entry to
      // the exhausted state — without this flag the wedge predicate re-fires
      // every health tick for the whole window and floods the audit log with
      // identical `wedge_restart_loop` warns. Reset the counter so the predicate
      // doesn't busy-spin; the flag re-arms below once a real restart fires
      // again (window drained below budget).
      if (!this.wedgeLoopAlerted) {
        this.wedgeLoopAlerted = true;
        this.emit('health_warn', {
          reason: 'wedge_restart_loop',
          count: this.wedgeRestartTimestamps.length,
          window_ms: this.opts.wedgeRestartLoopWindowMs,
          waiting_claimable: waitingClaimable,
          queue: this.opts.queue,
        });
      }
      this.consecutiveWedgedChecks = 0;
      return;
    }

    this.wedgeLoopAlerted = false; // re-arm: window has room, we're restarting
    this.wedgeRestartTimestamps.push(now);
    this.consecutiveWedgedChecks = 0;
    this.escalationInFlight = true;
    this.emit('health_warn', {
      reason: 'restarting_wedged_worker',
      waiting_claimable: waitingClaimable,
      minutes_since_completion: minutesSinceCompletion,
      consecutive_wedged_checks: this.opts.wedgeRestartChecks,
      queue: this.opts.queue,
    });
    try {
      await cs.restartCurrentChild(WEDGE_RESTART_GRACE_MS);
    } finally {
      this.escalationInFlight = false;
    }
  }
}
