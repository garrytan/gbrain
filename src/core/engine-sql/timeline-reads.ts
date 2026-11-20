/**
 * Timeline reads and checks: doctor's effective-date sample and timeline-history clock, the canonical projection's
 * stored-timeline read and row delete, `gbrain repair timeline`'s batched row read, segmented-page residual and
 * comment-markup count, and `extract timeline --prune-orphans`' page walk, which ran through `engine.executeRaw`, once
 * for both engines.
 *
 * Every statement here ran on master from the caller named on its function. They keep master's predicates and run on
 * master's raw path (`exec.executeRaw`) unscoped, as before. A statement with a value is built with `sqlFragment`, so
 * each value is a bound parameter. The order of every read is master's: where master left it to the plan, it still is.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment, trustedSql } from './fragment.ts';
import { rows } from './search-reads.ts';

/** Doctor's effective-date sample: the newest 1000 pages by id, soft-deleted pages included (master's window). */
export interface EffectiveDateSampleCounts { future_dated: number; pre_1990: number }

/** A sampled page whose effective date fell back although its frontmatter names a date key. */
export interface EffectiveDateFallbackRow { slug: string; frontmatter: unknown; created_at: Date; updated_at: Date }

/** A page's own (non-event) timeline row: `date` is `YYYY-MM-DD`. */
export interface OwnTimelineRow { id: number; date: string; source: string; summary: string; detail: string }

/** A stored timeline row keyed by its page (`gbrain repair timeline`'s batch read). */
export interface PageTimelineRow extends OwnTimelineRow { page_id: number }

/** A stored row the projection deletes when it still matches: `removed` marks a row the new body dropped. */
export interface TimelineRowDeletion { id: number; date: string; source: string; summary: string; detail: string; removed: boolean }

/** Segmented live pages that carry non-event timeline rows: their count, their rows, and the first `limit` pages. */
export interface SegmentedTimelinePages { pages: number; rows: number; sample: Array<{ source_id: string; slug: string }> }

/** A live page with non-event timeline rows, as the orphan prune reads it (master's row type: a segmented page's body columns are NULL). */
export interface TimelineOrphanPage {
  id: number; slug: string; source_id: string; compiled_truth: string; timeline: string | null; body_storage: string; revision: string;
}

/** A page's own (non-event) timeline rows, in date order (the canonical projection's stored-timeline read). */
export const STORED_TIMELINE_SQL = 'SELECT id,date::text AS date,source,summary,detail FROM timeline_entries WHERE page_id=$1 AND event_page_id IS NULL ORDER BY date,id';

/** Future-dated (more than a year ahead) and inferred pre-1990 effective dates in the newest 1000 pages (doctor). */
export async function sampleEffectiveDates(exec: LegacyUnscopedRead): Promise<EffectiveDateSampleCounts> {
  const result = await exec.executeRaw<{ kind: string; count: string }>(
    `WITH sample AS (
       SELECT effective_date, effective_date_source
         FROM pages
        ORDER BY id DESC
        LIMIT 1000
     )
     SELECT 'future_dated' AS kind, COUNT(*)::text AS count FROM sample
      WHERE effective_date IS NOT NULL AND effective_date > NOW() + INTERVAL '1 year'
     UNION ALL
     SELECT 'pre_1990', COUNT(*)::text FROM sample
      WHERE effective_date IS NOT NULL AND effective_date < TIMESTAMPTZ '1990-01-01'
        AND COALESCE(effective_date_source, '') NOT IN ('event_date', 'date', 'published', 'created')`,
  );
  const counts = new Map(result.map(r => [r.kind, Number(r.count)]));
  return { future_dated: counts.get('future_dated') ?? 0, pre_1990: counts.get('pre_1990') ?? 0 };
}

/**
 * Pages of the newest 1000 whose effective date fell back (`effective_date_source = 'fallback'`) while their
 * frontmatter has an `event_date`, `date` or `published` key (doctor re-parses each in JS).
 */
export async function sampleEffectiveDateSources(exec: LegacyUnscopedRead): Promise<EffectiveDateFallbackRow[]> {
  return exec.executeRaw<EffectiveDateFallbackRow>(
    `WITH sample AS (
       SELECT slug, frontmatter, effective_date_source, created_at, updated_at
         FROM pages
        ORDER BY id DESC
        LIMIT 1000
     )
     SELECT slug, frontmatter, created_at, updated_at
       FROM sample
      WHERE effective_date_source = 'fallback'
        AND (frontmatter ? 'event_date' OR frontmatter ? 'date' OR frontmatter ? 'published')`,
  );
}

/** The largest timeline entry id, 0 with none (doctor timeline_history's scan clock). */
export async function readMaxTimelineEntryId(exec: LegacyUnscopedRead): Promise<number> {
  const [row] = await exec.executeRaw<{ max_entry: number | string }>('SELECT COALESCE(max(id), 0) AS max_entry FROM timeline_entries');
  return Number(row?.max_entry ?? 0);
}

