/**
 * Shared alive-but-wedged worker watchdog.
 *
 * Both the standalone MinionSupervisor and autopilot supervise a
 * ChildWorkerSupervisor. This module owns the queue-progress decision and
 * bounded restart state so the two production paths cannot drift.
 */

import type { BrainEngine } from '../engine.ts';
import type { ChildWorkerSupervisor } from './child-worker-supervisor.ts';

export const DEFAULT_WEDGE_WATCHDOG_OPTIONS = {
  restartMinutes: 15,
  checks: 3,
  loopBudget: 3,
  loopWindowMs: 30 * 60_000,
  startupGraceMs: 120_000,
  healthIntervalMs: 60_000,
  restartGraceMs: 35_000,
} as const;

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

/** Derive the exact names a normal built-in worker can claim. */
export async function deriveClaimableHandlerNames(
  engine: BrainEngine,
  queue: string,
): Promise<string[]> {
  const [{ MinionWorker }, { registerBuiltinHandlers }] = await Promise.all([
    import('./worker.ts'),
    import('../../commands/jobs.ts'),
  ]);
  const probe = new MinionWorker(engine, { queue, healthCheckInterval: 0 });
  await registerBuiltinHandlers(probe, engine, { quiet: true });
  return [...probe.registeredNames];
}

type RestartableChild = Pick<
  ChildWorkerSupervisor,
  'childAlive' | 'inBackoff' | 'restartCurrentChild'
>;

export interface WorkerWedgeWatchdogOpts {
  queue: string;
  restartMinutes: number;
  checks: number;
  loopBudget: number;
  loopWindowMs: number;
  startupGraceMs: number;
  restartGraceMs: number;
  getChild: () => RestartableChild | null;
  isStopping: () => boolean;
  onWarn: (fields: Record<string, unknown>) => void;
  now?: () => number;
}

export class WorkerWedgeWatchdog {
  private readonly opts: WorkerWedgeWatchdogOpts;
  private childStartedAt: number | null = null;
  private consecutiveWedgedChecks = 0;
  private restartTimestamps: number[] = [];
  private loopAlerted = false;
  private escalationInFlight = false;

  constructor(opts: WorkerWedgeWatchdogOpts) {
    this.opts = opts;
  }

  noteWorkerSpawned(at = this.now()): void {
    this.childStartedAt = at;
    this.consecutiveWedgedChecks = 0;
  }

  /** @internal Test seam retained for MinionSupervisor's existing tests. */
  _setChildStartedAtForTests(at: number | null): void {
    this.childStartedAt = at;
  }

  /** @internal */
  get _consecutiveWedgedChecksForTests(): number {
    return this.consecutiveWedgedChecks;
  }

  /** @internal */
  get _restartCountForTests(): number {
    return this.restartTimestamps.length;
  }

  async evaluate(signals: WedgeSignals): Promise<void> {
    const child = this.opts.getChild();
    const workerAlive = child !== null && child.childAlive;
    const inBackoff = child !== null && child.inBackoff;
    const now = this.now();
    const minutesSinceClaimable = signals.lastCompletedClaimable
      ? Math.round((now - signals.lastCompletedClaimable.getTime()) / 60_000)
      : null;
    const childAgeMs = this.childStartedAt !== null ? now - this.childStartedAt : 0;
    const claimableStale =
      minutesSinceClaimable === null || minutesSinceClaimable > this.opts.restartMinutes;
    const wedged =
      this.opts.restartMinutes > 0 &&
      signals.waitingClaimable > 0 &&
      signals.activeHealthy === 0 &&
      claimableStale &&
      workerAlive &&
      !inBackoff &&
      !this.opts.isStopping() &&
      !this.escalationInFlight &&
      childAgeMs > this.opts.startupGraceMs;

    if (!wedged) {
      this.consecutiveWedgedChecks = 0;
      return;
    }

    this.consecutiveWedgedChecks++;
    if (this.consecutiveWedgedChecks < this.opts.checks) return;
    await this.restart(child!, signals.waitingClaimable, minutesSinceClaimable);
  }

  private async restart(
    child: RestartableChild,
    waitingClaimable: number,
    minutesSinceCompletion: number | null,
  ): Promise<void> {
    const now = this.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (t) => t > now - this.opts.loopWindowMs,
    );
    if (this.restartTimestamps.length >= this.opts.loopBudget) {
      if (!this.loopAlerted) {
        this.loopAlerted = true;
        this.opts.onWarn({
          reason: 'wedge_restart_loop',
          count: this.restartTimestamps.length,
          window_ms: this.opts.loopWindowMs,
          waiting_claimable: waitingClaimable,
          queue: this.opts.queue,
        });
      }
      this.consecutiveWedgedChecks = 0;
      return;
    }

    this.loopAlerted = false;
    this.restartTimestamps.push(now);
    this.consecutiveWedgedChecks = 0;
    this.escalationInFlight = true;
    this.opts.onWarn({
      reason: 'restarting_wedged_worker',
      waiting_claimable: waitingClaimable,
      minutes_since_completion: minutesSinceCompletion,
      consecutive_wedged_checks: this.opts.checks,
      queue: this.opts.queue,
    });
    try {
      await child.restartCurrentChild(this.opts.restartGraceMs);
    } finally {
      this.escalationInFlight = false;
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
