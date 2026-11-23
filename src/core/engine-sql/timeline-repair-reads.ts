/**
 * The page and row scans of `gbrain repair timeline`, `timeline-comments`, `timeline-order` and `connector-fences`,
 * the stored-version reads of the timeline retraction check (timeline-extract.ts `retractRemovedTimelineEntries`) and
 * the row rewrite of `timeline-comments`, moved here from those modules so the Rust engine can serve them as typed
 * members (rust/crates/gbrain-store/src/timeline_queries/repair_reads.rs). PGLite and Postgres run master's
 * statements unscoped through executeRaw, as before; each value is a bound parameter.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { rows } from './search-reads.ts';

/** An inline page with its body, as the timeline repair classifies it. */
export interface TimelineRepairPage { id: number; source_id: string; slug: string; compiled_truth: string; timeline: string | null }

/**
 * Which pages `listTimelineHistoryPages` reads: `afterId` the live inline pages past an id holding non-event timeline
 * rows, at most `limit`; `ids` those live inline pages (any rows). Both by id, in `sourceIds`.
 */
export type TimelineHistoryQuery = { afterId: number; limit: number } | { ids: readonly number[] };

/** One stored version of a page as the retraction check walks it: newest first. */
export interface TimelineVersionWitness { id: number; body_storage: string; page_id: number; generation: number | null; content_hash: string | null }

/** One inline version body and the md5 of each part (`head` the compiled truth, `tail` the timeline or ''). */
export interface TimelineVersionBody { compiled_truth: string; timeline: string | null; head: string; tail: string }

/** A non-event timeline row on a live page whose summary, source or detail carries HTML comment markup. */
export interface TimelineMarkupRow { id: number; page_id: number; source_id: string; slug: string; date: string; source: string; summary: string; detail: string; body_storage: string }

/** Which markup rows `listTimelineMarkupRows` reads: those on pages of `sourceIds` past `afterId`, or on page `pageId`. */
export type TimelineMarkupQuery = { sourceIds: readonly string[]; afterId: number } | { pageId: number };

/** The text a `timeline-comments` rewrite gives one row. */
export interface TimelineRowRewrite { id: number; source: string; summary: string; detail: string }

/** A connector page `connector-fences` reads: its body (null columns on a segmented page). */
export interface ConnectorFencePage { id: number; source_id: string; slug: string; compiled_truth: string; timeline: string | null }

const MARKUP = `(t.summary LIKE '%<!--%' OR t.summary LIKE '%-->%' OR t.source LIKE '%<!--%' OR t.source LIKE '%-->%'
  OR t.detail LIKE '%<!--%' OR t.detail LIKE '%-->%')`;

/** The pages `q` names (repair timeline's scan and doctor's recount). */
export async function listTimelineHistoryPages(exec: LegacyUnscopedRead, sourceIds: readonly string[], q: TimelineHistoryQuery): Promise<TimelineRepairPage[]> {
  const found = 'ids' in q
    ? await rows<TimelineRepairPage>(exec, sqlFragment`SELECT p.id,p.source_id,p.slug,p.compiled_truth,p.timeline FROM pages p
    WHERE p.id = ANY(${q.ids.map(Number)}::bigint[]) AND p.source_id=ANY(${[...sourceIds]}::text[]) AND p.deleted_at IS NULL AND p.body_storage='inline'`)
    : await rows<TimelineRepairPage>(exec, sqlFragment`SELECT p.id,p.source_id,p.slug,p.compiled_truth,p.timeline FROM pages p
      WHERE p.source_id=ANY(${[...sourceIds]}::text[]) AND p.deleted_at IS NULL AND p.id>${q.afterId} AND p.body_storage='inline'
        AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id=p.id AND t.event_page_id IS NULL)
      ORDER BY p.id LIMIT ${Math.max(1, Math.floor(q.limit))}`);
  return found.map(page => ({ ...page, id: Number(page.id) }));
}

