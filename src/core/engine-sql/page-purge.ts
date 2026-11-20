/**
 * The reads and tombstone edits of a page purge (persistence/page-purge.ts) and of `gbrain pages purges list` and
 * `gbrain pages unpurge`: a page's claims (the facts filed on it or extracted from it, its takes), the belief streams
 * of its links, the queued purges behind one, its stored body and saved versions, what a hard delete cascades, the
 * claims its tombstones mirror, and the page, fact and take tombstones.
 *
 * A page's facts are `PAGE_FACTS`: those filed on it (`source_markdown_slug` is its slug) and those extracted from it
 * and filed on none (#8859, `extractedFromPageSql`). The outcome markers of the extraction checkpoints are never claims
 * (`outcomeMarkerSql`). Statements keep the caller's own hand-numbered placeholders (`P`). A Rust brain answers the same
 * rows from its records (src/core/rust-engine/store-members/page-purge.ts); where a statement has no order of its own
 * (`DISTINCT`, `UNION`), the function sorts so every engine lists the same order.
 */
import type { BrainEngine } from '../engine.ts';
import { outcomeMarkerSql } from '../facts/audit-sources.ts';
import { extractedFromPageSql } from '../facts/gone-page-facts.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

/** Hand-numbered placeholders spliced next to the vetted predicate builders, so the text keeps the caller's own `$N`. */
const P = { p1: '$1', p2: '$2', p3: '$3', p4: '$4' } as const;

/** #8859: the page's facts, `$1` its source and `$2` its slug: those filed on it and those extracted from it and filed on none. */
export const PAGE_FACTS = `(source_markdown_slug=${P.p2} OR ${extractedFromPageSql('facts', P.p2)})`;

export const PAGE_PURGE_TOMBSTONES_SQL = 'SELECT content_hash,slug FROM page_purges WHERE source_id=$1 ORDER BY purged_at DESC LIMIT $2';

/** A fact of the page as the journal sweep reads it. */
export interface PurgeClaimFactRow { id: number; fact: string; source: string | null }
/** A take of the page as the journal sweep reads it. */
export interface PurgeClaimTakeRow { id: number; claim: string }
/** A queued page purge of a source and the page at its slug (null when there is none). */
export interface QueuedPagePurgeRow { id: string; slug: string; page_id: number | null }
/** The page's stored body identity. */
export interface PurgePageBodyRow { content_hash: string | null; body_generation: number }
/** One distinct claim of the page a purge mirrors: its fingerprint, visibility and subject (the entity or `*`). */
export interface PageMirrorFactRow { fact_hash: string; visibility: string; subject: string }
/** What a hard delete of the page cascades. */
export interface PageCascadeCounts { chunks: number; versions: number; takes: number; timeline: number }
/** A saved version with the columns that give its body an import hash. */
export type PageVersionPurgeRow = Record<string, unknown>;
/** One page purge tombstone of `gbrain pages purges list`. */
export interface PagePurgeListRow { source_id: string; slug: string; content_hash: string; request_id: string | null; purged_at: string | Date }

/** The sort every engine lists an unordered statement's rows in: UTF-16 code unit order, as `Array.prototype.sort`. */
export const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The page's first 1000 facts by id: the journal sweep's claims. The caller drops outcome markers. */
export async function listPurgeClaimFacts(engine: RawSql, sourceId: string, slug: string): Promise<PurgeClaimFactRow[]> {
  const rows = await engine.executeRaw<{ id: number; fact: string; source: string | null }>(`SELECT id,fact,source FROM facts WHERE source_id=${P.p1} AND ${PAGE_FACTS} ORDER BY id LIMIT 1000`, [sourceId, slug]);
  return rows.map(r => ({ id: Number(r.id), fact: r.fact, source: r.source ?? null }));
}

/** The page's first 1000 takes by id. */
export async function listPurgeClaimTakes(engine: RawSql, pageId: number): Promise<PurgeClaimTakeRow[]> {
  const rows = await engine.executeRaw<{ id: number; claim: string }>('SELECT id,claim FROM takes WHERE page_id=$1 ORDER BY id LIMIT 1000', [pageId]);
  return rows.map(r => ({ id: Number(r.id), claim: r.claim }));
}

/** Every claim of the page, once and in text order: its facts (withdrawn ones included, outcome markers not) and its takes, untrimmed and unbounded. */
export async function listPurgeSegmentClaims(engine: RawSql, sourceId: string, slug: string, pageId: number): Promise<string[]> {
  const { text } = renderFragment(sqlFragment`SELECT fact AS c FROM facts WHERE source_id=${trustedSql(P.p1)} AND ${trustedSql(PAGE_FACTS)} AND NOT ${trustedSql(outcomeMarkerSql('facts'))} UNION SELECT claim FROM takes WHERE page_id=${trustedSql(P.p3)}`);
  const rows = await engine.executeRaw<{ c: string }>(text, [sourceId, slug, pageId]);
  return [...new Set(rows.map(r => r.c))].sort(byText);
}

