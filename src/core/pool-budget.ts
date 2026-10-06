/** Budgets follow physical postgres.js pools, including inherited/shared pools. */
export interface BudgetPool { options?: { max?: number } }
interface Budget { held: number }
const budgets = new WeakMap<object, Budget>();
export class PoolCapacityError extends Error {
  readonly code = 'writer_pool_capacity';
  constructor() { super('No pool capacity is available for long-running writes. Configure at least two ordinary connections; one connection is reserved for reads and control work.'); }
}
/**
 * Long holds leave one connection free for reads and control work (heartbeats, claims, lock renewal).
 * `selfContained` holders use only the reserved connection and never wait on the pool while holding,
 * like a transaction, so they may take the only connection of a single-connection pool.
 */
export interface LongHoldOptions { selfContained?: boolean }
export function poolLongHoldCapacity(pool: BudgetPool, fallback?: number, opts?: LongHoldOptions): number {
  const max = fallback === undefined ? pool.options?.max ?? 10 : Math.min(pool.options?.max ?? fallback, fallback);
  if (!Number.isSafeInteger(max) || max < 1) return 0;
  return max > 1 ? max - 1 : opts?.selfContained ? 1 : 0;
}
export function tryAcquirePoolLongHold(pool: BudgetPool, fallback?: number, opts?: LongHoldOptions): (() => void) | null {
  let budget = budgets.get(pool);
  if (!budget) { budget = { held: 0 }; budgets.set(pool, budget); }
  if (budget.held >= poolLongHoldCapacity(pool, fallback, opts)) return null;
  budget.held++;
  let released = false;
  return () => { if (!released) { released = true; budget!.held--; } };
}
