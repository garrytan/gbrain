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
}

interface DriverQueues { max: number; open: number; busy: number; full: number; reserved: number; connecting: number; closed: number; ended: number; queued: number }

/** The pool numbers of one driver instance, or null when it exposes none. */
export function driverPoolStats(sql: unknown): DriverPoolStats | null {
  const pool = (sql as { pool?: DriverQueues } | null)?.pool;
  if (!pool || typeof pool.max !== 'number') return null;
  return { checked_out: pool.busy + pool.full + pool.reserved + pool.connecting, max: pool.max, waiters: pool.queued };
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
