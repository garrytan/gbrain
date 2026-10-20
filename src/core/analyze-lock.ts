import type { BrainEngine } from './engine.ts';

/** SQLSTATE lock_not_available: a NOWAIT lock request met a conflicting lock. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * #7083: ANALYZE takes SHARE UPDATE EXCLUSIVE, the lock a running VACUUM or autovacuum holds. Postgres cancels a
 * (non-wraparound) autovacuum once another session has waited `deadlock_timeout` (1 s by default) for a lock it holds,
 * so an ANALYZE that waits (the refresh's 2 s lock timeout, or none at all) cancels the autovacuum it meets. Run after
 * every embed drain on a 10M-chunk content_chunks, that cancelled every autovacuum of the table before it finished.
 *
 * Every ANALYZE gbrain runs on Postgres on its own takes the table's lock first, inside its transaction, with NOWAIT:
 * a lock that is not free at once (a vacuum, another ANALYZE, an index build) fails with 55P03 and the caller defers
 * its ANALYZE (`analyzeDeferred`) instead of waiting. A request that never waits never signals a vacuum, and the
 * ANALYZE that follows reuses the lock this transaction holds. PGLite has no autovacuum and takes no lock here.
 */
export async function lockTableForAnalyze(tx: Pick<BrainEngine, 'executeRaw' | 'kind'>, table: string): Promise<void> {
  if (tx.kind !== 'postgres') return;
  await tx.executeRaw(`LOCK TABLE ${table} IN SHARE UPDATE EXCLUSIVE MODE NOWAIT`);
}

/** Whether `error` is `lockTableForAnalyze`'s refusal: another session holds the table, so the ANALYZE is deferred. */
export function analyzeDeferred(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}
