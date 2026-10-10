/**
 * #6317 (C1): the ordinary pool's real numbers, read from the vendored
 * driver's own queues (`sql.pool`, a GBrain addition to postgres.js: the
 * `open`, `busy`, `full`, `reserved`, `connecting` connection queues and the
 * queries waiting for any connection). This is the figure `pool-gauge.ts`
 * refuses to invent: a connection is checked out when it is executing
 * (`busy`, `full`), owned by a reservation or transaction (`reserved`) or
 * being opened for a waiting query (`connecting`); `waiters` is the driver's
 * query queue, which a transaction-mode pooler cannot see. Every reader
 * duck-types the engine and gets null when the engine is not Postgres or the
 * driver predates the accessor, never a guess.
 */

export interface DriverPoolStats {
  checked_out: number;
  max: number;
  waiters: number;
  /** #6383: age of the oldest statement still waiting for the server, 0 when nothing is in flight. */
  inflight_oldest_ms: number;
  /** #6383: statements the pool has settled since it opened; a pool that is checked out but never advances this is stalled. */
  completed: number;
}

interface DriverQueues { max: number; open: number; busy: number; full: number; reserved: number; connecting: number; closed: number; ended: number; queued: number; inflight_oldest_ms?: number; completed?: number }

/** The pool numbers of one driver instance, or null when it exposes none. */
export function driverPoolStats(sql: unknown): DriverPoolStats | null {
  const pool = (sql as { pool?: DriverQueues } | null)?.pool;
  if (!pool || typeof pool.max !== 'number') return null;
  return {
    checked_out: pool.busy + pool.full + pool.reserved + pool.connecting,
    max: pool.max,
    waiters: pool.queued,
    inflight_oldest_ms: pool.inflight_oldest_ms ?? 0,
    completed: pool.completed ?? 0,
  };
}

/** The ordinary pool of an engine that reports one (`getPoolDiagnostics().pool`), else null. */
export function enginePoolStats(engine: unknown): DriverPoolStats | null {
  try {
    const diagnostics = (engine as { getPoolDiagnostics?: () => { pool?: DriverPoolStats | null } | null } | null)?.getPoolDiagnostics?.();
    return diagnostics?.pool ?? null;
  } catch {
    return null;
  }
}

/** #6383: the ordinary pool's numbers plus the engine's incident counters, the block `/health?deep=1` and the stall watch report. */
export interface PoolHealthSnapshot extends DriverPoolStats {
  poisoned_discards: number;
  stuck_discards: number;
  build_failures: number;
}

export function poolHealthSnapshot(engine: unknown): PoolHealthSnapshot | null {
  try {
    const diagnostics = (engine as { getPoolDiagnostics?: () => { pool?: DriverPoolStats | null; poisonedDiscards?: number; stuckDiscards?: number; buildFailures?: number } | null } | null)?.getPoolDiagnostics?.();
    if (!diagnostics?.pool) return null;
    return {
      ...diagnostics.pool,
      poisoned_discards: diagnostics.poisonedDiscards ?? 0,
      stuck_discards: diagnostics.stuckDiscards ?? 0,
      build_failures: diagnostics.buildFailures ?? 0,
    };
  } catch {
    return null;
  }
}
