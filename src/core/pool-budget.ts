/** Budgets follow physical postgres.js pools, including inherited/shared pools. */
export interface BudgetPool { options?: { max?: number } }
interface Budget { held: number }
const budgets = new WeakMap<object, Budget>();
export class PoolCapacityError extends Error {
  readonly code = 'writer_pool_capacity';
  constructor() { super('No pool capacity is available for long-running writes. Configure at least two ordinary connections; one connection is reserved for reads and control work.'); }
}
export function poolLongHoldCapacity(pool: BudgetPool, fallback?: number): number {
  const max = fallback === undefined ? pool.options?.max ?? 10 : Math.min(pool.options?.max ?? fallback, fallback);
  return Number.isSafeInteger(max) && max > 1 ? max - 1 : 0;
}
export function tryAcquirePoolLongHold(pool: BudgetPool, fallback?: number): (() => void) | null {
  let budget = budgets.get(pool);
  if (!budget) { budget = { held: 0 }; budgets.set(pool, budget); }
  if (budget.held >= poolLongHoldCapacity(pool, fallback)) return null;
  budget.held++;
  let released = false;
  return () => { if (!released) { released = true; budget!.held--; } };
}