/** The stored versions of the page at (sourceId, slug), in any state, newest first. */
export async function listTimelineVersionWitnesses(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<TimelineVersionWitness[]> {
  const found = await exec.executeRaw<TimelineVersionWitness>(
    `SELECT v.id, v.body_storage, v.page_id, v.body_generation AS generation, v.content_hash FROM page_versions v JOIN pages p ON p.id = v.page_id
        WHERE p.source_id = $1 AND p.slug = $2 ORDER BY v.id DESC`, [sourceId, slug]);
  return found.map(row => ({ ...row, id: Number(row.id), page_id: Number(row.page_id), generation: row.generation === null ? null : Number(row.generation) }));
}

/** Version `versionId` of page `pageId`: its body and the md5 of each part, or null. */
export async function readTimelineVersionBody(exec: LegacyUnscopedRead, pageId: number, versionId: number): Promise<TimelineVersionBody | null> {
  const [body] = await exec.executeRaw<TimelineVersionBody>(
    `SELECT compiled_truth, timeline, md5(compiled_truth) AS head, md5(coalesce(timeline, '')) AS tail FROM page_versions WHERE id = $1 AND page_id = $2`, [versionId, pageId]);
  return body ?? null;
}

/** The markup rows `q` names, by page id then row id. */
export async function listTimelineMarkupRows(exec: LegacyUnscopedRead, q: TimelineMarkupQuery): Promise<TimelineMarkupRow[]> {
  const where = 'pageId' in q ? sqlFragment`t.page_id=${q.pageId}` : sqlFragment`p.source_id=ANY(${[...q.sourceIds]}::text[]) AND p.id>${q.afterId}`;
  const found = await rows<TimelineMarkupRow>(exec, sqlFragment`SELECT t.id, t.page_id, p.source_id, p.slug, t.date::text AS date, t.source, t.summary, t.detail, p.body_storage
    FROM timeline_entries t JOIN pages p ON p.id=t.page_id
    WHERE t.event_page_id IS NULL AND p.deleted_at IS NULL AND ${trustedSql(MARKUP)} AND ${where} ORDER BY t.page_id, t.id`);
  return found.map(row => ({ ...row, id: Number(row.id), page_id: Number(row.page_id) }));
}

/** Live pages of `sourceIds` past `afterId` whose body holds a materialized-row marker, by id. */
export async function listMaterializedMarkerPages(exec: LegacyUnscopedRead, sourceIds: readonly string[], afterId: number): Promise<TimelineRepairPage[]> {
  const found = await exec.executeRaw<TimelineRepairPage>(`SELECT id, source_id, slug, compiled_truth, timeline FROM pages WHERE source_id=ANY($1::text[]) AND deleted_at IS NULL AND id>$2
         AND (compiled_truth LIKE '%gbrain:materialized%' OR timeline LIKE '%gbrain:materialized%') ORDER BY id`, [[...sourceIds], afterId]);
  return found.map(page => ({ ...page, id: Number(page.id) }));
}

/** Sets the source, summary and detail of page `pageId`'s own timeline row `row.id` (timeline-comments' rewrite). */
export async function rewriteTimelineRow(exec: SqlExecutor, pageId: number, row: TimelineRowRewrite): Promise<void> {
  await exec.executeRaw('UPDATE timeline_entries SET source=$3, summary=$4, detail=$5 WHERE id=$1 AND page_id=$2 AND event_page_id IS NULL',
    [row.id, pageId, row.source, row.summary, row.detail]);
}

/**
 * Live inline pages of `sourceIds` past `afterId` whose body holds a dated bullet (`- **____-__-__**`), limited to
 * `slugs` when that is not empty, by id, at most `limit` (timeline-order's scan).
 */
export async function listDateBulletPages(exec: LegacyUnscopedRead, sourceIds: readonly string[], afterId: number, slugs: readonly string[], limit: number): Promise<TimelineRepairPage[]> {
  const found = await exec.executeRaw<TimelineRepairPage>(`SELECT id, source_id, slug, compiled_truth, timeline FROM pages
        WHERE source_id=ANY($1::text[]) AND deleted_at IS NULL AND body_storage='inline' AND id>$2
          AND (timeline LIKE '%- **____-__-__**%' OR compiled_truth LIKE '%- **____-__-__**%')
          AND (cardinality($3::text[])=0 OR slug=ANY($3::text[]))
        ORDER BY id LIMIT $4`, [[...sourceIds], afterId, [...slugs], Math.max(1, Math.floor(limit))]);
  return found.map(page => ({ ...page, id: Number(page.id) }));
}

/**
 * Live pages of `sourceIds` in a source whose `config.kind` is one of `kinds`, by id: with `segmented` the segmented
 * pages (body columns null), else the pages whose timeline holds a facts or takes fence marker.
 */
export async function listConnectorFencePages(exec: LegacyUnscopedRead, sourceIds: readonly string[], kinds: readonly string[], segmented: boolean): Promise<ConnectorFencePage[]> {
  const found = await exec.executeRaw<ConnectorFencePage>(segmented
    ? `SELECT p.id,p.source_id,p.slug,p.compiled_truth,p.timeline FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND s.config->>'kind' = ANY($2::text[]) AND p.body_storage='segmented' ORDER BY p.id`
    : `SELECT p.id,p.source_id,p.slug,p.compiled_truth,p.timeline FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND s.config->>'kind' = ANY($2::text[])
      AND (p.timeline LIKE '%gbrain:facts:%' OR p.timeline LIKE '%gbrain:takes:%') ORDER BY p.id`, [[...sourceIds], [...kinds]]);
  return found.map(page => ({ ...page, id: Number(page.id) }));
}
