/**
 * Quarantine holds follow their page (`write_gate_holds.page_id`; the column, its indexes and the three kinds of hold
 * are described in write-gate-schema.ts). The pieces every reader and sweep shares:
 *
 *  - `holdAppliesToPageSql`: when a hold is held for a page. A bound hold applies to its page and to no other, whatever
 *    either is called. An unbound hold applies to the page at its slug; one the upgrade marked with candidate pages
 *    (`page_candidates`) applies to every candidate as well, so its content stays out of answers until the owner decides; it also
 *    applies to a page its slug leads to through the same source's rename record.
 *  - `carryHoldsToPage`: the identity carry. When a page's rows move to another page id (a sync rename that fell back to
 *    add semantics, `gbrain repair rename-identity`), the holds move too, never dropping a hold that differs.
 *
 * The page-insert half (a hold waiting for its slug binds when a page is first created there) is
 * engine-sql/hold-binding.ts; the writer is write-gate-store.ts.
 */
import type { BrainEngine } from './engine.ts';

/**
 * SQL true when hold `h` is held for the page whose id is `pageId` (an SQL expression, NULL when no page holds `slug`) and
 * whose slug is `slug` (an SQL expression). Callers add their own status, kind and source tests. An unbound hold also reaches
 * a page the same source's rename record leads to from the hold's slug (`slug_aliases` and `slug_rename_history`, chains
 * followed): a hold that committed after its page was first created is not bound by that creation, and the renames of a page
 * are recorded under the page lock, so the record finds the page whatever it is called now. Under name reuse this may hide
 * more than the hold covers, which is the safe side.
 */
export function holdAppliesToPageSql(h: string, pageId: string, slug: string): string {
  const reached = `EXISTS (${holdReachCte(h)} SELECT 1 FROM reach WHERE reach.s = ${slug})`;
  return `(${h}.page_id = ${pageId} OR (${h}.page_id IS NULL AND (${h}.slug = ${slug} OR ${pageId} = ANY(COALESCE(${h}.page_candidates, '{}'::bigint[])) OR ${reached})))`;
}

/**
 * The slugs a hold's own slug leads to through the same source's rename record (`slug_aliases`, alias to canonical, and
 * `slug_rename_history`, old to new; chains followed, a cycle ends), the hold's own slug included, as the CTE `reach(s)`.
 */
export function holdReachCte(h: string): string {
  return `WITH RECURSIVE reach(s) AS (SELECT ${h}.slug UNION SELECT n.t FROM reach x JOIN LATERAL (
      SELECT a.canonical_slug AS t FROM slug_aliases a WHERE a.source_id = ${h}.source_id AND a.alias_slug = x.s
      UNION SELECT r.new_slug FROM slug_rename_history r WHERE r.source_id = ${h}.source_id AND r.old_slug = x.s) n ON true)`;
}

/**
 * The deletion half of the page lifecycle: SQL true for the holds a purge of page `pageId` deletes outright (`pageId`
 * and `slug` are SQL expressions): holds bound to its id, and unbound holds with no candidate list whose slug is the
 * purged slug (or leads to it through the rename record) while no other page row is reachable from that slug: a hold
 * whose rename record still reaches a surviving page keeps protecting it, and goes with the last page it can reach.
 * A candidate-marked hold is held for several pages; `dropPurgedCandidates` takes the purged page out of its list
 * instead, and deletes it only when no candidate is left.
 */
export function holdOwnedByDeletedPageSql(h: string, pageId: string, slug: string): string {
  return `((${pageId}::bigint IS NOT NULL AND ${h}.page_id = ${pageId}::bigint) OR (${h}.page_id IS NULL AND ${h}.page_candidates IS NULL AND ${namedByPurgedSlug(h, slug)} AND NOT ${survivorOf(h, pageId)}))`;
}

/** An unbound hold's own slug is the purged slug, or leads to it through the same source's rename record. */
function namedByPurgedSlug(h: string, slug: string): string {
  return `(${h}.slug = ${slug} OR EXISTS (${holdReachCte(h)} SELECT 1 FROM reach WHERE reach.s = ${slug}))`;
}

/** Some page row other than the purged one (live or soft-deleted) is at a slug the hold's own slug leads to. */
function survivorOf(h: string, pageId: string): string {
  return `EXISTS (${holdReachCte(h)} SELECT 1 FROM reach JOIN pages q ON q.source_id = ${h}.source_id AND q.slug = reach.s WHERE q.id IS DISTINCT FROM ${pageId}::bigint)`;
}

