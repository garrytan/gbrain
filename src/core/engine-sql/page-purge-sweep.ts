/**
 * The deletes and reads of a page purge's sweep (persistence/page-purge.ts `sweepPurgedPage` and `deletePageWithSegments`):
 * the trust proposals, held writes, gate receipts, facts and file records that name the page, the page's add_timeline_entry
 * and edit_page receipts, and the segment storage a page delete removes (the page's stagings, its texts, and the
 * unreferenced texts that hold one of its claims).
 *
 * The review queue, review proposals and decide proposals the sweep deletes are the fact purge's members
 * (`deletePurgeReviewQueue`, `deletePurgeReviewProposals`, `deletePurgeDecideProposals`, engine-sql/facts-purge.ts): the page
 * sweep's statements are the same text. A page's facts are `PAGE_FACTS` (engine-sql/page-purge.ts). Where a statement has no
 * order of its own (`RETURNING`, `UNION`), the function sorts so every engine answers the same order; a Rust brain serves the
 * same members from its records (src/core/rust-engine/store-members/page-purge-sweep.ts).
 *
 * Every function takes the engine (or transaction) it runs on and returns plain values: counts as numbers.
 */
import { dropPurgedCandidates, holdOwnedByDeletedPageSql, noteKeptHoldsCte } from '../write-gate-binding.ts';
import type { BrainEngine } from '../engine.ts';
import type { IntentRedactionTarget } from '../persistence/intent-redaction.ts';
import { stagingNeedsTextSql } from '../page-body/schema.ts';
import { byText } from './page-purge.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** Hand-numbered placeholders spliced next to the vetted predicate builders, so the text keeps its own `$N` (as engine-sql/page-purge.ts does). */
const P = { p1: '$1', p2: '$2', p3: '$3', p4: '$4' } as const;

/** An add_timeline_entry or edit_page receipt of a page: its entry text and edit diff, as the journal sweep redacts them. */
export type PageTimelineReceiptRow = IntentRedactionTarget & { sequence: string; summary: string | null; source: string | null; bullet: string | null; diff: string | null };

/** What one claim-sweep statement scanned and deleted: the last sha256 (hex) of the chunk it read, null when none remained, and the deleted texts' sha256 (hex), sorted. */
export interface ClaimTextSweep { last: string | null; deleted: string[] }

/** Ids as decimal text in numeric order (`RETURNING` leaves the order open). */
export const byId = (a: string, b: string): number => a.length - b.length || byText(a, b);

/** The page's trust proposals: those naming the page, one of its facts or one of its takes as target or related row. Writes trust_proposals; run it in the purge transaction. */
export async function deletePurgedPageTrustProposals(engine: Raw, sourceId: string, pageId: number, factIds: number[], takeIds: number[]): Promise<number> {
  return (await engine.executeRaw(`DELETE FROM trust_proposals WHERE source_id=$1 AND ((target_table='pages' AND target_id=$2) OR (related_table='pages' AND related_id=$2)
      OR (target_table='facts' AND target_id=ANY($3::bigint[])) OR (related_table='facts' AND related_id=ANY($3::bigint[]))
      OR (target_table='takes' AND target_id=ANY($4::bigint[])) OR (related_table='takes' AND related_id=ANY($4::bigint[]))) RETURNING 1`, [sourceId, pageId, factIds, takeIds])).length;
}

