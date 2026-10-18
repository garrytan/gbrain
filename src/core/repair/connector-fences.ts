/**
 * `gbrain repair connector-fences` (fix wave 4 lane B): move a facts or takes
 * fence that sits below the timeline sentinel of a connector (Google, GitHub)
 * page back into the page body, so the next connector re-render carries it
 * instead of refusing with `connector_fence_below_timeline`. Each page is
 * republished with its own rows through a revision-bound `put_page`; a page
 * whose fences are ambiguous (duplicated, unbalanced or unparseable) is kept
 * and counted for a manual edit, never guessed at.
 *
 * A segmented page (Wave B) is not moved: this repair rewrites the whole body
 * as one string. Its timeline region is searched block by block for a fence
 * marker, and each such page is counted (`segmented_pages`) and named.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { conceptPreservationHold } from '../cycle/concept-publication.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, replaceOrInsertFactsFence } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence } from '../takes-fence.ts';
import { segmentedRegionContains } from '../page-body/segment-lines.ts';
import { SEGMENTED_SAMPLE } from './timeline.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairScope, type RepairCursor } from './core.ts';

const count = (text: string, marker: string) => text.split(marker).length - 1;

/**
 * The page with every below-sentinel fence moved into its body, or null when
 * nothing needs moving or the move would be ambiguous or lossy.
 */
export function relocateTimelineFences(page: { compiled_truth: string | null; timeline: string | null }): { compiled_truth: string; timeline: string } | null {
  let body = page.compiled_truth ?? '';
  let timeline = page.timeline ?? '';
  let moved = false;
  for (const [begin, end] of [[FACTS_FENCE_BEGIN, FACTS_FENCE_END], [TAKES_FENCE_BEGIN, TAKES_FENCE_END]] as const) {
    if (!timeline.includes(begin) && !timeline.includes(end)) continue;
    if (count(timeline, begin) !== 1 || count(timeline, end) !== 1 || count(body, begin) || count(body, end)) return null;
    const start = timeline.indexOf(begin);
    const stop = timeline.indexOf(end, start);
    if (stop === -1) return null;
    const block = timeline.slice(start, stop + end.length);
    timeline = `${timeline.slice(0, start)}${timeline.slice(stop + end.length)}`.replace(/\n{3,}/g, '\n\n').trim();
    body = begin === FACTS_FENCE_BEGIN ? replaceOrInsertFactsFence(body, block).trimEnd() : `${body.trimEnd()}\n\n## Takes\n\n${block}`;
    moved = true;
  }
  if (!moved) return null;
  const next = { compiled_truth: body, timeline };
  if (conceptPreservationHold(next)) return null;
  const rows = (text: string) => JSON.stringify({ facts: parseFactsFence(text).facts, takes: parseTakesFence(text).takes });
  if (rows(body) !== rows(`${page.compiled_truth ?? ''}\n\n${page.timeline ?? ''}`)) return null;
  return next;
}

interface FencePage { id: number; source_id: string; slug: string; compiled_truth: string; timeline: string | null }

const FENCE_MARKERS = ['gbrain:facts:', 'gbrain:takes:'];

async function candidates(engine: BrainEngine, sourceIds: string[]): Promise<FencePage[]> {
  return engine.executeRaw<FencePage>(`SELECT p.id,p.source_id,p.slug,p.compiled_truth,p.timeline FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND s.config->>'kind' IN ('google','github')
      AND (p.timeline LIKE '%gbrain:facts:%' OR p.timeline LIKE '%gbrain:takes:%') ORDER BY p.id`, [sourceIds]);
}

/** Segmented connector pages whose timeline region holds a facts or takes fence marker, as `source:slug`. */
async function segmentedCandidates(engine: BrainEngine, sourceIds: string[], after: RepairCursor | null): Promise<string[]> {
  const pages = await engine.executeRaw<{ id: number; source_id: string; slug: string }>(`SELECT p.id,p.source_id,p.slug FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND s.config->>'kind' IN ('google','github') AND p.body_storage='segmented' ORDER BY p.id`, [sourceIds]);
  const found: string[] = [];
  for (const page of pages) {
    if (!afterCursor({ phase: 0, id: Number(page.id) }, after)) continue;
    if (await segmentedRegionContains(engine, page, 'timeline', FENCE_MARKERS)) found.push(`${page.source_id}:${page.slug}`);
  }
  return found;
}

export const connectorFencesRepair: RepairHandler = {
  kind: 'connector-fences',
  async plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null) {
    const pages = (await candidates(engine, scope.source_ids)).filter(page => afterCursor({ phase: 0, id: page.id }, after));
    const items: RepairItem[] = [];
    let ambiguous = 0;
    for (const page of pages) {
      if (!relocateTimelineFences(page)) { ambiguous++; continue; }
      items.push({ cursor: { phase: 0, id: page.id }, source_id: page.source_id, slug: page.slug,
        chars: page.compiled_truth.length + (page.timeline ?? '').length, action: 'move fences above the timeline' });
    }
    const segmented = await segmentedCandidates(engine, scope.source_ids, after);
    const warnings = segmented.length ? [`segmented_pages: ${segmented.length} segmented connector page(s) (${segmented.slice(0, SEGMENTED_SAMPLE).join(', ')}`
      + `${segmented.length > SEGMENTED_SAMPLE ? ', …' : ''}) hold a facts or takes fence below the timeline and are left as they are: this repair rewrites a whole body `
      + 'as one string, so it does not handle segmented pages, and no command does yet.'] : [];
    return { ...(warnings.length ? { warnings } : {}), items, residuals: { kept_ambiguous_pages: ambiguous, ...(segmented.length ? { segmented_pages: segmented.length } : {}) } };
  },
  async apply(ctx, item) {
    const snapshot = await ctx.engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
    if (!snapshot) return false;
    const next = relocateTimelineFences(snapshot.page);
    if (!next) return false;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: item.slug, source_id: item.source_id,
      content: serializePageToMarkdown({ ...snapshot.page, ...next }, snapshot.tags), expected_revision: snapshot.revision,
      request_id: await repairRequestId(ctx, 'connector-fences', item, snapshot.revision) } });
    return true;
  },
};