/** STORED_TIMELINE_SQL: the page's own (non-event) timeline rows, in date then id order. */
export async function listStoredTimelineRowsOrdered(exec: LegacyUnscopedRead, pageId: number): Promise<OwnTimelineRow[]> {
  return exec.executeRaw<OwnTimelineRow>(STORED_TIMELINE_SQL, [pageId]);
}

/**
 * Deletes the page's non-event rows named in `deletions` that still match on id, date, source, summary and detail;
 * returns each deleted row's date (`YYYY-MM-DD`) with its `removed` mark (the canonical projection, inside its
 * transaction). The statement is sent before this returns, so a pipelined transaction keeps its order.
 */
export function deleteTimelineRows(exec: SqlExecutor, pageId: number, deletions: readonly TimelineRowDeletion[]): Promise<Array<{ date: string; removed: boolean }>> {
  const json = JSON.stringify(deletions);
  return exec.executeRaw<{ date: string; removed: boolean }>(`DELETE FROM timeline_entries t USING jsonb_to_recordset($2::text::jsonb) AS d(id integer,date date,source text,summary text,detail text,removed boolean)
        WHERE t.page_id=$1 AND t.event_page_id IS NULL AND t.id=d.id AND t.date=d.date AND t.source=d.source
          AND t.summary=d.summary AND t.detail=d.detail RETURNING t.date::text AS date, d.removed`, [pageId, json]);
}

/** The non-event timeline rows of `pageIds`, in the database's own order (`gbrain repair timeline`, one read per batch). */
export async function storedTimelineRowsByPageIds(exec: LegacyUnscopedRead, pageIds: readonly number[]): Promise<PageTimelineRow[]> {
  if (!pageIds.length) return [];
  return exec.executeRaw<PageTimelineRow>(`SELECT t.page_id, t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.source, t.summary, t.detail
    FROM timeline_entries t WHERE t.page_id = ANY($1::bigint[]) AND t.event_page_id IS NULL`, [[...pageIds]]);
}

/**
 * Live segmented pages of `sourceIds` carrying non-event timeline rows: the page and row counts and, when there is one,
 * the first `limit` pages by id (`gbrain repair timeline`'s residual). `limit` is the integer literal the caller's
 * statement spelled (`LIMIT 10`), so the text sent is the caller's text.
 */
export async function countSegmentedTimelinePages(exec: LegacyUnscopedRead, sourceIds: readonly string[], limit: number): Promise<SegmentedTimelinePages> {
  if (!Number.isFinite(limit) || !Number.isSafeInteger(limit) || limit < 0) throw new Error(`countSegmentedTimelinePages: limit must be a non-negative integer, got ${limit}`);
  const [counts] = await exec.executeRaw<{ pages: number; rows: number }>(`SELECT count(DISTINCT p.id)::int AS pages, count(*)::int AS rows
    FROM timeline_entries t JOIN pages p ON p.id=t.page_id
    WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.body_storage='segmented' AND t.event_page_id IS NULL`, [[...sourceIds]]);
  if (!counts?.pages) return { pages: 0, rows: 0, sample: [] };
  const sample = await rows<{ source_id: string; slug: string }>(exec, sqlFragment`SELECT p.source_id, p.slug FROM pages p
    WHERE p.source_id=ANY(${[...sourceIds]}::text[]) AND p.deleted_at IS NULL AND p.body_storage='segmented'
      AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id=p.id AND t.event_page_id IS NULL)
    ORDER BY p.id LIMIT ${trustedSql(`${limit}`)}`);
  return { pages: Number(counts.pages), rows: Number(counts.rows), sample };
}

/** Non-event timeline rows on live pages of `sourceIds` whose summary or source carries HTML comment markup (#6184). */
export async function countTimelineCommentMarkupRows(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM timeline_entries t JOIN pages p ON p.id=t.page_id
      WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND t.event_page_id IS NULL
        AND (t.summary LIKE '%<!--%' OR t.summary LIKE '%-->%' OR t.source LIKE '%<!--%' OR t.source LIKE '%-->%')`, [[...sourceIds]]);
  return Number(row?.n ?? 0);
}

/**
 * Live pages after `afterId` (optionally in `sourceId`) that hold non-event timeline rows, in id order, at most `limit`
 * (`pruneTimelineOrphans`). `revision` is `knowledge_revision` as text.
 */
export async function listTimelineOrphanPages(exec: LegacyUnscopedRead, opts: { afterId: number; limit: number; sourceId?: string }): Promise<TimelineOrphanPage[]> {
  const source = opts.sourceId ? sqlFragment` AND p.source_id = ${opts.sourceId}` : sqlFragment``;
  return rows<TimelineOrphanPage>(exec, sqlFragment`SELECT p.id, p.slug, p.source_id, p.compiled_truth, p.timeline, p.body_storage, p.knowledge_revision::text AS revision FROM pages p
      WHERE p.id > ${opts.afterId} AND p.deleted_at IS NULL${source}
        AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id = p.id AND t.event_page_id IS NULL)
      ORDER BY p.id LIMIT ${opts.limit}`);
}
