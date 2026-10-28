/**
 * GBRA-217 (A6): managed sync mirrors page change reasons from Git. A preparation that archives a snapshot (its page
 * exists) reads its file's reason from the pass's one trailer scan over `from..target` (`cachedSyncReasonScan`); the
 * pass result then carries that scan's notices (a failed or capped scan, a secret in a pushed trailer) and its count of
 * malformed trailers, reusing the scan when the consumer ran in this process.
 */
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SyncResult } from '../../commands/sync.ts';
import type { VersionHistory } from '../page-state/versions.ts';
import { cachedSyncReasonScan, importHistoryFor, reasonScanNotices } from '../reason-trailers.ts';
import { enterClaimStep, type ClaimPhaseClock } from './claim-phase.ts';
import { getWorktreeBinding } from './ownership.ts';

export async function managedFileHistory(engine: BrainEngine, clock: ClaimPhaseClock | undefined,
  input: { sourceId: string; root: string; path: string; from: string | null; to: string }): Promise<VersionHistory | undefined> {
  enterClaimStep(clock, 'reason_scan', undefined, 'git');
  const scan = await cachedSyncReasonScan(engine, { sourceId: input.sourceId, sourceRoot: input.root, from: input.from, to: input.to });
  return importHistoryFor(scan, join(input.root, input.path));
}

/** A pass that changed no existing page archived no snapshot, so it ran no scan and has nothing to report. */
export async function withManagedReasonNotices(engine: BrainEngine, sourceId: string, result: SyncResult): Promise<SyncResult> {
  if (result.status === 'dry_run' || !result.toCommit || result.modified + result.renamed === 0) return result;
  const binding = await getWorktreeBinding(engine, sourceId).catch(() => null);
  if (!binding?.local_path) return result;
  const scan = await cachedSyncReasonScan(engine, { sourceId, sourceRoot: join(binding.local_path, binding.relative_path), from: result.fromCommit, to: result.toCommit })
    .catch(() => null);
  const notices = reasonScanNotices(scan, sourceId);
  return { ...result, ...(notices.length ? { reason_notices: [...(result.reason_notices ?? []), ...notices] } : {}),
    ...(scan?.malformed ? { reason_trailers_malformed: scan.malformed } : {}) };
}