/**
 * The other half of `holdOwnedByDeletedPageSql`: SQL true for the unbound, candidate-free holds a purge of page `pageId`
 * names but keeps, because another page row is still reachable from the hold's slug. The purge notes these in
 * `write_gate_hold_rechecks` (`noteKeptHoldsSql`): when two such pages are purged side by side, each keeps the hold for
 * the other, and only the maintenance sweep (write-gate-recheck.ts) sees that no page is left.
 */
export function holdKeptForSurvivorSql(h: string, pageId: string, slug: string): string {
  return `(${h}.page_id IS NULL AND ${h}.page_candidates IS NULL AND ${namedByPurgedSlug(h, slug)} AND ${survivorOf(h, pageId)})`;
}

/**
 * A hold's version: an md5 of what a later write or an owner decision changes (status, sightings, last sighting, payload,
 * binding, slug and tier). A purge's note records it; the sweep deletes a hold only while it is unchanged, so a hold
 * re-opened after the purge is a later write and stays. The time is taken as epoch seconds, independent of the session
 * time zone.
 */
export function holdVersionSql(h: string): string {
  return `md5(concat_ws('|', ${h}.status, ${h}.seen_count::text, extract(epoch FROM ${h}.last_seen_at)::text, md5(${h}.payload::text),
    COALESCE(${h}.page_id::text, '-'), COALESCE(${h}.page_candidates::text, '-'), ${h}.slug, ${h}.tier))`;
}

/**
 * A data-modifying CTE named `noted` for the purge statement that deletes holds: it notes, in the same statement and so
 * the same snapshot as the delete decision, the holds `holdKeptForSurvivorSql` keeps for the purged page(s), with the
 * ids of the surviving pages it saw (`purged(q)` is SQL true for a page row the statement purges, so those are left
 * out): the purge's own scrub of the rename record can cut the route to them, so the sweep checks them by id. `from` is
 * the FROM clause binding the purged page's `pageId` and `slug` expressions (and `extra`, an AND-ed time rule). No hold
 * row is locked and no unique key is touched, so a purge never waits on another purge's note.
 */
export function noteKeptHoldsCte(sourceParam: string, pageId: string, slug: string, purged: (q: string) => string, from = '', extra = 'true'): string {
  return `noted AS (INSERT INTO write_gate_hold_rechecks (source_id, hold_id, observed_version, survivor_ids)
      SELECT h.source_id, h.id, ${holdVersionSql('h')},
             ARRAY(${holdReachCte('h')} SELECT DISTINCT q.id FROM reach JOIN pages q ON q.source_id = h.source_id AND q.slug = reach.s WHERE NOT ${purged('q')})
        FROM write_gate_holds h
       WHERE h.source_id = ${sourceParam} AND EXISTS (SELECT 1 ${from} WHERE ${holdKeptForSurvivorSql('h', pageId, slug)} AND ${extra})
      RETURNING 1)`;
}

/** What a purge verifier counts as left behind: the holds the purge deletes outright, and any candidate-marked hold still naming the page. */
export function holdResidueOfDeletedPageSql(h: string, pageId: string, slug: string): string {
  return `(${holdOwnedByDeletedPageSql(h, pageId, slug)} OR (${h}.page_id IS NULL AND ${pageId}::bigint = ANY(COALESCE(${h}.page_candidates, '{}'::bigint[]))))`;
}

/**
 * Takes each purged page (its id, and for a tombstone expiry the deletion time as text, so a hold last seen after the soft delete
 * stays) out of the candidate list of the holds marked with candidates, and deletes the holds left with none. A hold that still
 * names a surviving candidate stays, because it is held for that page. Returns the ids of the holds deleted.
 */
export async function dropPurgedCandidates(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, pages: ReadonlyArray<{ id?: number | null; deletedAt?: string | null }>): Promise<string[]> {
  const gone = pages.filter(p => p.id !== undefined && p.id !== null);
  if (!gone.length) return [];
  await engine.executeRaw(`UPDATE write_gate_holds h SET page_candidates = ARRAY(SELECT c FROM unnest(h.page_candidates) AS c WHERE NOT EXISTS (
        SELECT 1 FROM unnest($2::bigint[], $3::timestamptz[]) AS d(id, upto) WHERE d.id = c AND (d.upto IS NULL OR GREATEST(h.created_at, h.last_seen_at) <= d.upto)))
      WHERE h.source_id = $1 AND h.page_id IS NULL AND h.page_candidates && $2::bigint[]`, [sourceId, gone.map(p => p.id), gone.map(p => p.deletedAt ?? null)]);
  return (await engine.executeRaw<{ id: string }>(`DELETE FROM write_gate_holds WHERE source_id = $1 AND page_id IS NULL AND page_candidates IS NOT NULL
      AND cardinality(page_candidates) = 0 RETURNING id::text AS id`, [sourceId])).map(h => h.id);
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