/**
 * The queued purge requests (`delete_page` with `intent.purge` true) of the source after `afterSequence`, by sequence, up to
 * `limit`, each with the id of the page at its slug (null when no page has it).
 */
export async function listQueuedPagePurges(engine: RawSql, sourceId: string, afterSequence: string, limit: number): Promise<QueuedPagePurgeRow[]> {
  const rows = await engine.executeRaw<{ id: string; slug: string; page_id: number | null }>(`SELECT r.id::text AS id, r.slug, p.id AS page_id FROM persistence_requests r
    LEFT JOIN pages p ON p.source_id=r.source_id AND p.slug=r.slug
    WHERE r.state='queued' AND r.source_id=$1 AND r.sequence>$2::bigint AND r.operation='delete_page' AND r.intent->>'purge'='true' ORDER BY r.sequence LIMIT $3`,
  [sourceId, afterSequence, limit]);
  return rows.map(r => ({ id: r.id, slug: r.slug, page_id: r.page_id == null ? null : Number(r.page_id) }));
}

/** The slug of the belief stream of every link to or from the page (the origin page's slug when the link has one), once each, sorted. */
export async function listPageLinkStreams(engine: RawSql, sourceId: string, pageId: number): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(`SELECT DISTINCT COALESCE(o.slug, f.slug) AS slug FROM links l JOIN pages f ON f.id = l.from_page_id
    LEFT JOIN pages o ON o.id = l.origin_page_id WHERE (l.to_page_id = $2 OR l.from_page_id = $2) AND COALESCE(o.source_id, f.source_id) = $1`, [sourceId, pageId]);
  return rows.map(r => r.slug).sort(byText);
}

/** The page's facts (`PAGE_FACTS`: filed on it or extracted from it), all of them; how many. Writes facts; run it in the purge transaction. */
export async function deletePurgedPageFacts(engine: RawSql, sourceId: string, slug: string): Promise<number> {
  const { text } = renderFragment(sqlFragment`DELETE FROM facts WHERE source_id=${trustedSql(P.p1)} AND ${trustedSql(PAGE_FACTS)} RETURNING 1`);
  return (await engine.executeRaw(text, [sourceId, slug])).length;
}

/** The text-free fact tombstones of a page purge: one for each distinct claim the page holds that is not an outcome marker. Writes fact_purges; run it in the purge transaction. */
export async function insertPageFactPurges(engine: RawSql, sourceId: string, slug: string, requestId: string, actor: string): Promise<void> {
  const { text } = renderFragment(sqlFragment`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,request_id,actor,reason)
    SELECT DISTINCT source_id,visibility,COALESCE(entity_slug,'*'),gbrain_fact_fingerprint(fact),${trustedSql(P.p3)}::uuid,${trustedSql(P.p4)},'page purge'
    FROM facts WHERE source_id=${trustedSql(P.p1)} AND ${trustedSql(PAGE_FACTS)} AND NOT ${trustedSql(outcomeMarkerSql('facts'))} ON CONFLICT DO NOTHING`);
  await engine.executeRaw(text, [sourceId, slug, requestId, actor]);
}

/** The page's newest 1000 saved versions, newest first, with the columns that give each body its import hash. */
export async function listPageVersionBodiesForPurge(engine: RawSql, pageId: number): Promise<PageVersionPurgeRow[]> {
  return engine.executeRaw<PageVersionPurgeRow>(`SELECT title,type,compiled_truth,timeline,frontmatter,tags,body_storage,body_generation,content_hash
    FROM page_versions WHERE page_id=$1 ORDER BY id DESC LIMIT 1000`, [pageId]);
}

/** The page's stored content hash and body generation, or null when no page has the id. */
export async function readPurgePageBody(engine: RawSql, pageId: number): Promise<PurgePageBodyRow | null> {
  const [row] = await engine.executeRaw<{ content_hash: string | null; body_generation: number | string }>('SELECT content_hash,body_generation FROM pages WHERE id=$1', [pageId]);
  return row ? { content_hash: row.content_hash ?? null, body_generation: Number(row.body_generation) } : null;
}

