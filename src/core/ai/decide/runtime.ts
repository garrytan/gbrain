/**
 * decide runtime safety: the per-query decide budget and detached shadow work.
 *
 * Query budget: decide.query_budget_ms bounds the latency decide work ADDS to
 * one `query` request (the S2 wait, S1 rerank, the S3/S5 and S4 stage); later
 * stages get the remainder and skip with `late`. Retrieval and expansion time
 * between request start and the first post-retrieval stage is not decide time:
 * `anchor()` restarts the clock there, minus what S2's wait already blocked
 * (`charge()`). `think` gets the same budget per call and anchors after gather.
 *
 * Shadow isolation: detached shadow work runs in its own budget scope (a
 * dedicated BudgetTracker, not the ambient request tracker), behind a bounded
 * in-flight queue, and registers with the background-work drain so the CLI's
 * bounded teardown awaits it. Coordination is per process.
 */
import { BudgetTracker } from '../../budget/budget-tracker.ts';
import { registerBackgroundWorkDrainer } from '../../background-work.ts';
import { withBudgetTracker } from '../gateway.ts';

/** Stages below this remainder skip with `late` rather than start a call that cannot finish. */
export const MIN_STAGE_MS = 50;

export interface DecideQueryBudget {
  deadlineAt: number;
  remaining(now?: number): number;
  /** Record time a decide stage blocked the request before `anchor()`. */
  charge(ms: number): void;
  /** Start the post-retrieval clock once: the deadline becomes now + budget - charged. */
  anchor(now?: number): void;
}

export function createQueryBudget(budgetMs: number, now = Date.now()): DecideQueryBudget {
  let charged = 0;
  let anchored = false;
  const budget: DecideQueryBudget = {
    deadlineAt: now + budgetMs,
    remaining: (t = Date.now()) => Math.max(0, budget.deadlineAt - t),
    charge: (ms) => { if (!anchored) charged += Math.max(0, ms); },
    anchor: (t = Date.now()) => {
      if (anchored) return;
      anchored = true;
      budget.deadlineAt = t + Math.max(0, budgetMs - charged);
    },
  };
  return budget;
}

/** The deadline one stage may use: its own timeout capped by what the query budget has left, or null (`late`). */
export function stageDeadlineMs(budget: DecideQueryBudget | undefined, stageTimeoutMs: number, now = Date.now()): number | null {
  const left = budget ? budget.remaining(now) : stageTimeoutMs;
  const ms = Math.min(stageTimeoutMs, left);
  return ms < MIN_STAGE_MS ? null : ms;
}

const MAX_SHADOW_IN_FLIGHT = 8;
const inFlight = new Set<Promise<unknown>>();

/** Deterministic-enough sampling; tests pass `random`. */
export function sampled(rate: number, random: () => number = Math.random): boolean {
  return rate >= 1 || (rate > 0 && random() < rate);
}

/**
 * Start detached shadow work. Returns false (and runs nothing) when the
 * bounded queue is full. The work runs under its own BudgetTracker so a
 * foreground call near its cap is never charged for shadow spend.
 */
export function runShadow(fn: () => Promise<void>): boolean {
  if (inFlight.size >= MAX_SHADOW_IN_FLIGHT) return false;
  const tracker = new BudgetTracker({ label: 'decide.shadow' });
  const p = withBudgetTracker(tracker, fn).catch(() => { /* shadow never surfaces errors */ });
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return true;
}

export function shadowInFlight(): number {
  return inFlight.size;
}

export async function drainShadow(timeoutMs: number): Promise<{ unfinished: number }> {
  if (inFlight.size === 0) return { unfinished: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); timer.unref?.(); });
  try {
    const r = await Promise.race([Promise.allSettled([...inFlight]).then(() => 'done' as const), bound]);
    return r === 'timeout' ? { unfinished: inFlight.size } : { unfinished: 0 };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Shadow work drains before the receipts sink (order 6) so its receipts are buffered in time.
registerBackgroundWorkDrainer({ name: 'decide-shadow', order: 5.5, drain: (timeoutMs) => drainShadow(Math.min(timeoutMs, 1000)) });
