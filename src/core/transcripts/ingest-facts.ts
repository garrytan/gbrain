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
import { BudgetTracker } from '../budget/budget-tracker.ts';
import { withBudgetTracker } from '../ai/gateway.ts';
import {
  DEFAULT_MAX_COST_USD,
  runExtractConversationFactsCore,
} from '../../commands/extract-conversation-facts.ts';

export interface IngestFactsResult {
  pages: number;
  spentUsd?: number;
  skippedDisabled?: boolean;
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
    return { pages: 0, skippedDisabled: true };
  }

  const tracker = new BudgetTracker({
    maxCostUsd: opts.maxCostUsd ?? DEFAULT_MAX_COST_USD,
    label: 'transcripts-ingest-facts',
  });
  await withBudgetTracker(tracker, () =>
    runExtractConversationFactsCore(engine, {
      sourceId: opts.sourceId,
      slugs: opts.slugs,
      budgetTracker: tracker,
    }),
  );
  return { pages: opts.slugs.length, spentUsd: tracker.totalSpent };
}
