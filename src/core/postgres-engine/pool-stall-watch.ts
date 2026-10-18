/**
 * #6383: the pool stall line. A resident process (serve) ticks this every
 * 30 s; when the pool has connections checked out or statements waiting for
 * one and the driver settled nothing for two ticks in a row, one fixed-shape
 * warn line per tick names the numbers, and one info line marks the recovery. With the
 * in-flight watchdog on, a stall lasts at most one `statement_timeout + grace`
 * budget; with it off (`GBRAIN_PG_STUCK_GRACE_MS=off`) this line is the only
 * trace a wedged pool leaves, instead of fifty silent minutes.
 */
import { poolHealthSnapshot, type PoolHealthSnapshot } from './pool-stats.ts';

export const POOL_STALL_TICK_MS = 30_000;

export function formatPoolStalledWarning(pool: PoolHealthSnapshot, sinceMs: number): string {
  return `[gbrain] warn code=pg_pool_stalled checked_out=${pool.checked_out} max=${pool.max} waiters=${pool.waiters}` +
    ` inflight_oldest_ms=${pool.inflight_oldest_ms} completed_delta=0 stalled_ms=${Math.max(0, Math.round(sinceMs))}` +
    ` cause="connections are checked out but no statement has completed since the last tick"` +
    ` fix="gbrain doctor --json" docs=docs/ENGINES.md#pg-pool-stalled`;
}

export function formatPoolRecoveredInfo(stalledMs: number, completedDelta: number): string {
  return `[gbrain] info code=pg_pool_recovered stalled_ms=${Math.max(0, Math.round(stalledMs))} completed_delta=${completedDelta}`;
}

export class PoolStallWatch {
  private lastCompleted: number | null = null;
  private stalledSince: number | null = null;
  private quietTicks = 0;
  private intervalMs = POOL_STALL_TICK_MS;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly engine: unknown,
    private readonly log: (line: string) => void = (line) => console.warn(line),
    private readonly now: () => number = Date.now,
  ) {}

  /** One observation; returns what it logged, if anything. Exposed for tests; `start` drives it on a timer. */
  tick(): 'stalled' | 'recovered' | null {
    const pool = poolHealthSnapshot(this.engine);
    if (!pool) return null;
    const previous = this.lastCompleted;
    this.lastCompleted = pool.completed;
    if (previous === null) return null;
    const busy = pool.checked_out > 0 || pool.waiters > 0;
    const advanced = pool.completed !== previous;
    if (busy && !advanced) {
      // The first quiet tick is one slow statement; the line starts on the second, 60 s without a round trip.
      if (this.quietTicks++ === 0) return null;
      this.stalledSince ??= this.now() - 2 * this.intervalMs;
      this.log(formatPoolStalledWarning(pool, this.now() - this.stalledSince));
      return 'stalled';
    }
    this.quietTicks = 0;
    if (this.stalledSince !== null) {
      const since = this.stalledSince;
      this.stalledSince = null;
      this.log(formatPoolRecoveredInfo(this.now() - since, pool.completed - previous));
      return 'recovered';
    }
    return null;
  }

  start(intervalMs: number = POOL_STALL_TICK_MS): this {
    if (this.timer) return this;
    this.intervalMs = intervalMs;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* diagnostic only */ } }, intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
