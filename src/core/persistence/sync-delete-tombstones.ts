/**
 * #7130: a managed sync deletion is a machine's inference that a file is gone, not a person's decision, so its
 * tombstone must not turn into a hard delete without review. Each `managed_sync_delete` apply records the tombstone it
 * made, in the same transaction: one `op_checkpoints` row per page (op `sync-delete-tombstone`, fingerprint = the page
 * id), `completed_keys[0]` holding the record. A record is open while its page is still soft-deleted at the recorded
 * `deleted_at`; a restore, a purge or a later delete of the restored page closes it, and only then may the checkpoint
 * sweep (purgeStaleCheckpoints) drop it.
 *
 * The automatic purges (the cycle purge phase and the `purge` job) leave such a tombstone alone unless another live
 * page of its source holds the same content (a live twin); the consented `gbrain pages purge-deleted` purges it and
 * says how many of its set these are. A tombstone made before records existed is recognized by its uncompacted
 * committed `managed_sync_delete` receipt; once that receipt is compacted it is no longer recognized.
 */
import type { BrainEngine } from '../engine.ts';
import { syncRows } from '../engine-sql/managed-sync-store.ts';

export const SYNC_DELETE_TOMBSTONE_OP = 'sync-delete-tombstone';

/**
 * Records the tombstone this transaction's soft delete made (`deleted_at = now()`, so it equals the page row's), after
 * `softDeletePage`. A page not soft-deleted by this transaction records nothing.
 */
export async function recordSyncDeleteTombstone(tx: Pick<BrainEngine, 'executeRaw'>,
  row: { source_id: string; source_incarnation: string; slug: string; request_id: string }, p: { passId?: string; runId?: string }): Promise<void> {
  await syncRows(tx, 'delete_tombstone_record', [SYNC_DELETE_TOMBSTONE_OP, row.source_incarnation, p.passId ?? null, p.runId ?? null, row.request_id, row.source_id, row.slug]);
}

/**
 * SQL: the tombstone `alias` (a soft-deleted `pages` row) was made by a managed sync deletion: its open record, or the
 * uncompacted committed `managed_sync_delete` receipt that deleted it (completed at or after its `deleted_at`).
 */
export const syncDeleteOrigin = (alias: string): string => `(EXISTS (SELECT 1 FROM op_checkpoints sdt WHERE sdt.op = '${SYNC_DELETE_TOMBSTONE_OP}'
      AND sdt.fingerprint = ${alias}.id::text AND ${alias}.deleted_at = (sdt.completed_keys->0->>'deleted_at')::timestamptz)
    OR EXISTS (SELECT 1 FROM persistence_requests sdr WHERE sdr.source_id = ${alias}.source_id AND sdr.slug = ${alias}.slug AND sdr.page_id = ${alias}.id
      AND sdr.intent IS NOT NULL AND NOT sdr.compacted AND sdr.state = 'committed' AND sdr.intent->>'kind' = 'managed_sync_delete'
      AND sdr.completed_at >= ${alias}.deleted_at))`;

/**
 * Every tombstone a managed sync made whose content no live page of its source holds (`expired`: older than the cutoff),
 * whatever its age, so a purge that excludes them cannot race a tombstone across its cutoff.
 */
export async function readUnreviewedSyncTombstones(engine: Pick<BrainEngine, 'listUnreviewedSyncTombstones'>, olderThanHours: number):
  Promise<Array<{ id: number; source_id: string; slug: string; expired: boolean }>> {
  return engine.listUnreviewedSyncTombstones(olderThanHours);
}

/** The `blocked` entry of a tombstone an automatic purge keeps. */
export const syncDeleteHeld = (row: { source_id: string; slug: string }, olderThanHours: number) => ({ source_id: row.source_id, slug: row.slug,
  code: 'sync_delete_unreviewed', reason: `A managed sync deleted this page and no live page of ${row.source_id} has its content, so the automatic purge keeps it. `
    + `Restore it with gbrain restore ${row.slug} --source-id ${row.source_id} --force, or review the set with gbrain pages purge-deleted --older-than ${olderThanHours}h --dry-run `
    + 'and purge it with --yes; a purged page can only come back from a backup.' });
