/**
 * `gbrain repair timeline` (#5567): materialize database-only timeline rows on
 * pages that are never written again. Each page is re-published with its own
 * current body through a revision-bound `put_page`; preparation writes every
 * round-trippable bullet-less row back into the page as a marked bullet.
 * Rows that cannot round-trip are kept and reported, never deleted. Rows an
 * earlier stored version of the page produced and its current text dropped
 * are removals, not history (`timeline_orphans`, `extract timeline
 * --prune-orphans`), so they are not counted or materialized here.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { pendingTimelineRows } from '../persistence/canonical-projections.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { retractRemovedTimelineEntries } from '../timeline-extract.ts';
import { repairRequestId, type RepairHandler, type RepairItem, type RepairScope, type RepairCursor } from './core.ts';

interface TimelinePage { id: number; source_id: string; slug: string; compiled_truth: string; timeline: string | null }

const BATCH = 200;

/** Timeline rows of the page that an earlier stored version produced and its current text no longer does. */
async function removedRowIds(engine: BrainEngine, page: TimelinePage): Promise<Set<number>> {
  const removed = await retractRemovedTimelineEntries(engine, page.slug, page.source_id, `${page.compiled_truth}\n${page.timeline ?? ''}`, { dryRun: true });
  return new Set(removed.map(row => Number(row.id)));
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
      WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.id>$2
        AND EXISTS (SELECT 1 FROM timeline_entries t WHERE t.page_id=p.id AND t.event_page_id IS NULL)
      ORDER BY p.id LIMIT ${BATCH}`, [sourceIds, cursor]);
    for (const page of batch) {
      if ((budget.pages !== undefined && inspected >= budget.pages) || (budget.deadline !== undefined && Date.now() > budget.deadline)) {
        truncated = true;
        return { pages, inspected, truncated };
      }
      inspected++;
      cursor = page.id;
      const counts = await pendingTimelineRows(engine, { ...page, timeline: page.timeline ?? '' }, await removedRowIds(engine, page));
      if (counts.materializable || counts.unrenderable) pages.push({ ...page, ...counts });
    }
    if (batch.length < BATCH) return { pages, inspected, truncated };
  }
}

export const timelineRepair: RepairHandler = {
  kind: 'timeline',
  async plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null) {
    const { pages } = await scanTimelineHistory(engine, scope.source_ids, after?.id ?? 0);
    const items: RepairItem[] = pages.filter(p => p.materializable > 0).map(p => ({ cursor: { phase: 0, id: p.id }, source_id: p.source_id,
      slug: p.slug, chars: p.compiled_truth.length + (p.timeline ?? '').length, action: `materialize ${p.materializable} row(s)` }));
    return { items, residuals: {
      materializable_rows: pages.reduce((n, p) => n + p.materializable, 0),
      kept_unrenderable_rows: pages.reduce((n, p) => n + p.unrenderable, 0),
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
