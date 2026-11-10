import type { PhaseResult } from '../cycle.ts';
import { isWriteReceipt } from '../persistence/types.ts';

/** An OK rollup can still contain incomplete items. Require explicit terminal evidence. */
export function extractionCompletedForFidelity(result: PhaseResult): boolean {
  const d = result.details;
  if (result.phase !== 'extract_atoms' || result.status !== 'ok' || !d ||
      d.dry_run !== false || d.budget_exhausted !== false || d.aborted_global_error ||
      !Array.isArray(d.failures) || d.failures.length !== 0) return false;

  if (!Array.isArray(d.write_requests) || d.write_requests.some(receipt => !isWriteReceipt(receipt) || receipt.state !== 'committed')) return false;
  const routing = d.source_routing as { held?: object; generation_members_held?: object } | undefined;
  if (Object.keys(routing?.held ?? {}).length || Object.keys(routing?.generation_members_held ?? {}).length) return false;

  const completed = (processed: unknown, total: unknown) =>
    typeof total === 'number' && Number.isInteger(total) && total >= 0 && processed === total;
  return completed(d.pages_processed, d.pages_total) && completed(d.transcripts_processed, d.transcripts_total) &&
    [d.transcripts_skipped_budget, d.pages_skipped_budget, d.write_pending, d.held_failed,
      d.input_truncated, d.malformed_outputs, d.stopped_outputs].every(value => value === 0);
}
