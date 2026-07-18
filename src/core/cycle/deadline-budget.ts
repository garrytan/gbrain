/**
 * #2781 — shared deadline-budget helpers for cycle phases that spawn
 * subagent children (patterns, synthesize).
 *
 * The enclosing minion job carries an absolute deadline
 * (`MinionJobContext.deadlineAtMs`, from the claim-time `timeout_at`
 * stamp). Phases clamp their child-job timeouts and wait timeouts to the
 * REMAINING time so one phase's fixed worst-case can't blow past the job
 * budget and dead-letter the whole cycle mid-phase.
 *
 * Lives in its own module because patterns.ts imports from synthesize.ts
 * (allow-list helpers) — synthesize importing these back from patterns
 * would create an import cycle.
 */

/**
 * Stop-margin reserved under the parent deadline when clamping subagent
 * budgets. NOT a promise that tail phases complete — the cycle is allowed
 * to go partial and resume next tick. This only guarantees the phase's
 * wait returns and the handler unwinds cleanly before the worker's abort
 * fires: wait poll interval (5s) + worker force-evict grace (30s) + lock
 * and DB cleanup headroom.
 */
export const CYCLE_DEADLINE_RESERVE_MS = 60 * 1000;

/**
 * Smallest remaining budget worth submitting a subagent for. Below this,
 * the LLM call is near-certain to be killed mid-flight — wasted spend and
 * a guaranteed-timeout child — so the phase skips honestly instead
 * (`insufficient_cycle_budget`) and the next cycle retries with a fresh
 * budget.
 */
export const MIN_SUBAGENT_START_BUDGET_MS = 2 * 60 * 1000;

/**
 * Remaining child budget under the parent deadline, or null when the
 * caller has no deadline (direct `gbrain dream`). May be <= 0 when the
 * reserve is already breached — callers treat that as "no budget left".
 */
export function remainingChildBudgetMs(
  deadlineAtMs: number | null | undefined,
  nowMs: number,
): number | null {
  if (deadlineAtMs == null) return null;
  return deadlineAtMs - CYCLE_DEADLINE_RESERVE_MS - nowMs;
}

/**
 * Clamp the configured subagent budgets to the remaining parent-job time.
 * Both timeouts derive from the SAME absolute child deadline
 * (`deadlineAtMs - reserve`) so the child job's kill switch and our wait
 * agree. Returns null when the remaining budget is below the minimum —
 * caller should skip the phase without submitting.
 */
export function clampSubagentBudgets(
  config: { subagentTimeoutMs: number; subagentWaitTimeoutMs: number },
  deadlineAtMs: number | null | undefined,
  nowMs: number,
): { timeoutMs: number; waitTimeoutMs: number } | null {
  const childBudgetMs = remainingChildBudgetMs(deadlineAtMs, nowMs);
  if (childBudgetMs === null) {
    return { timeoutMs: config.subagentTimeoutMs, waitTimeoutMs: config.subagentWaitTimeoutMs };
  }
  if (childBudgetMs < MIN_SUBAGENT_START_BUDGET_MS) return null;
  return {
    timeoutMs: Math.min(config.subagentTimeoutMs, childBudgetMs),
    waitTimeoutMs: Math.min(config.subagentWaitTimeoutMs, childBudgetMs),
  };
}