/** The page's held writes (every hold of the slug in the source); their ids as text, in id order. Writes write_gate_holds; run it in the purge transaction. */
export async function deletePurgedPageHolds(engine: Raw, sourceId: string, slug: string, pageId: number | null = null): Promise<string[]> {
  // The holds kept for another page are noted in the same statement (write-gate-binding.ts noteKeptHoldsCte), once the notes
  // table exists (a brain whose v337 migration has not run yet still purges).
  const [notes] = await engine.executeRaw<{ ok: boolean }>("SELECT pg_catalog.to_regclass('write_gate_hold_rechecks') IS NOT NULL AS ok");
  // The purged page's source, id and slug ride in one CTE, so the statement holds no hand-numbered placeholder.
  const noted = notes?.ok ? `, ${noteKeptHoldsCte('(SELECT src FROM d)', 'd.pid', 'd.slug', q => `${q}.id = (SELECT pid FROM d)`, 'FROM d')}` : '';
  const { text, params } = renderFragment(sqlFragment`WITH d(src, pid, slug) AS (SELECT ${sourceId}::text, ${pageId}::bigint, ${slug}::text)${trustedSql(noted)}
    DELETE FROM write_gate_holds h USING d WHERE h.source_id = d.src AND ${trustedSql(holdOwnedByDeletedPageSql('h', 'd.pid', 'd.slug'))} RETURNING h.id::text AS id`);
  const rows = await engine.executeRaw<{ id: string }>(text, params);
  // A hold marked with candidate pages stays while a candidate survives; the purged page leaves its list (write-gate-binding.ts).
  rows.push(...(await dropPurgedCandidates(engine, sourceId, pageId === null ? [] : [{ id: pageId }])).map(id => ({ id })));
  return rows.map(h => h.id).sort(byId);
}

/** The gate receipts that name the page, one of its facts or takes, or one of its held writes (`holdIds`, as text); how many. Writes write_gate_receipts; run it in the purge transaction. */
export async function deletePurgedPageGateReceipts(engine: Raw, pageId: number, factIds: number[], takeIds: number[], holdIds: string[]): Promise<number> {
  return (await engine.executeRaw(`DELETE FROM write_gate_receipts WHERE (target_table='pages' AND target_id=$1) OR (target_table='facts' AND target_id=ANY($2::text[]))
      OR (target_table='takes' AND target_id=ANY($3::text[])) OR (target_table='write_gate_holds' AND target_id=ANY($4::text[])) RETURNING 1`,
  [String(pageId), factIds.map(String), takeIds.map(String), holdIds])).length;
}

export { deletePurgedPageFacts } from './page-purge.ts';

/** The page's file records (attached to it, or detached from it and still naming its slug in the source or in none); their storage paths, sorted. Writes files; run it in the purge transaction. */
export async function deletePurgedPageFiles(engine: Raw, sourceId: string, slug: string, pageId: number): Promise<string[]> {
  const rows = await engine.executeRaw<{ storage_path: string }>(`DELETE FROM files WHERE (page_id=$1 OR (page_id IS NULL AND page_slug=$2 AND (source_id=$3 OR source_id IS NULL)))
    RETURNING storage_path`, [pageId, slug, sourceId]);
  return rows.map(f => f.storage_path).sort(byText);
}

/**
 * The add_timeline_entry receipts of `slugs`, compacted ones included, in sequence order after `after` (a sequence as text), up
 * to `limit`; their outcome keeps the entry text. `withDiffs` adds the edit_page receipts, whose outcome keeps the edit's unified diff of the page text.
 */
export async function listPageTimelineReceipts(engine: Raw, sourceId: string, slugs: readonly string[], limit: number, after: string, withDiffs: boolean): Promise<PageTimelineReceiptRow[]> {
  return engine.executeRaw<PageTimelineReceiptRow>(`SELECT id::text AS id, principal_kind, principal_id, sequence::text AS sequence, outcome->'entry'->>'summary' AS summary,
    outcome->'entry'->>'source' AS source, outcome->>'bullet' AS bullet, outcome->>'diff' AS diff FROM persistence_requests
    WHERE source_id=$1 AND slug=ANY($2::text[]) AND ((operation='add_timeline_entry' AND outcome ? 'entry') OR ($5::boolean AND operation='edit_page' AND outcome ? 'diff'))
    AND sequence > $4::bigint ORDER BY sequence LIMIT $3`, [sourceId, [...slugs], limit, after, withDiffs]);
}

/** The sha256 (hex) of every text the page's manifest names or its stagings (by slug or page) recorded in the source, once each, sorted. */
export async function listPageSegmentShas(engine: Raw, sourceId: string, slug: string, pageId: number): Promise<string[]> {
  const rows = await engine.executeRaw<{ sha: string }>(`SELECT encode(sha256,'hex') AS sha FROM page_body_manifest WHERE page_id=$1
    UNION SELECT encode(r.sha256,'hex') FROM page_body_stagings s JOIN page_body_staging_texts r ON r.staging_id=s.id
      WHERE s.source_id=$2 AND (s.slug=$3 OR s.page_id=$1) AND r.source_id=$2`, [pageId, sourceId, slug]);
  return rows.map(r => r.sha).sort(byText);
}

