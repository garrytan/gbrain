/**
 * #6803 part 2: bounded resident projection selection. On master the
 * resident's selector walked the whole `page_projection_jobs` table in
 * `updated_at` order and probed each row's page, so every tick of every
 * resident probed all 93K undrainable image rows v153 queued. Each tick now
 * looks at most at `RESIDENT_PROBE_BUDGET` rows:
 *
 * 1. a recency lane: rows updated after `high water - 10 minutes` (newest
 *    first, at most `RESIDENT_RECENT_ROWS`), so a fresh edit behind a large
 *    queue, or a row whose writer transaction started before the previous
 *    tick, is reached within two ticks. The mark starts at `max(updated_at)`;
 *    the lane scans the queue table only, never `pages`.
 * 2. a primary-key window over the rest of the budget, from a per-process
 *    cursor that starts at a random key and wraps around, so every row
 *    (a `rebuild_failed` retry after its cooldown, a restored source's rows)
 *    is reached within one lap. The consumer's idle `hasWork` probe walks
 *    the same window and advances the same cursor.
 *
 * A bounded negative cache skips (source incarnation, slug, revision) of a page
 * whose kind the resident never builds (images: their seal is the importer's
 * or the explicit `gbrain projections drain`'s). Archive, missing-source and
 * cooldown states are never cached. The window and the recency lane bound the
 * inline selector only; the segmented route keeps its own probe and lease, and
 * the explicit drain keeps oldest-first.
 */
import { randomUUID } from 'node:crypto';

export const RESIDENT_PROBE_BUDGET = 500;
export const RESIDENT_RECENT_ROWS = 100;
const WINDOW_ROWS = RESIDENT_PROBE_BUDGET - RESIDENT_RECENT_ROWS;
const NEGATIVE_CACHE_MAX = 100_000;

export interface ProjectionScanCursor {
  /** The last primary key the window covered; the next window starts after it. */
  after: { source_incarnation: string; slug: string };
  /** `max(updated_at)` the previous selection saw (text), or null before the first. */
  highWater: string | null;
  /** Keys (incarnation, slug, revision) of pages whose kind the resident never builds. */
  ineligible: Set<string>;
}

export function newProjectionScanCursor(): ProjectionScanCursor {
  return { after: { source_incarnation: randomUUID(), slug: '' }, highWater: null, ineligible: new Set() };
}

const cursors = new WeakMap<object, ProjectionScanCursor>();

/** The per-process cursor of one engine, shared by its resident invocations and its consumer's idle probe. */
export function residentProjectionCursor(engine: object): ProjectionScanCursor {
  let cursor = cursors.get(engine);
  if (!cursor) cursors.set(engine, cursor = newProjectionScanCursor());
  return cursor;
}

export function ineligibleKey(row: { source_incarnation: string; slug: string; revision: string }): string {
  return `${row.source_incarnation}\u0000${row.slug}\u0000${row.revision}`;
}

export function rememberIneligible(cursor: ProjectionScanCursor, row: { source_incarnation: string; slug: string; revision: string }): void {
  if (cursor.ineligible.size >= NEGATIVE_CACHE_MAX) cursor.ineligible.clear();
  cursor.ineligible.add(ineligibleKey(row));
}

/**
 * The CTEs `recent` and `win` over `page_projection_jobs` for one cursor: each
 * row carries `lane` ('recent' or 'window') and `ord` (window order). `filter`
 * is an extra predicate over `j` (internal SQL); parameters are appended to
 * `params`. `high_water` (the queue's current `max(updated_at)`) rides along so
 * the caller can move the mark.
 */
export function residentWindowCtes(cursor: ProjectionScanCursor, params: unknown[], filter = 'TRUE'): string {
  const inc = params.push(cursor.after.source_incarnation);
  const slug = params.push(cursor.after.slug);
  const mark = params.push(cursor.highWater);
  const cols = 'j.source_incarnation,j.slug,j.revision,j.updated_at,j.reason';
  return `mark AS (SELECT COALESCE($${mark}::text::timestamptz,(SELECT max(updated_at) FROM page_projection_jobs)) AS at),
    recent AS (SELECT ${cols},'recent'::text AS lane,0 AS ord FROM page_projection_jobs j, mark
      WHERE j.updated_at > mark.at - interval '10 minutes' AND ${filter} ORDER BY j.updated_at DESC LIMIT ${RESIDENT_RECENT_ROWS}),
    fwd AS (SELECT ${cols} FROM page_projection_jobs j WHERE (j.source_incarnation,j.slug) > ($${inc}::uuid,$${slug}) AND ${filter}
      ORDER BY j.source_incarnation,j.slug LIMIT ${WINDOW_ROWS}),
    wrap AS (SELECT ${cols} FROM page_projection_jobs j WHERE (j.source_incarnation,j.slug) <= ($${inc}::uuid,$${slug}) AND ${filter}
      ORDER BY j.source_incarnation,j.slug LIMIT ${WINDOW_ROWS}),
    win AS (SELECT *,'window'::text AS lane,row_number() OVER (ORDER BY part,source_incarnation,slug) AS ord FROM (
      (SELECT *,0 AS part FROM fwd ORDER BY source_incarnation,slug) UNION ALL (SELECT *,1 AS part FROM wrap ORDER BY source_incarnation,slug)
      ORDER BY part,source_incarnation,slug LIMIT ${WINDOW_ROWS}) w),
    high_water AS (SELECT max(updated_at)::text AS at FROM page_projection_jobs)`;
}

/** Move the cursor past the window's last row a caller has finished with (none: the window was empty). */
export function advanceProjectionCursor(cursor: ProjectionScanCursor, last: { source_incarnation: string; slug: string } | null | undefined, highWater: string | null | undefined): void {
  if (last) cursor.after = { source_incarnation: String(last.source_incarnation), slug: String(last.slug) };
  if (highWater) cursor.highWater = highWater;
}
