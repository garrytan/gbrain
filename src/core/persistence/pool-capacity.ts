import type { BrainEngine } from '../engine.ts';
import { poolLongHoldCapacity, tryAcquirePoolLongHold, type BudgetPool } from '../pool-budget.ts';

const embedded = new WeakSet<BrainEngine>();
const publishing = new WeakMap<object, number>();
function ordinaryPool(engine: BrainEngine): BudgetPool {
  return (engine as BrainEngine & { sql: BudgetPool }).sql;
}
export function publicationConcurrency(engine: BrainEngine): number {
  return engine.kind === 'pglite' ? 1 : Math.min(2, poolLongHoldCapacity(ordinaryPool(engine)));
}
/** Acquire before checking out a connection; there is no asynchronous wait here. */
export function tryAcquirePublicationCapacity(engine: BrainEngine): (() => void) | null {
  if (engine.kind === 'postgres') {
    const pool = ordinaryPool(engine);
    const count = publishing.get(pool) ?? 0;
    if (count >= publicationConcurrency(engine)) return null;
    const release = tryAcquirePoolLongHold(pool);
    if (!release) return null;
    publishing.set(pool, count + 1);
    let released = false;
    return () => { if (!released) { released = true; publishing.set(pool, (publishing.get(pool) ?? 1) - 1); release(); } };
  }
  if (embedded.has(engine)) return null;
  embedded.add(engine);
  let released = false;
  return () => { if (!released) { released = true; embedded.delete(engine); } };
}
