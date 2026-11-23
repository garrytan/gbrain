/**
 * Quarantine holds follow their page (`write_gate_holds.page_id`; the column, its indexes and the three kinds of hold
 * are described in write-gate-schema.ts). The pieces every reader and sweep shares:
 *
 *  - `holdAppliesToPageSql`: when a hold is held for a page. A bound hold applies to its page and to no other, whatever
 *    either is called. An unbound hold applies to the page at its slug; one the upgrade marked with candidate pages
 *    (`page_candidates`) applies to every candidate as well, so its content stays out of answers until the owner decides.
 *  - `carryHoldsToPage`: the identity carry. When a page's rows move to another page id (a sync rename that fell back to
 *    add semantics, `gbrain repair rename-identity`), the holds move too, never dropping a hold that differs.
 *
 * The page-insert half (a hold waiting for its slug binds when a page is first created there) is
 * engine-sql/hold-binding.ts; the writer is write-gate-store.ts.
 */
import type { BrainEngine } from './engine.ts';

/**
 * SQL true when hold `h` is held for the page whose id is `pageId` (an SQL expression, NULL when no page holds `slug`) and
 * whose slug is `slug` (an SQL expression). Callers add their own status, kind and source tests.
 */
export function holdAppliesToPageSql(h: string, pageId: string, slug: string): string {
  return `(${h}.page_id = ${pageId} OR (${h}.page_id IS NULL AND (${h}.slug = ${slug} OR ${pageId} = ANY(COALESCE(${h}.page_candidates, '{}'::bigint[])))))`;
}

/** The deletion half of the page lifecycle: the SQL predicate a purge uses for the holds of a deleted page `id` / `slug` (both SQL expressions). */
export function holdOwnedByDeletedPageSql(h: string, pageId: string, slug: string): string {
  return `((${pageId}::bigint IS NOT NULL AND ${h}.page_id = ${pageId}::bigint) OR (${h}.page_id IS NULL AND ${h}.slug = ${slug}))`;
}

/**
 * Moves the holds bound to page `fromPageId` onto `toPageId`, inside the caller's transaction (runs again safely).
 * Holds that name the same content (same source, fingerprint and detector version) on both pages: identical ones (same
 * payload, tier, reasons and status) merge into the earlier hold, adding their sightings and dropping the merged hold's
 * receipt; one that differs in anything stays a separate row, marked with the surviving page as its only candidate (held
 * for it, listed by `gbrain doctor`), never dropped. Candidate lists that named the old page now name the new one.
 */
export async function carryHoldsToPage(tx: Pick<BrainEngine, 'executeRaw'>, fromPageId: number, toPageId: number): Promise<void> {
  if (fromPageId === toPageId) return;
  const params = [fromPageId, toPageId];
  await tx.executeRaw(`WITH twin AS (
      SELECT LEAST(f.id, t.id) AS keep_id, GREATEST(f.id, t.id) AS twin_id, f.seen_count + t.seen_count AS seen_total,
             GREATEST(f.last_seen_at, t.last_seen_at) AS last_seen
        FROM write_gate_holds f JOIN write_gate_holds t ON t.page_id = $2 AND t.source_id = f.source_id AND t.fingerprint = f.fingerprint AND t.detector_version = f.detector_version
       WHERE f.page_id = $1 AND f.payload = t.payload AND f.status = t.status AND f.tier = t.tier AND f.reason_families = t.reason_families
         AND f.reasons = t.reasons AND f.detector_error = t.detector_error
    ), summed AS (
      UPDATE write_gate_holds k SET seen_count = twin.seen_total, last_seen_at = twin.last_seen FROM twin WHERE k.id = twin.keep_id
    ), receipts AS (
      DELETE FROM write_gate_receipts r USING twin WHERE r.target_table = 'write_gate_holds' AND r.target_id = twin.twin_id::text
    )
    DELETE FROM write_gate_holds w USING twin WHERE w.id = twin.twin_id`, params);
  await tx.executeRaw(`UPDATE write_gate_holds f SET page_id = $2 WHERE f.page_id = $1 AND NOT EXISTS (SELECT 1 FROM write_gate_holds t
      WHERE t.page_id = $2 AND t.source_id = f.source_id AND t.fingerprint = f.fingerprint AND t.detector_version = f.detector_version)`, params);
  await tx.executeRaw('UPDATE write_gate_holds SET page_candidates = ARRAY[$2::bigint], page_id = NULL WHERE page_id = $1', params);
  await tx.executeRaw(`UPDATE write_gate_holds SET page_candidates = ARRAY(SELECT DISTINCT CASE WHEN c = $1::bigint THEN $2::bigint ELSE c END FROM unnest(page_candidates) AS c)
    WHERE $1::bigint = ANY(page_candidates)`, params);
}