/** How many manifest rows the page has (every generation, staged rows included): what its delete cascades. */
export async function countPageManifestRows(engine: Raw, pageId: number): Promise<number> {
  return Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_body_manifest WHERE page_id=$1', [pageId]))[0]?.n ?? 0);
}

/** The source's stagings of the slug or of the page, with the texts and parts they recorded; how many stagings. Writes page_body_stagings; run it in the purge transaction. */
export async function deletePageStagings(engine: Raw, sourceId: string, slug: string, pageId: number): Promise<number> {
  return (await engine.executeRaw('DELETE FROM page_body_stagings WHERE source_id=$1 AND (slug=$2 OR page_id=$3) RETURNING 1', [sourceId, slug, pageId])).length;
}

/** The source's segment texts among `shas` (hex) that no manifest row names and no live staging recorded; how many. Writes page_segment_texts; run it in the purge transaction. */
export async function deletePageSegmentTexts(engine: Raw, sourceId: string, shas: readonly string[]): Promise<number> {
  const { text } = renderFragment(sqlFragment`DELETE FROM page_segment_texts t WHERE t.source_id=${trustedSql(P.p1)} AND t.sha256=ANY(SELECT decode(h,'hex') FROM unnest(${trustedSql(P.p2)}::text[]) AS h)
    AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256) AND NOT ${trustedSql(stagingNeedsTextSql('t'))} RETURNING 1`);
  return (await engine.executeRaw(text, [sourceId, [...shas]])).length;
}

/**
 * #9743: one statement of the claim sweep. It picks the unreferenced texts of the source after `cursor` (a sha256 as hex, '' for
 * the start) in sha order, 4096 at most and the bytes before each under `chunkBytes`, lowers each once, and deletes the ones that
 * hold one of `forms` (claim forms, lowered) and that no manifest row names and no live staging recorded. Writes page_segment_texts; run it in the purge transaction.
 */
export async function sweepPageTextsForClaims(engine: Raw, sourceId: string, cursor: string, forms: readonly string[], chunkBytes: number): Promise<ClaimTextSweep> {
  const { text } = renderFragment(sqlFragment`WITH chunk AS MATERIALIZED (
          SELECT u.sha256 FROM (SELECT t.sha256, sum(t.byte_len) OVER (ORDER BY t.sha256) - t.byte_len AS before
            FROM (SELECT t.sha256, t.byte_len FROM page_segment_texts t WHERE t.source_id=${trustedSql(P.p1)} AND t.sha256 > decode(${trustedSql(P.p2)},'hex')
              AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=t.source_id AND m.sha256=t.sha256) ORDER BY t.sha256 LIMIT 4096) t) u
          WHERE u.before < ${trustedSql(P.p4)}),
        lowered AS MATERIALIZED (SELECT t.sha256, lower(convert_from(t.body,'UTF8')) AS body FROM page_segment_texts t
          WHERE t.source_id=${trustedSql(P.p1)} AND t.sha256 IN (SELECT sha256 FROM chunk)),
        gone AS (DELETE FROM page_segment_texts d WHERE d.source_id=${trustedSql(P.p1)}
            AND d.sha256 IN (SELECT l.sha256 FROM lowered l WHERE EXISTS (SELECT 1 FROM unnest(${trustedSql(P.p3)}::text[]) AS n WHERE strpos(l.body,n)>0))
            AND NOT EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.source_id=d.source_id AND m.sha256=d.sha256) AND NOT ${trustedSql(stagingNeedsTextSql('d'))}
          RETURNING d.sha256)
        SELECT (SELECT encode(sha256,'hex') FROM chunk ORDER BY sha256 DESC LIMIT 1) AS last, ARRAY(SELECT encode(sha256,'hex') FROM gone) AS deleted`);
  const [swept] = await engine.executeRaw<{ last: string | null; deleted: string[] }>(text, [sourceId, cursor, [...forms], chunkBytes]);
  return { last: swept?.last ?? null, deleted: [...swept?.deleted ?? []].sort(byText) };
}
