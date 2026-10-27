/**
 * GBRA-215: the source-scoped guard that review decisions (extraction_review promote, reject and distinct)
 * and ingest undo take while they re-read a page, re-check its eligibility and publish the decision. Two
 * decisions on one source never interleave between the check and the write, so an undo that previewed a
 * proposed page cannot delete it after a promotion landed, and a promotion cannot flip a page an undo is
 * retracting. The write itself still carries its expected revision; the guard orders the decisions.
 *
 * Built on the gbrain_cycle_locks lease (tryAcquireDbLock), so it holds across processes on both engines.
 * The wait is bounded and the lease is short: a holder that dies frees it when its TTL lapses.
 */
import type { BrainEngine } from '../engine.ts';
import { tryAcquireDbLock } from '../db-lock.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';

export const PUBLICATION_GUARD_WAIT_MS = 15_000;
const PUBLICATION_GUARD_TTL_MINUTES = 5;

export function publicationGuardId(sourceId: string): string {
  return `review-publication:${sourceId}`;
}

function guardBusy(sourceId: string, waitMs: number): OperationError {
  return opError('lock_busy', `Another review decision or undo on source ${sourceId} held the publication guard for the whole wait.`,
    `Nothing was written. Another review decision or ingest undo on this source held the guard for ${Math.round(waitMs / 1000)}s; retry the same command once it finishes.`,
    { fix: readFix('Shows the gbrain_cycle_locks rows, the review-publication guard included, with holder and expiry, read-only.', { argv: ['gbrain', 'status', '--section', 'locks', '--json'] }) });
}

/** Runs `work` holding the source's publication guard; throws `lock_busy` when another holder keeps it past `waitMs`. */
export async function withPublicationGuard<T>(engine: BrainEngine, sourceId: string, work: () => Promise<T>, waitMs = PUBLICATION_GUARD_WAIT_MS): Promise<T> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    const handle = await tryAcquireDbLock(engine, publicationGuardId(sourceId), PUBLICATION_GUARD_TTL_MINUTES);
    if (handle) {
      try { return await work(); } finally { await handle.release().catch(() => {}); }
    }
    if (performance.now() >= deadline) throw guardBusy(sourceId, waitMs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
