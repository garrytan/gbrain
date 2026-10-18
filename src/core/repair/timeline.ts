/**
 * `gbrain repair timeline` (#5567): materialize database-only timeline rows on
 * pages that are never written again. Each page is re-published with its own
 * current body through a revision-bound `put_page`; preparation writes every
 * round-trippable bullet-less row back into the page as a marked bullet.
 * Rows that cannot round-trip are kept and reported, never deleted. Rows an
 * earlier stored version of the page produced and its current text dropped
 * are removals, not history (`timeline_orphans`, `extract timeline
 * --prune-orphans`), so they are not counted or materialized here.
 *
 * Only inline pages are classified and repaired: a segmented page (Wave B)
 * keeps its body in segments and this repair re-publishes the whole body as
 * one string. Segmented pages carrying timeline rows are counted and named
 * as a residual (`segmentedTimelinePages`) instead.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { pendingTimelineRows } from '../persistence/canonical-projections.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { retractRemovedTimelineEntries, type StoredTimelineTuple } from '../timeline-extract.ts';
import { repairRequestId, type RepairHandler, type RepairItem, type RepairScope, type RepairCursor } from './core.ts';

interface TimelinePage { id: number; source_id: string; slug: string; compiled_truth: string; timeline: string | null }

const BATCH = 200;

/** Timeline rows of the page that an earlier stored version produced and its current text no longer does. */
async function removedRowIds(engine: BrainEngine, page: TimelinePage, storedRows?: ReadonlyArray<StoredTimelineTuple>): Promise<Set<number>> {
  const removed = await retractRemovedTimelineEntries(engine, page.slug, page.source_id, `${page.compiled_truth}\n${page.timeline ?? ''}`, { dryRun: true, storedRows });
  return new Set(removed.map(row => Number(row.id)));
}

/** The non-event timeline rows of each page, read once per batch (the retraction check's own per-page read). */
async function storedRowsByPage(engine: BrainEngine, pages: readonly TimelinePage[]): Promise<Map<number, StoredTimelineTuple[]>> {
  const byPage = new Map<number, StoredTimelineTuple[]>(pages.map(page => [Number(page.id), []]));
  if (!pages.length) return byPage;
  const rows = await engine.executeRaw<StoredTimelineTuple & { page_id: number }>(`SELECT t.page_id, t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.source, t.summary, t.detail
    FROM timeline_entries t WHERE t.page_id = ANY($1::bigint[]) AND t.event_page_id IS NULL`, [pages.map(page => page.id)]);
  for (const { page_id, ...row } of rows) byPage.get(Number(page_id))?.push(row);
  return byPage;
}

async function classifyTimelinePage(engine: BrainEngine, page: TimelinePage, storedRows?: ReadonlyArray<StoredTimelineTuple>) {
  return pendingTimelineRows(engine, { ...page, timeline: page.timeline ?? '' }, await removedRowIds(engine, page, storedRows));
}

/** Current counts for specific pages (doctor rechecks pages an earlier run of a multi-run pass found). */
export async function recountTimelinePages(engine: BrainEngine, sourceIds: string[], ids: number[]) {
  if (ids.length === 0) return [];
  const pages = await engine.executeRaw<TimelinePage>(`SELECT p.id,p.source_id,p.slug,p.compiled_truth,p.timeline FROM pages p
    WHERE p.id = ANY($1::bigint[]) AND p.source_id=ANY($2::text[]) AND p.deleted_at IS NULL AND p.body_storage='inline'`, [ids, sourceIds]);
  const stored = await storedRowsByPage(engine, pages);
  const counted = [];
  for (const page of pages) counted.push({ id: page.id, ...await classifyTimelinePage(engine, page, stored.get(Number(page.id))) });
  return counted;
}

/**
 * Pages carrying non-event timeline rows, in id order after `afterId`, each
 * classified exactly. `budget` caps the pages inspected (doctor's bound).
 */
export async function scanTimelineHistory(engine: BrainEngine, sourceIds: string[], afterId: number,
  budget: { pages?: number; deadline?: number } = {}) {
  const pages: Array<TimelinePage & { materializable: number; unrenderable: number }> = [];
  let cursor = afterId, inspected = 0, truncated = false;
  for (;;) {
    const batch = await engine.executeRaw<TimelinePage>(`SELECT p.id,p.source_id,p.slug,p.compiled_truth,p.timeline FROM pages p
      WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.id>$2 AND p.body_storage='inline'
        AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id=p.id AND t.event_page_id IS NULL)
      ORDER BY p.id LIMIT ${BATCH}`, [sourceIds, cursor]);
    const stored = await storedRowsByPage(engine, batch);
    for (const page of batch) {
      if ((budget.pages !== undefined && inspected >= budget.pages) || (budget.deadline !== undefined && Date.now() > budget.deadline)) {
        truncated = true;
        return { pages, inspected, truncated, cursor };
      }
      inspected++;
      cursor = page.id;
      const counts = await classifyTimelinePage(engine, page, stored.get(Number(page.id)));
      if (counts.materializable || counts.unrenderable) pages.push({ ...page, ...counts });
    }
    if (batch.length < BATCH) return { pages, inspected, truncated, cursor };
  }
}

