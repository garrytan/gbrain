/**
 * #6741 C: the managed purge's per-tombstone failure record and park.
 *
 * Each expired tombstone the managed purge fails to hard-delete (a failure
 * other than a revision race, which is deferred) is counted in
 * `op_checkpoints` (op `purge-deleted-park`), keyed by source, slug and the
 * tombstone's `deleted_at`, so a page restored and deleted again starts a new
 * count. After PURGE_PARK_LIMIT failures the tombstone is parked: the purge
 * phase stops submitting it (each attempt is a new permanent request id) and
 * doctor `purge_parked_pages` names it. A park leaves when the page is purged
 * or its tombstone changes, when its source's writer comes back after being
 * seen not active (rearm), or by one more attempt through
 * `gbrain pages purge-deleted --retry-parked`. Rows are exempt from the
 * op_checkpoints TTL sweep.
 */
import type { SqlEngine } from './model.ts';

export const PURGE_PARK_OP = 'purge-deleted-park';
export const PURGE_PARK_LIMIT = 5;

export interface PurgePark { source_id: string; slug: string; deleted_us: string; failures: number; code: string | null; reason: string; failed_at: string; inactive_seen?: true }

export function purgeParkKey(sourceId: string, slug: string, deletedUs: string): string {
  return JSON.stringify([sourceId, slug, deletedUs]);
}

/** The record's tombstone still exists as recorded (same source, slug and deleted_at). */
const LIVE_TOMBSTONE = `EXISTS (SELECT 1 FROM pages p WHERE p.source_id=o.completed_keys->0->>'source_id' AND p.slug=o.completed_keys->0->>'slug'
  AND p.deleted_at IS NOT NULL AND floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text=o.completed_keys->0->>'deleted_us')`;

/** Read-only: every failure record whose tombstone still exists as recorded, keyed by purgeParkKey. */
export async function readPurgeParks(engine: SqlEngine): Promise<Map<string, PurgePark>> {
  const rows = await engine.executeRaw<{ fingerprint: string; park: PurgePark | string }>(
    `SELECT o.fingerprint, o.completed_keys->0 AS park FROM op_checkpoints o WHERE o.op=$1 AND ${LIVE_TOMBSTONE} ORDER BY o.fingerprint`, [PURGE_PARK_OP]);
  return new Map(rows.map(row => [row.fingerprint, typeof row.park === 'string' ? JSON.parse(row.park) as PurgePark : row.park]));
}

/** Drops the records of tombstones that were purged, restored or deleted again; the purge runs it before it reads. */
export async function prunePurgeParks(engine: SqlEngine): Promise<void> {
  await engine.executeRaw(`DELETE FROM op_checkpoints o WHERE o.op=$1 AND NOT ${LIVE_TOMBSTONE}`, [PURGE_PARK_OP]);
}

export async function recordPurgeFailure(engine: SqlEngine, park: Pick<PurgePark, 'source_id' | 'slug' | 'deleted_us' | 'code' | 'reason'>): Promise<void> {
  const first: PurgePark = { ...park, failures: 1, failed_at: new Date().toISOString() };
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT (op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=jsonb_build_array((op_checkpoints.completed_keys->0)
      || jsonb_build_object('failures', COALESCE((op_checkpoints.completed_keys->0->>'failures')::int, 0) + 1, 'code', $4::text, 'reason', $5::text, 'failed_at', $6::text))`,
  [PURGE_PARK_OP, purgeParkKey(park.source_id, park.slug, park.deleted_us), JSON.stringify([first]), park.code, park.reason, first.failed_at]);
}

export async function clearPurgePark(engine: SqlEngine, key: string): Promise<void> {
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [PURGE_PARK_OP, key]);
}

/**
 * A source whose writer is not active: its records are marked, so they rearm once it is active again.
 * An active source: the records marked while it was not are dropped (the rearm) and their count returned.
 */
export async function notePurgeSourceWriter(engine: SqlEngine, sourceId: string, active: boolean): Promise<number> {
  if (!active) {
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0) || '{"inactive_seen":true}'::jsonb)
      WHERE op=$1 AND completed_keys->0->>'source_id'=$2 AND completed_keys->0->>'inactive_seen' IS NULL`, [PURGE_PARK_OP, sourceId]);
    return 0;
  }
  return (await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'=$2
    AND completed_keys->0->>'inactive_seen'='true' RETURNING 1`, [PURGE_PARK_OP, sourceId])).length;
}
