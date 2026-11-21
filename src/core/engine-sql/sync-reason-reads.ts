/**
 * The purge epoch read the sync change-reason scan (reason-trailers.ts cachedSyncReasonScan) ran through `executeRaw`
 * (Rust engine lane 11). The statement text is the caller's, byte for byte (test/engine-sql-caller-raw-sql-pins.test.ts),
 * so PGLite and Postgres answer exactly as before. The tombstone reads and writes live in engine-sql/sources.ts.
 */
import type { HoldRead } from './sync-hold-reads.ts';

/** Also a screen-stable read of persistence/sync-convergence.ts, which imports it through reason-trailers.ts. */
export const SOURCE_PURGE_EPOCH_SQL = 'SELECT purge_epoch FROM sources WHERE id = $1';

/** The source's purge epoch as stored (every fact purge bumps it), or null for an unknown source. */
export async function readSourcePurgeEpoch(exec: HoldRead, sourceId: string): Promise<string | number | null> {
  const [source] = await exec.executeRaw<{ purge_epoch: string | number }>(SOURCE_PURGE_EPOCH_SQL, [sourceId]);
  return source?.purge_epoch ?? null;
}
