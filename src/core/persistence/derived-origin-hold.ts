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
import type { SqlEngine } from './model.ts';

export const DERIVED_ORIGIN_PARK_OP = 'derived-origin-park';
export const DERIVED_ORIGIN_PARKED_CODE = 'derived_origin_parked';

/**
 * `blocking_slug`: the derived page whose label write failed; null when its dependents could not be read. `held_request_id`: the owner's
 * explicit purge this park held (a retention purge leaves it unset); a later park of the same page keeps it.
 */
export interface DerivedOriginPark { source_id: string; slug: string; page_id: number; blocking_slug: string | null; code: string | null; reason: string; parked_at: string; held_request_id?: string }

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

export async function parkDerivedOrigin(engine: SqlEngine, park: Omit<DerivedOriginPark, 'parked_at'>): Promise<void> {
  const row: DerivedOriginPark = { ...park, parked_at: new Date().toISOString() };
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT (op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=CASE WHEN (op_checkpoints.completed_keys->0) ? 'held_request_id' AND NOT (EXCLUDED.completed_keys->0) ? 'held_request_id'
      THEN jsonb_set(EXCLUDED.completed_keys, '{0,held_request_id}', op_checkpoints.completed_keys->0->'held_request_id') ELSE EXCLUDED.completed_keys END`, [DERIVED_ORIGIN_PARK_OP, String(park.page_id), JSON.stringify([row])]);
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

const DELETED_US = (alias: string) => `floor(extract(epoch FROM ${alias}.deleted_at)*1000000)::bigint::text`;
const OWED_TOMBSTONE = `EXISTS (SELECT 1 FROM pages p WHERE p.id::text = o.fingerprint AND p.deleted_at IS NOT NULL AND ${DELETED_US('p')} = o.completed_keys->0->>'deleted_us')`;

/** Records that the owner's purge `requestId` is owed for page `pageId`'s current tombstone; a page that is not a tombstone records nothing. */
export async function recordOwedPurge(engine: SqlEngine, pageId: number, requestId: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
    SELECT $1, p.id::text, jsonb_build_array(jsonb_build_object('source_id', p.source_id, 'page_id', p.id, 'deleted_us', ${DELETED_US('p')}, 'request_id', $3::text))
    FROM pages p WHERE p.id = $2 AND p.deleted_at IS NOT NULL
    ON CONFLICT (op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=EXCLUDED.completed_keys
      WHERE op_checkpoints.completed_keys->0->>'deleted_us' IS DISTINCT FROM EXCLUDED.completed_keys->0->>'deleted_us'`, [OWED_PURGE_OP, pageId, requestId]);
}

/** Read-only: every owed purge whose tombstone still exists as recorded. */
export async function readOwedPurges(engine: SqlEngine): Promise<OwedPurge[]> {
  const rows = await engine.executeRaw<{ owed: OwedPurge | string }>(`SELECT o.completed_keys->0 AS owed FROM op_checkpoints o WHERE o.op=$1 AND ${OWED_TOMBSTONE}
    ORDER BY o.fingerprint`, [OWED_PURGE_OP]);
  return rows.map(row => typeof row.owed === 'string' ? JSON.parse(row.owed) as OwedPurge : row.owed).map(owed => ({ ...owed, page_id: Number(owed.page_id) }));
}

/** Drops the records whose tombstone was removed, restored or deleted again. */
export async function pruneOwedPurges(engine: SqlEngine): Promise<void> {
  await engine.executeRaw(`DELETE FROM op_checkpoints o WHERE o.op=$1 AND NOT ${OWED_TOMBSTONE}`, [OWED_PURGE_OP]);
}

/** Removes the records of these pages; the purge that removes a page calls it in its transaction. */
export async function clearOwedPurges(engine: SqlEngine, pageIds: readonly number[]): Promise<void> {
  if (!pageIds.length) return;
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint = ANY($2::text[])', [OWED_PURGE_OP, pageIds.map(String)]);
}

export async function clearDerivedOriginParks(engine: SqlEngine, pageIds: readonly number[]): Promise<void> {
  if (!pageIds.length) return;
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint = ANY($2::text[])', [DERIVED_ORIGIN_PARK_OP, pageIds.map(String)]);
}

const TOMBSTONE = 'EXISTS (SELECT 1 FROM pages p WHERE p.id::text = o.fingerprint AND p.deleted_at IS NOT NULL)';

/** Drops the parks of pages that were restored or purged. */
export async function pruneDerivedOriginParks(engine: SqlEngine): Promise<void> {
  await engine.executeRaw(`DELETE FROM op_checkpoints o WHERE o.op=$1 AND NOT ${TOMBSTONE}`, [DERIVED_ORIGIN_PARK_OP]);
}

/** Read-only: every park whose page is still a tombstone, oldest first. */
export async function readDerivedOriginParks(engine: SqlEngine): Promise<DerivedOriginPark[]> {
  const rows = await engine.executeRaw<{ park: DerivedOriginPark | string }>(
    `SELECT o.completed_keys->0 AS park FROM op_checkpoints o WHERE o.op=$1 AND ${TOMBSTONE} ORDER BY o.updated_at, o.fingerprint`, [DERIVED_ORIGIN_PARK_OP]);
  return rows.map(row => typeof row.park === 'string' ? JSON.parse(row.park) as DerivedOriginPark : row.park);
}
