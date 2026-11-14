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

/** `blocking_slug`: the derived page whose label write failed; null when its dependents could not be read. */
export interface DerivedOriginPark { source_id: string; slug: string; page_id: number; blocking_slug: string | null; code: string | null; reason: string; parked_at: string }

/** SQL predicate for a purge scan over `pages` aliased `alias`: the page is not a parked origin. */
export function derivedOriginPurgeHold(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM op_checkpoints dop WHERE dop.op = '${DERIVED_ORIGIN_PARK_OP}' AND dop.fingerprint = ${alias}.id::text)`;
}

export async function parkDerivedOrigin(engine: SqlEngine, park: Omit<DerivedOriginPark, 'parked_at'>): Promise<void> {
  const row: DerivedOriginPark = { ...park, parked_at: new Date().toISOString() };
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT (op,fingerprint) DO UPDATE SET updated_at=now(), completed_keys=EXCLUDED.completed_keys`, [DERIVED_ORIGIN_PARK_OP, String(park.page_id), JSON.stringify([row])]);
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
