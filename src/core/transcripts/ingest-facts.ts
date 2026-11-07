/**
 * ingest-facts.ts — the `--facts` lane of transcripts ingest (cathedral-4).
 *
 * ONE `runExtractConversationFactsCore` invocation per run (the batch
 * `slugs` selector), wrapped in ONE `withBudgetTracker` — passing a tracker
 * via opts alone is not accounting (the gateway reads AsyncLocalStorage),
 * and per-slug core invocations multiply config resolution, checkpoint IO,
 * and receipt writes by page count.
 *
 * Targets EVERY slug the ingest touched, INCLUDING hash-skipped pages (an
 * earlier no-facts import then a re-run with the facts flag must still
 * extract); the extractor's durable-outcome/version-token gate dedupes the
 * already-extracted ones. Respects the brain-wide `facts.extraction_enabled`
 * kill-switch with a notice, never a throw (the core throws on disabled; the
 * pre-check is the sweep pattern).
 */

import type { BrainEngine } from '../engine.ts';
import { isFactsExtractionEnabled } from '../facts/extract.ts';
import { BudgetTracker, loadPricingOverrides, type BudgetReason } from '../budget/budget-tracker.ts';
import { withBudgetTracker } from '../ai/gateway.ts';
import { conversationFactsCostCap } from '../facts/conversation-budget.ts';
import {
  DEFAULT_MAX_COST_USD,
  runExtractConversationFactsCore,
} from '../../commands/extract-conversation-facts.ts';

export interface IngestFactsResult {
  pages: number;
  pagesFailed: number;
  spentUsd?: number;
  skippedDisabled?: boolean;
  /** True when the pass reached its budget (cap or missing price). Pages may remain unextracted; a final-call overage can also set it after the last page succeeded. */
  budget_exhausted?: boolean;
  /** Why the budget halted the pass (`cost`, `runtime` or `no_pricing`). Absent when it did not halt. */
  budget_reason?: BudgetReason;
  /** Pages skipped because a window batch would pass the request limit. */
  pages_skipped_too_large?: number;
  /** Pages skipped because another run still holds their lease. */
  pages_lock_skipped?: number;
}

export async function runIngestFacts(
  engine: BrainEngine,
  opts: { sourceId: string; slugs: string[]; maxCostUsd?: number; quiet?: boolean },
): Promise<IngestFactsResult> {
  if (!(await isFactsExtractionEnabled(engine))) {
    if (!opts.quiet) {
      console.error(
        'transcripts ingest: facts extraction is disabled brain-wide ' +
          '(facts.extraction_enabled=false) — pages imported, facts skipped',
      );
    }
    return { pages: 0, pagesFailed: 0, skippedDisabled: true };
  }

  const pricingOverrides = await loadPricingOverrides(engine);
  const tracker = new BudgetTracker({
    maxCostUsd: await conversationFactsCostCap(engine, opts.maxCostUsd ?? DEFAULT_MAX_COST_USD, opts.maxCostUsd !== undefined, pricingOverrides),
    label: 'transcripts-ingest-facts',
    pricingOverrides,
  });
  const result = await withBudgetTracker(tracker, () =>
    runExtractConversationFactsCore(engine, {
      sourceId: opts.sourceId,
      slugs: opts.slugs,
      budgetTracker: tracker,
    }),
  );
  return {
    pages: opts.slugs.length,
    pagesFailed: result.pages_failed,
    spentUsd: tracker.totalSpent,
    budget_exhausted: result.budget_exhausted === true,
    ...(result.budget_reason ? { budget_reason: result.budget_reason } : {}),
    pages_skipped_too_large: result.pages_skipped_too_large,
    pages_lock_skipped: result.pages_lock_skipped,
  };
}
