/**
 * Fail-open BudgetTracker recording for gateway spend sites. No tracker is a
 * no-op; a BudgetExhausted from `record()` (TX1) is swallowed — the breach
 * surfaces on the NEXT `reserve()`, and the call's own result or error wins.
 */

import { numericStatusOf, wrappedErrorLayers } from './errors.ts';
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

type Tokens = { inputTokens: number; outputTokens: number };

/** The usage any layer of a thrown error reports (its wrappers opened: `cause`, a retry wrapper's `lastError`), or null. */
function chainUsage(err: unknown): ReturnType<typeof usageFromError> {
  for (const layer of wrappedErrorLayers(err)) {
    const found = usageFromError(layer);
    if (found) return found;
  }
  return null;
}

/**
 * PR 4 (Wave B incremental derivation, transcripts): what one provider attempt may have billed. Its reported usage
 * (read through its wrappers), topped up with the fallback for a side it did not report; nothing only when the
 * provider definitively refused it before generating: a 4xx other than 408 Request Timeout or 499 (a proxy's client
 * closed request) on the attempt itself, with no usage. Everything else, a 5xx, a 529, a 504 from a proxy, a timeout,
 * an abort, a reset connection, may have been billed and books the fallback (the attempt's worst case).
 */
function attemptBilled(attempt: unknown, fallback: Tokens): Tokens {
  const found = chainUsage(attempt);
  if (found) return { inputTokens: found.inputTokens ?? fallback.inputTokens, outputTokens: found.outputTokens ?? fallback.outputTokens };
  const status = numericStatusOf(attempt);
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 499) return { inputTokens: 0, outputTokens: 0 };
  return fallback;
}

/**
 * Usage fields for a failed call: what the SDK error reports (any layer), else the
 * pessimistic fallback (A3 amended) flagged `estimated`. `billed`: what the
 * provider may have billed across the call's attempts, each classified on its
 * own (attemptBilled): every entry of a retry wrapper (the AI SDK's RetryError
 * keeps them on `errors`), else the error itself.
 */
export function failedCallUsage(
  err: unknown,
  fallback: Tokens,
): Tokens & { failed: true; estimated: boolean; billed: Tokens } {
  const found = chainUsage(err);
  let attempts: unknown[] = [err];
  for (const layer of wrappedErrorLayers(err)) {
    if (Array.isArray(layer.errors) && layer.errors.length) { attempts = layer.errors; break; }
  }
  const billed = attempts.map(attempt => attemptBilled(attempt, fallback))
    .reduce((sum, t) => ({ inputTokens: sum.inputTokens + t.inputTokens, outputTokens: sum.outputTokens + t.outputTokens }), { inputTokens: 0, outputTokens: 0 });
  return {
    inputTokens: found?.inputTokens ?? fallback.inputTokens,
    outputTokens: found?.outputTokens ?? fallback.outputTokens,
    failed: true,
    estimated: found?.inputTokens == null || found?.outputTokens == null,
    billed,
  };
}
