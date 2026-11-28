/**
 * GST-2689: the purge's park for a soft-deleted page that is the only privacy of a page derived from it. A page that reads
 * as world by its own label but is hidden from remote callers because its origin is private (a declared derived_from
 * origin, an atom's source_slug origin, a concept whose provenance atom has one) would open once the origin row is gone,
 * so before any purge removes such a row the derived pages get `visibility: private` (repair/origin-carry.ts). When that
 * label write fails, the origin is parked here (op `derived-origin-park`, fingerprint the page id) with the page that
 * blocks it and the reason; every purge path skips it (derivedOriginPurgeHold) and doctor `derived_origin_parked` names
 * it. Each purge run tries the label again and drops the park once it lands; a park whose page was restored or purged is
 * pruned. Rows are exempt from the op_checkpoints TTL sweep. No engine-sql imports, so `engine-sql/pages.ts` may import it.
 */
import type { BrainEngine } from '../engine.ts';

export const DERIVED_ORIGIN_PARK_OP = 'derived-origin-park';
export const DERIVED_ORIGIN_PARKED_CODE = 'derived_origin_parked';

/**
 * `blocking_slug`: the derived page whose label write failed; null when its dependents could not be read. `held_request_id`: the owner's
 * explicit purge this park held (a retention purge leaves it unset); a later park of the same page keeps it.
 */
export interface DerivedOriginPark { source_id: string; slug: string; page_id: number; blocking_slug: string | null; code: string | null; reason: string; parked_at: string; held_request_id?: string; held_deleted_us?: string }

/** The command that finishes an owner purge a park held: `gbrain delete` makes a new request_id, and an explicit purge writes the purge tombstones. */
export const finishPurgeArgv = (sourceId: string, slug: string): string[] => ['gbrain', 'delete', slug, '--purge', '--source-id', sourceId];

/** The receipt clause of a held owner purge, after its condition ("Once ..., "): the command that finishes it, as a new request. */
export function finishPurgeNote(sourceId: string, slug: string, requestId: string): string {
  return `finish this purge with ${finishPurgeArgv(sourceId, slug).join(' ')} as a new request (not a replay of request_id ${requestId}): it writes the purge tombstones, which the automatic purge that otherwise removes the page does not.`;
}

/** SQL predicate for a purge scan over `pages` aliased `alias`: the page is not a parked origin. */
export function derivedOriginPurgeHold(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM op_checkpoints dop WHERE dop.op = '${DERIVED_ORIGIN_PARK_OP}' AND dop.fingerprint = ${alias}.id::text)`;
}

export async function parkDerivedOrigin(engine: Pick<BrainEngine, 'upsertDerivedOriginPark'>, park: Omit<DerivedOriginPark, 'parked_at'>): Promise<void> {
  await engine.upsertDerivedOriginPark(park.page_id, { ...park, parked_at: new Date().toISOString() });
}

/**
 * GST-2766: the record that an owner purge is owed (op `owed-page-purge`, fingerprint the page id), kept apart from the
 * park. A park is cleared once its carry lands, often in a run that does not remove the page; this record stays until
 * the page is removed or restored, so whichever purge removes the page writes the purge tombstones. It names no slug or
 * text: the source, the page id, the tombstone it was owed for (`deleted_us`, as purge-parks.ts keys a tombstone) and
 * the owner's request id. A record whose tombstone changed (restored, deleted again) applies to nothing and is pruned.
 */
export const OWED_PURGE_OP = 'owed-page-purge';
export interface OwedPurge { source_id: string; page_id: number; deleted_us: string; request_id: string }


/**
 * Records that the owner's purge `requestId` is owed for page `pageId`'s current tombstone; a page that is not a tombstone
 * records nothing. The page's park, when it holds that purge, is bound to the same tombstone (`held_deleted_us`), so a page
 * restored and deleted again never inherits the old hold (releaseStaleHolds).
 */
export async function recordOwedPurge(engine: Pick<BrainEngine, 'recordOwedPurgeRows'>, pageId: number, requestId: string): Promise<void> {
  await engine.recordOwedPurgeRows(pageId, requestId);
}

/** Drops the owner purge a park holds once its page's tombstone is not the one the hold was recorded for (restored, deleted again). */
export async function releaseStaleHolds(engine: Pick<BrainEngine, 'releaseStaleOriginParkHolds'>): Promise<void> {
  await engine.releaseStaleOriginParkHolds(DERIVED_ORIGIN_PARK_OP);
}

/** Read-only: every owed purge whose tombstone still exists as recorded. */
export async function readOwedPurges(engine: Pick<BrainEngine, 'listOwedPurgeRecords'>): Promise<OwedPurge[]> {
  // The fingerprint order never reaches output: the owed purges become a Set of page ids, which has no order to show.
  const rows = await engine.listOwedPurgeRecords(OWED_PURGE_OP);
  return rows.map(row => typeof row.owed === 'string' ? JSON.parse(row.owed) as OwedPurge : row.owed as OwedPurge).map(owed => ({ ...owed, page_id: Number(owed.page_id) }));
}

/** Drops the records whose tombstone was removed, restored or deleted again. */
export async function pruneOwedPurges(engine: Pick<BrainEngine, 'pruneOwedPurgeRecords'>): Promise<void> {
  await engine.pruneOwedPurgeRecords(OWED_PURGE_OP);
}

/** Removes the records of these pages; the purge that removes a page calls it in its transaction. */
export async function clearOwedPurges(engine: Pick<BrainEngine, 'deleteOriginHoldRows'>, pageIds: readonly number[]): Promise<void> {
  if (!pageIds.length) return;
  await engine.deleteOriginHoldRows(OWED_PURGE_OP, pageIds);
}

export async function clearDerivedOriginParks(engine: Pick<BrainEngine, 'deleteOriginHoldRows'>, pageIds: readonly number[]): Promise<void> {
  if (!pageIds.length) return;
  await engine.deleteOriginHoldRows(DERIVED_ORIGIN_PARK_OP, pageIds);
}

export const TOMBSTONE = 'EXISTS (SELECT 1 FROM pages p WHERE p.id::text = o.fingerprint AND p.deleted_at IS NOT NULL)';

/** Drops the parks of pages that were restored or purged. */
export async function pruneDerivedOriginParks(engine: Pick<BrainEngine, 'pruneOriginParkRecords'>): Promise<void> {
  await engine.pruneOriginParkRecords(DERIVED_ORIGIN_PARK_OP);
}

/** Read-only: every park whose page is still a tombstone, oldest first. */
export async function readDerivedOriginParks(engine: Pick<BrainEngine, 'listDerivedOriginParks'>): Promise<DerivedOriginPark[]> {
  return engine.listDerivedOriginParks(DERIVED_ORIGIN_PARK_OP);
}
