/**
 * The reads of stamped trust tiers that page history and the quote path made through `executeRaw`: SQL once for
 * both engines.
 *
 * - `listVersionTrustTiers` / `listVersionReasonWriters`: the snapshot tier of a page version, and the type and tier
 *   of the write that replaced it (the next snapshot, or the live page).
 * - `listPageTypesByIds`: the stored type of each listed page, for the reads that quote a third-party page's rows
 *   (search/transcript-quote.ts `pageTypesById`).
 *
 * Every statement here is the statement its caller ran through `executeRaw`, byte for byte. Where master left the row
 * order to the plan the member sorts the rows in JavaScript (ids numeric), so every engine answers alike. Ids come
 * back as numbers.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

// ---------------------------------------------------------------------------------------------------------------
// Page history

/** The stored snapshot tier of each listed version (null when none was stamped), by id. */
export async function listVersionTrustTiers(engine: Raw, ids: readonly number[]): Promise<Array<{ id: number; trust_tier: string | null }>> {
  const got = await engine.executeRaw<{ id: number | string; trust_tier: string | null }>(
    'SELECT id, trust_tier FROM page_versions WHERE id = ANY($1::bigint[])', [[...ids]]);
  return got.map(r => ({ id: Number(r.id), trust_tier: r.trust_tier ?? null })).sort((a, b) => a.id - b.id);
}

/**
 * For each listed version, the type and tier of the write that replaced it: the next snapshot of the page, or the live
 * page when there is none. By id.
 */
export async function listVersionReasonWriters(engine: Raw, ids: readonly number[]): Promise<Array<{ id: number; type: string | null; tier: string | null }>> {
  const got = await engine.executeRaw<{ id: number | string; type: string | null; tier: string | null }>(
    `SELECT pv.id, COALESCE(nx.type, p.type) AS type, CASE WHEN nx.id IS NULL THEN p.trust_tier ELSE nx.trust_tier END AS tier
       FROM page_versions pv JOIN pages p ON p.id = pv.page_id
       LEFT JOIN LATERAL (SELECT n.id, n.type, n.trust_tier FROM page_versions n WHERE n.page_id = pv.page_id AND n.id > pv.id ORDER BY n.id LIMIT 1) nx ON true
      WHERE pv.id = ANY($1::bigint[])`, [[...ids]]);
  return got.map(r => ({ id: Number(r.id), type: r.type ?? null, tier: r.tier ?? null })).sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------------------------------------------------------
// Quoting

/** A page named by id: its stored type. */
export interface PageTypeRef { id: number; type: string | null }

/**
 * The stored type of each listed page, deleted or not, by id; an id no page has answers nothing. No scope or policy
 * filter: the callers pass ids of rows they already read under the caller's scope.
 */
export async function listPageTypesByIds(engine: Raw, ids: readonly number[]): Promise<PageTypeRef[]> {
  if (!ids.length) return [];
  const rows = await engine.executeRaw<{ id: number | string; type: string | null }>('SELECT id, type FROM pages WHERE id = ANY($1::bigint[])', [[...new Set(ids.map(Number))]]);
  return rows.map(r => ({ id: Number(r.id), type: r.type ?? null })).sort((a, b) => a.id - b.id);
}
