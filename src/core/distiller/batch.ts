/**
 * distiller/batch.ts — run the distiller over many records at once.
 *
 * Ties the extractor to the decider: BrainRecords → candidate topics
 * (extract.ts) → one decision pass per topic (run.ts) → aggregated reports +
 * a summary. Pure with injected seams (same `DistillerDeps` as run.ts), so it
 * runs keyless and testable. Returns plans, never side effects.
 */

import type { BrainRecord } from './extract.ts';
import { extractTopics, type ExtractOptions } from './extract.ts';
import { runDistiller, type DistillerDeps } from './run.ts';
import type { DistillDecision, DistillReport } from './types.ts';

export interface BatchSummary {
  records_in: number;
  /** Records dropped for lacking a healthcare role (APPI audit). */
  dropped_non_clinical: number;
  topics: number;
  /** Count of topics per decision branch. */
  by_decision: Record<DistillDecision, number>;
}

export interface BatchResult {
  summary: BatchSummary;
  reports: DistillReport[];
}

export interface BatchOptions {
  /** Passed through to the topic extractor (summary cap, trigger cap). */
  extract?: ExtractOptions;
}

/**
 * Extract topics from `records`, run the decider on each, and aggregate.
 * Topics are processed in the extractor's deterministic order.
 */
export async function runDistillerBatch(
  records: BrainRecord[],
  deps: DistillerDeps,
  opts: BatchOptions = {},
): Promise<BatchResult> {
  const { topics, droppedNonClinical } = extractTopics(records, opts.extract);

  const reports: DistillReport[] = [];
  for (const topic of topics) {
    reports.push(await runDistiller(topic, deps));
  }

  const by_decision: Record<DistillDecision, number> = {
    none: 0,
    exact_match: 0,
    update: 0,
    split: 0,
  };
  for (const r of reports) by_decision[r.decision]++;

  return {
    summary: {
      records_in: records.length,
      dropped_non_clinical: droppedNonClinical,
      topics: topics.length,
      by_decision,
    },
    reports,
  };
}
