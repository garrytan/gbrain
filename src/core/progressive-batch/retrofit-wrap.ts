/**
 * v0.41.16.0 — Retrofit wrap helper for behavior-parity migrations.
 *
 * Per D21 + D26: existing batch sites that need only the primitive's
 * audit + cost-cap gating (NOT its ramp + verification) get a thin
 * wrapper. The wrapper:
 *   - Buffers items into the work list (one-time read).
 *   - Wraps the per-item callable in NoopVerifier + interactiveAbortMs=0
 *     + opt-out safety net (existing sites that previously had no
 *     ramp + no budget gate keep that behavior; the primitive's audit
 *     JSONL + cost projection is the value-add).
 *   - Surfaces aborts via stderr but doesn't change the caller's
 *     return shape.
 *
 * For sites that NEED ramp (the markdown reindex flow via
 * post-upgrade-reembed), callers opt INTO interactive abort via the
 * primitive's `interactiveAbortMs` Policy field or the
 * `GBRAIN_PROGRESSIVE_BATCH_STAGES` env var.
 *
 * Hermetic: pure orchestration. No I/O of its own.
 */

import {
  runProgressiveBatch,
  type NoopVerifier,
  type Policy,
  type ProgressiveBatchResult,
  type StageRunner,
} from './orchestrator.ts';

export interface RetrofitWrapOpts<T> {
  /** Display label for audit JSONL + stderr stage report. */
  label: string;
  /** The full work list. */
  items: T[];
  /** Per-item conservative cost projection (USD). 0 = no LLM/embed cost. */
  costPerItem?: number;
  /** Per-batch runner. Returns {succeeded, failed, costUsd} for this slice. */
  runner: StageRunner<T>;
  /**
   * D21: behavior parity. When the existing site previously had no
   * Ctrl-C grace AND no budget gating, default to opt-out. Operators
   * opt INTO ramp via `GBRAIN_PROGRESSIVE_BATCH_STAGES` env var.
   */
  interactiveAbortMs?: number;
  /**
   * D3: when the existing site previously had its own BudgetTracker
   * (e.g. brainstorm/orchestrator, reindex-code with --max-cost), it
   * still owns the tracker; primitive observes via getCurrentBudgetTracker.
   * When the site never had cost gating, default opt-out so the
   * primitive doesn't refuse to start.
   */
  requireBudgetSafetyNet?: boolean;
}

/**
 * Thin retrofit wrapper. Use for any existing batch site that doesn't
 * need ramp + verification (just wants the primitive's audit JSONL +
 * cost projection).
 *
 * Returns the primitive's full result so callers can read
 * `result.abortedAt` and `result.stageReports` if they need to. Most
 * callers ignore the return.
 */
export async function retrofitWrap<T>(
  opts: RetrofitWrapOpts<T>,
): Promise<ProgressiveBatchResult> {
  const verifier: NoopVerifier = {
    kind: 'noop',
    costPerItem: () => opts.costPerItem ?? 0,
  };
  const policy: Policy = {
    label: opts.label,
    interactiveAbortMs: opts.interactiveAbortMs ?? 0,
    requireBudgetSafetyNet: opts.requireBudgetSafetyNet ?? false,
  };
  return runProgressiveBatch(opts.items, verifier, policy, opts.runner);
}
