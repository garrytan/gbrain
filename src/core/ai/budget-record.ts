/**
 * Fail-open BudgetTracker recording for gateway spend sites. No tracker is a
 * no-op; a BudgetExhausted from `record()` (TX1) is swallowed — the breach
 * surfaces on the NEXT `reserve()`, and the call's own result or error wins.
 */

import {
  usageFromError,
  type BudgetActualUsage,
  type BudgetKind,
  type BudgetTracker,
} from '../budget/budget-tracker.ts';

export function recordOnTracker(tracker: BudgetTracker | null, actual: BudgetActualUsage & { kind?: BudgetKind }): void {
  if (!tracker) return;
  try {
    tracker.record(actual);
  } catch {
    // BudgetExhausted (TX1) — surfaced via the next reserve().
  }
}

/**
 * Usage fields for a failed call: what the SDK error reports, else the
 * pessimistic fallback (A3 amended) flagged `estimated`.
 */
export function failedCallUsage(
  err: unknown,
  fallback: { inputTokens: number; outputTokens: number },
): { inputTokens: number; outputTokens: number; failed: true; estimated: boolean } {
  const found = usageFromError(err);
  return {
    inputTokens: found?.inputTokens ?? fallback.inputTokens,
    outputTokens: found?.outputTokens ?? fallback.outputTokens,
    failed: true,
    estimated: found?.inputTokens == null || found?.outputTokens == null,
  };
}
