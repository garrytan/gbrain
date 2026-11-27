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
 *
 * A park records the gbrain version that wrote it, as a global-maintenance
 * phase streak does: only a park the running version wrote is parked
 * (`isParked`). One another version wrote, or one from before parks recorded
 * a version, gets one automatic attempt (the refusal behind it may be fixed);
 * a failure re-parks it under the running version, so it is tried once per
 * version per tombstone.
 */
import { VERSION } from '../../version.ts';
import type { BrainEngine } from '../engine.ts';

export const PURGE_PARK_OP = 'purge-deleted-park';
export const PURGE_PARK_LIMIT = 5;

export interface PurgePark { source_id: string; slug: string; deleted_us: string; failures: number; code: string | null; reason: string; failed_at: string; inactive_seen?: true;
  /** The gbrain version that recorded the last failure; absent on a park written before parks recorded one. */
  version?: string }

/** Parked: PURGE_PARK_LIMIT failures, the last one recorded by the running gbrain version. */
export function isParked(park: PurgePark | undefined): park is PurgePark {
  return park !== undefined && park.failures >= PURGE_PARK_LIMIT && park.version === VERSION;
}

export function purgeParkKey(sourceId: string, slug: string, deletedUs: string): string {
  return JSON.stringify([sourceId, slug, deletedUs]);
}

/** The record's tombstone still exists as recorded (same source, slug and deleted_at). */
export const LIVE_TOMBSTONE = `EXISTS (SELECT 1 FROM pages p WHERE p.source_id=o.completed_keys->0->>'source_id' AND p.slug=o.completed_keys->0->>'slug'
  AND p.deleted_at IS NOT NULL AND floor(extract(epoch FROM p.deleted_at)*1000000)::bigint::text=o.completed_keys->0->>'deleted_us')`;

/** Read-only: every failure record whose tombstone still exists as recorded, keyed by purgeParkKey. */
export async function readPurgeParks(engine: Pick<BrainEngine, 'listPurgeParks'>): Promise<Map<string, PurgePark>> {
  return new Map((await engine.listPurgeParks(PURGE_PARK_OP)).map(row => [row.fingerprint, row.park]));
}

/** Drops the records of tombstones that were purged, restored or deleted again; the purge runs it before it reads. */
export async function prunePurgeParks(engine: Pick<BrainEngine, 'prunePurgeParkRecords'>): Promise<void> {
  await engine.prunePurgeParkRecords(PURGE_PARK_OP);
}

export async function recordPurgeFailure(engine: Pick<BrainEngine, 'recordPurgeFailureRecord'>, park: Pick<PurgePark, 'source_id' | 'slug' | 'deleted_us' | 'code' | 'reason'>): Promise<void> {
  const first: PurgePark = { ...park, failures: 1, failed_at: new Date().toISOString(), version: VERSION };
  await engine.recordPurgeFailureRecord({ op: PURGE_PARK_OP, key: purgeParkKey(park.source_id, park.slug, park.deleted_us), first: JSON.stringify([first]),
    code: park.code, reason: park.reason, failedAt: first.failed_at, version: VERSION });
}

export async function clearPurgePark(engine: Pick<BrainEngine, 'deletePurgeParkRecord'>, key: string): Promise<void> {
  await engine.deletePurgeParkRecord(PURGE_PARK_OP, key);
}

/**
 * A source whose writer is not active: its records are marked, so they rearm once it is active again.
 * An active source: the records marked while it was not are dropped (the rearm) and their count returned.
 */
export async function notePurgeSourceWriter(engine: Pick<BrainEngine, 'markPurgeParksInactive' | 'dropRearmedPurgeParks'>, sourceId: string, active: boolean): Promise<number> {
  if (!active) {
    await engine.markPurgeParksInactive(PURGE_PARK_OP, sourceId);
    return 0;
  }
  return engine.dropRearmedPurgeParks(PURGE_PARK_OP, sourceId);
}
