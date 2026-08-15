/**
 * v0.41.16.0 — Progressive-batch audit JSONL writer.
 *
 * Wraps the shared `createAuditWriter` primitive (v0.40.4.0) for the
 * progressive-batch trail. ISO-week-rotated at
 * `~/.gbrain/audit/progressive-batch-YYYY-Www.jsonl`. Honors
 * `GBRAIN_AUDIT_DIR` via the shared resolver.
 *
 * Records one event per stage transition (including the final
 * verdict's stage). The doctor check `progressive_batch_audit_health`
 * reads the last 7 days and surfaces operations that aborted with
 * `abort_*` verdicts so operators see what went wrong without grep'ing
 * the JSONL by hand.
 *
 * Best-effort: write failures stderr-warn but never throw. Matches
 * every other audit-writer consumer's posture.
 */

import { createAuditWriter } from '../audit/audit-writer.ts';
import type {
  AbortReason,
  Stage,
  StageVerdict,
} from './types.ts';

/**
 * One event per stage. Schema_version stamped so future renames stay
 * detectable.
 */
export interface ProgressiveBatchAuditEvent {
  ts: string;
  schema_version: 1;
  operation_id: string;
  label: string;
  stage: Stage;
  items_in_stage: number;
  items_processed_cumulative: number;
  total_items: number;
  verdict: StageVerdict;
  abort_reason?: AbortReason;
  error_rate: number;
  cost_running_usd: number;
  cost_projected_full_usd: number;
  delta_observed?: number;
  delta_expected?: number | null;
  stage_ms: number;
  quality_reasons?: string[];
}

const writer = createAuditWriter<ProgressiveBatchAuditEvent>({
  featureName: 'progressive-batch',
  errorLabel: 'progressive-batch-audit',
  errorTrailer: '; run continues',
});

export function logProgressiveBatchEvent(
  event: Omit<ProgressiveBatchAuditEvent, 'ts' | 'schema_version'>,
): void {
  writer.log({ ...event, schema_version: 1 });
}

export function readRecentProgressiveBatchEvents(
  days = 7,
  now?: Date,
): ProgressiveBatchAuditEvent[] {
  return writer.readRecent(days, now);
}

export function computeProgressiveBatchAuditFilename(now?: Date): string {
  return writer.computeFilename(now);
}
