/**
 * GBRA-217 (A6): a classic sync pass mirrors page change reasons from Git. One trailer scan per pass over the range it
 * imports (`last_commit..pin` incremental, the whole history for a full re-import), run only when the pass imports
 * files; each imported file's snapshot then carries its newest first-parent commit's reason (`importHistoryFor`).
 */
import type { BrainEngine } from '../../core/engine.ts';
import { reasonScanNotices, scanSyncReasons, type SyncReasonScan } from '../../core/reason-trailers.ts';
import type { SyncResult } from '../sync.ts';

export { importHistoryFor as fileHistory } from '../../core/reason-trailers.ts';

/** The pass's scan, or null when it imports nothing or the source is a company brain (its pinned revision is not annotated). */
export async function scanClassicReasons(engine: BrainEngine, input: { sourceId: string | undefined; company: unknown; anchorPath: string;
  from: string | null; to: string; imports: number }): Promise<SyncReasonScan | null> {
  if (input.company || input.imports === 0) return null;
  return scanSyncReasons(engine, { sourceId: input.sourceId ?? 'default', sourceRoot: input.anchorPath, from: input.from, to: input.to });
}

/** The result with the pass's reason notices (a failed or capped scan, secrets in pushed trailers), when there are any. */
export function withReasonNotices(result: SyncResult, scan: SyncReasonScan | null | undefined, sourceId: string | undefined): SyncResult {
  const notices = reasonScanNotices(scan, sourceId ?? 'default');
  return { ...result, ...(notices.length ? { reason_notices: [...(result.reason_notices ?? []), ...notices] } : {}),
    ...(scan?.malformed ? { reason_trailers_malformed: scan.malformed } : {}) };
}