/** Each distinct claim of the page that is not an outcome marker, as its tombstone mirror needs it, sorted by fingerprint, visibility and subject. */
export async function listPageMirrorFacts(engine: RawSql, sourceId: string, slug: string): Promise<PageMirrorFactRow[]> {
  const { text } = renderFragment(sqlFragment`SELECT DISTINCT gbrain_fact_fingerprint(fact) AS fact_hash,
    visibility, COALESCE(entity_slug,'*') AS subject FROM facts WHERE source_id=${trustedSql(P.p1)} AND ${trustedSql(PAGE_FACTS)} AND NOT ${trustedSql(outcomeMarkerSql('facts'))}`);
  const rows = await engine.executeRaw<PageMirrorFactRow>(text, [sourceId, slug]);
  return rows.map(r => ({ fact_hash: r.fact_hash, visibility: r.visibility, subject: r.subject }))
    .sort((a, b) => byText(a.fact_hash, b.fact_hash) || byText(a.visibility, b.visibility) || byText(a.subject, b.subject));
}

/** The fingerprint of each distinct take claim of the page, sorted. */
export async function listPageMirrorTakeHashes(engine: RawSql, pageId: number): Promise<string[]> {
  const rows = await engine.executeRaw<{ claim_hash: string }>('SELECT DISTINCT gbrain_fact_fingerprint(claim) AS claim_hash FROM takes WHERE page_id=$1', [pageId]);
  return rows.map(r => r.claim_hash).sort(byText);
}

/** How many chunks, versions, takes and timeline entries the page has: what its hard delete removes by cascade. */
export async function countPageCascadeRows(engine: RawSql, pageId: number): Promise<PageCascadeCounts> {
  // chunk-visibility-ok: counts every stored chunk row of the page, staged and retired included: the hard delete cascades them all
  const [row] = await engine.executeRaw<PageCascadeCounts>(`SELECT
    (SELECT count(*)::int FROM content_chunks WHERE page_id=$1) AS chunks, (SELECT count(*)::int FROM page_versions WHERE page_id=$1) AS versions,
    (SELECT count(*)::int FROM takes WHERE page_id=$1) AS takes, (SELECT count(*)::int FROM timeline_entries WHERE page_id=$1) AS timeline`, [pageId]);
  return { chunks: Number(row?.chunks ?? 0), versions: Number(row?.versions ?? 0), takes: Number(row?.takes ?? 0), timeline: Number(row?.timeline ?? 0) };
}

/** The distinct source paths of the page's saved versions, up to 64, sorted. */
export async function listPageVersionSourcePaths(engine: RawSql, pageId: number): Promise<string[]> {
  const rows = await engine.executeRaw<{ source_path: string | null }>('SELECT DISTINCT source_path FROM page_versions WHERE page_id=$1 AND source_path IS NOT NULL LIMIT 64', [pageId]);
  return rows.map(r => r.source_path).filter((p): p is string => !!p).sort(byText);
}

/** The source's page tombstones (content hash and slug), newest first, up to `limit`. */
export async function listPagePurgeTombstones(engine: RawSql, sourceId: string, limit: number): Promise<Array<{ content_hash: string; slug: string }>> {
  return engine.executeRaw<{ content_hash: string; slug: string }>(PAGE_PURGE_TOMBSTONES_SQL, [sourceId, limit]);
}

/** The page tombstones of `gbrain pages purges list`: those of one source, or of every source when `sourceId` is null, newest first, up to `limit`. */
export async function listPagePurgeRows(engine: RawSql, sourceId: string | null, limit: number): Promise<PagePurgeListRow[]> {
  return engine.executeRaw<PagePurgeListRow>(`SELECT source_id,slug,
      content_hash,request_id::text,purged_at FROM page_purges WHERE ($1::text IS NULL OR source_id=$1) ORDER BY purged_at DESC LIMIT $2`,
  [sourceId, limit]);
}

/**
 * Removes the source's page tombstones under the slug and returns each one's request id (null when it has none).
 * Run it in a transaction that holds the source row (`lockSourceRow`): a Rust brain admits one write transaction at a time.
 */
export async function deletePagePurgeTombstones(engine: RawSql, sourceId: string, slug: string): Promise<Array<string | null>> {
  const rows = await engine.executeRaw<{ request_id: string | null }>('DELETE FROM page_purges WHERE source_id=$1 AND slug=$2 RETURNING request_id::text', [sourceId, slug]);
  return rows.map(r => r.request_id ?? null);
}

/** Removes the source's fact tombstones of these purge requests (uuids); how many. */
export async function deleteFactPurgesByRequests(engine: RawSql, sourceId: string, requestIds: readonly string[]): Promise<number> {
  return (await engine.executeRaw('DELETE FROM fact_purges WHERE source_id=$1 AND request_id=ANY($2::uuid[]) RETURNING 1', [sourceId, [...requestIds]])).length;
}

/** Removes the source's take tombstones of these purge requests (uuids); how many. */
export async function deleteTakePurgesByRequests(engine: RawSql, sourceId: string, requestIds: readonly string[]): Promise<number> {
  return (await engine.executeRaw('DELETE FROM take_purges WHERE source_id=$1 AND request_id=ANY($2::uuid[]) RETURNING 1', [sourceId, [...requestIds]])).length;
}
