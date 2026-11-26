/**
 * The writes of a resumable op's checkpoint (op-checkpoint.ts): replace the parent's completed keys, append child
 * paths, delete the parent (its paths go with it by the `ON DELETE CASCADE` foreign key), delete the paths, and the
 * seven-day purge of stale checkpoints (`purgeStaleCheckpoints`, on `executeRaw` as op-checkpoint.ts ran it; its text is
 * the constant in ../op-checkpoint-purge-sql.ts, built from the op-name constants it exempts). The read
 * is `readOpCheckpointKeys` (write-misc.ts). Each statement keeps the text op-checkpoint.ts ran and runs on
 * `executeRawDirect`, the direct session pool on Postgres (#1794), so PGLite and Postgres answer exactly as before; a
 * Rust brain answers from its store (rust/crates/gbrain-store/src/persistence/op_checkpoint.rs,
 * rust/docs/store/persistence.md "Op checkpoints").
 */
import type { BrainEngine } from '../engine.ts';

type Direct = Pick<BrainEngine, 'executeRawDirect'>;

/** Deletes the parent; the foreign key's `ON DELETE CASCADE` deletes its paths. A missing row is a no-op. */
export async function deleteOpCheckpoint(direct: Direct, op: string, fingerprint: string): Promise<void> {
  await direct.executeRawDirect(
    `DELETE FROM op_checkpoints WHERE op = $1 AND fingerprint = $2`,
    [op, fingerprint],
  );
}

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * The applied-capture records (`ingest_applied_captures`) older than `ttlDays` days deleted; how many. The dream
 * cycle's bookkeeping purge (ingestion/applied-captures.ts purgeStaleAppliedCaptures), beside the checkpoint purge.
 */
export async function purgeStaleAppliedCaptures(raw: Raw, ttlDays: number): Promise<number> {
  const rows = await raw.executeRaw<{ count: string | number }>(
    `WITH deleted AS (
       DELETE FROM ingest_applied_captures WHERE applied_at < now() - ($1 || ' days')::interval RETURNING 1
     )
     SELECT count(*)::text AS count FROM deleted`,
    [String(ttlDays)]);
  return Number(rows[0]?.count ?? 0);
}
