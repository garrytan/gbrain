/**
 * The belief side of a purge: the source purge epoch, the ledger presence probe, the purge's own suppression writes and
 * the restore replay's tombstone upsert and schema probes (src/core/belief/purge.ts and purge-mirror.ts). One SQL
 * implementation for both engines. Each statement is the text its caller ran through executeRaw, byte for byte, so
 * PGLite and Postgres answer exactly as before; the decisions (when to bump, which fields to suppress or release, what a
 * replay may touch) stay with the callers.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';

/** Raises the source's purge epoch by one; answers the new epoch, or null for an unknown source (no row is updated). */
export async function bumpSourcePurgeEpoch(exec: SqlExecutor, sourceId: string): Promise<number | null> {
  const [row] = await exec.executeRaw<{ purge_epoch: string | number }>('UPDATE sources SET purge_epoch = purge_epoch + 1 WHERE id = $1 RETURNING purge_epoch', [sourceId]);
  return row ? Number(row.purge_epoch) : null;
}

/** Whether the source has any belief event, of any incarnation. */
export async function hasBeliefEvents(exec: LegacyUnscopedRead, sourceId: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ present: boolean }>('SELECT EXISTS (SELECT 1 FROM belief_events WHERE source_id = $1) AS present', [sourceId]);
  return row?.present === true;
}
