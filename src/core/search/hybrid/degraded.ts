/** Degradation-stamp helpers shared by hybridSearch, its stages and hybridSearchCached. */
import type { DegradedStage, DegradedStageEntry, DegradedReason } from '../../types.ts';
import type { TokenBudgetMeta } from '../token-budget.ts';

/**
 * WP2/T3 — classify an embed/vector failure as a timeout vs a provider
 * error for the enumerated degraded[] reason codes (D6). Matches both the
 * embedQueryBounded deadline rejection and AbortSignal.timeout's
 * TimeoutError/AbortError. The raw error text never rides the wire — it
 * goes to stderr via warnOncePerProcess only.
 */
export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/deadline \d+ms exceeded/.test(err.message)) return true;
  return err.name === 'TimeoutError' || err.name === 'AbortError';
}

/** WP2/T3 — append a degraded stage once (stages are set-like per response). */
export function pushDegraded(
  list: DegradedStageEntry[],
  stage: DegradedStage,
  reason?: DegradedReason,
): void {
  if (list.some((d) => d.stage === stage)) return;
  list.push(reason ? { stage, reason } : { stage });
}

/**
 * WP2/T3 — budget-stage stamp shared by the enforceTokenBudget call sites.
 * Two distinct stages so consumers can tell "empty" from "clipped":
 * budget_truncated when the minKeep failsafe kept one truncated copy
 * (results non-empty); budget_dropped_all when the strict packer returned
 * [] (kept 0 with drops, under GBRAIN_SEARCH_SALVAGE=off).
 */
export function stampBudgetStage(list: DegradedStageEntry[], meta: TokenBudgetMeta): void {
  if (meta.truncated) pushDegraded(list, 'budget_truncated', 'first_result_truncated');
  else if (meta.kept === 0 && meta.dropped > 0) pushDegraded(list, 'budget_dropped_all');
}