/** Slugs a segmented-page residual names (the counts cover every page). */
export const SEGMENTED_SAMPLE = 10;

/**
 * Segmented pages carrying non-event timeline rows: this repair cannot classify or
 * materialize them (it re-publishes the whole body as one string), so they are
 * counted, with their rows, and the first SEGMENTED_SAMPLE are named.
 */
export async function segmentedTimelinePages(engine: BrainEngine, sourceIds: string[]): Promise<{ pages: number; rows: number; sample: string[] }> {
  const [counts] = await engine.executeRaw<{ pages: number; rows: number }>(`SELECT count(DISTINCT p.id)::int AS pages, count(*)::int AS rows
    FROM timeline_entries t JOIN pages p ON p.id=t.page_id
    WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.body_storage='segmented' AND t.event_page_id IS NULL`, [sourceIds]);
  if (!counts?.pages) return { pages: 0, rows: 0, sample: [] };
  const named = await engine.executeRaw<{ source_id: string; slug: string }>(`SELECT p.source_id, p.slug FROM pages p
    WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.body_storage='segmented'
      AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id=p.id AND t.event_page_id IS NULL)
    ORDER BY p.id LIMIT ${SEGMENTED_SAMPLE}`, [sourceIds]);
  return { pages: Number(counts.pages), rows: Number(counts.rows), sample: named.map(page => `${page.source_id}:${page.slug}`) };
}

/** The sentence a preview or doctor prints for segmented pages carrying timeline rows. */
export function segmentedTimelineNote(segmented: { pages: number; rows: number; sample: string[] }): string {
  return `${segmented.rows} timeline row(s) on ${segmented.pages} segmented page(s) (${segmented.sample.join(', ')}${segmented.pages > segmented.sample.length ? ', …' : ''}) `
    + 'are not checked for a bullet in their page or materialized: gbrain repair timeline re-publishes a whole body as one string, so it does not handle segmented pages, '
    + 'and no command does yet. The rows are kept as-is.';
}

export const timelineRepair: RepairHandler = {
  kind: 'timeline',
  async plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null) {
    const { pages } = await scanTimelineHistory(engine, scope.source_ids, after?.id ?? 0);
    const items: RepairItem[] = pages.filter(p => p.materializable > 0).map(p => ({ cursor: { phase: 0, id: p.id }, source_id: p.source_id,
      slug: p.slug, chars: p.compiled_truth.length + (p.timeline ?? '').length, action: `materialize ${p.materializable} row(s)` }));
    const [{ n: markup }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM timeline_entries t JOIN pages p ON p.id=t.page_id
      WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND t.event_page_id IS NULL
        AND (t.summary LIKE '%<!--%' OR t.summary LIKE '%-->%' OR t.source LIKE '%<!--%' OR t.source LIKE '%-->%')`, [scope.source_ids]);
    // #6184: such rows are never rendered back (they would duplicate a section END marker); name the cleanup.
    const warnings = markup ? [`timeline_comment_markup: ${markup} timeline row(s) carry HTML comment markup and stay database-side; `
      + `preview the cleanup with gbrain repair timeline-comments${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}.`] : [];
    const segmented = await segmentedTimelinePages(engine, scope.source_ids);
    if (segmented.pages) warnings.push(`segmented_pages: ${segmentedTimelineNote(segmented)}`);
    return { ...(warnings.length ? { warnings } : {}), items, residuals: {
      materializable_rows: pages.reduce((n, p) => n + p.materializable, 0),
      kept_unrenderable_rows: pages.reduce((n, p) => n + p.unrenderable, 0),
      ...(segmented.pages ? { segmented_pages: segmented.pages, segmented_rows: segmented.rows } : {}),
    } };
  },
  async apply(ctx, item) {
    const snapshot = await ctx.engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
    if (!snapshot) return false;
    const counts = await pendingTimelineRows(ctx.engine, { ...snapshot.page, timeline: snapshot.page.timeline ?? '' }, await removedRowIds(ctx.engine, snapshot.page));
    if (!counts.materializable) return false;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: item.slug, source_id: item.source_id,
      content: serializePageToMarkdown(snapshot.page, snapshot.tags), expected_revision: snapshot.revision,
      request_id: await repairRequestId(ctx, 'timeline', item, snapshot.revision) } });
    return true;
  },
};
