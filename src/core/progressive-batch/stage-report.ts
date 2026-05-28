/**
 * v0.41.16.0 — Stage report formatter.
 *
 * Pure formatter for human + JSON stage reports. The orchestrator
 * invokes this from its default `Policy.onStageReport` handler when
 * the caller doesn't override.
 *
 * ASCII-only per the storage.ts D10 precedent (operator-friendly
 * across every terminal). One report per stage, written to stderr.
 */

import type { StageReport } from './types.ts';

/**
 * Pure ASCII single-line report for a stage. Suitable for stderr.
 *
 *   [progressive-batch label=foo op=ab12 stage=trial verdict=proceed
 *    items=10/250 err=0.0% cost=$0.0042 proj=$0.105 dt=453ms]
 */
export function formatStageLine(r: StageReport): string {
  const parts: string[] = [
    `label=${r.label}`,
    `op=${r.operationId.slice(0, 8)}`,
    `stage=${r.stage}`,
    `verdict=${r.verdict}`,
    `items=${r.itemsProcessedCumulative}/${r.totalItems}`,
    `err=${(r.errorRate * 100).toFixed(1)}%`,
    `cost=$${r.costEstimateRunningUsd.toFixed(4)}`,
    `proj=$${r.costProjectedFullUsd.toFixed(4)}`,
    `dt=${r.stageMs}ms`,
  ];
  if (r.deltaObserved !== undefined) {
    parts.push(
      `delta=${r.deltaObserved}/${r.deltaExpected ?? 'n/a'}`,
    );
  }
  if (r.abortReason) parts.push(`reason=${r.abortReason}`);
  if (r.qualityReasons && r.qualityReasons.length > 0) {
    parts.push(`quality_issues=${r.qualityReasons.length}`);
  }
  return `[progressive-batch ${parts.join(' ')}]`;
}

/**
 * Default stderr writer. Caller overrides via Policy.onStageReport.
 */
export function defaultStageReport(r: StageReport): void {
  // We want this on stderr so stdout JSON envelopes from the caller
  // (e.g. `gbrain reindex --json`) stay clean.
  process.stderr.write(formatStageLine(r) + '\n');
}

