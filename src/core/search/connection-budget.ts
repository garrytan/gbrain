/**
 * Per-search connection budget (GBRA-156). One search or query op starts its
 * independent reads together to save round trips; this caps how many pooled
 * connections those reads hold at once, so a burst of searches shares the
 * read pool instead of each one taking it whole.
 *
 * The engine's two connection seams (PostgresEngine#transactionOn for a
 * top-level transaction, runUnsafe for a statement) wait for a slot inside a
 * budget scope and hold it until the statement or the transaction's COMMIT
 * settles. Work inside a held slot runs outside the scope, so statements on
 * the transaction's own connection never wait on a second slot. Outside a
 * scope, and on PGLite, nothing changes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { throwIfRequestAborted } from '../request-signal.ts';

/** The most pooled connections one search or query op holds at once. */
export const SEARCH_CONNECTION_LIMIT = 4;

interface Budget { free: number; waiters: Array<() => void>; urgent: Array<() => void> }
const budgets = new AsyncLocalStorage<Budget | null>();
const urgency = new AsyncLocalStorage<boolean>();

/** Run `fn` under one budget; a nested call shares the enclosing one. */
export function withSearchConnectionBudget<T>(fn: () => Promise<T>): Promise<T> {
  if (budgets.getStore()) return fn();
  return budgets.run({ free: SEARCH_CONNECTION_LIMIT, waiters: [], urgent: [] }, fn);
}

/**
 * GBRA-156: reads `fn` starts take the next free slot ahead of every waiting read started outside one. The
 * retrieval arms (keyword, title, vector) set the search's critical path; the reads a search starts early for its
 * response (the keyword count, entity resolution) only need to finish before the response is built.
 */
export function withUrgentSearchConnections<T>(fn: () => Promise<T>): Promise<T> {
  return urgency.run(true, fn);
}

/** Hold one slot of the current budget while `fn` runs; without a budget, run it directly. */
export async function holdSearchConnection<T>(fn: () => Promise<T>): Promise<T> {
  const budget = budgets.getStore();
  if (!budget) return fn();
  if (budget.free > 0) budget.free -= 1;
  else await new Promise<void>(resolve => (urgency.getStore() ? budget.urgent : budget.waiters).push(resolve));
  try {
    throwIfRequestAborted();
    return await budgets.run(null, fn);
  } finally {
    const next = budget.urgent.shift() ?? budget.waiters.shift();
    if (next) next(); else budget.free += 1;
  }
}
