/**
 * `gbrain repair timeline-order` (#7247): put existing timelines back in date
 * order. Bulk imports and hand edits appended entries at the end of a page's
 * timeline, copied the same bullet twice, or started a second timeline
 * section; `add_timeline_entry` already inserts in date order
 * (`spliceTimelineBlock`), so only pages written before that need this.
 *
 * The text change is `orderTimeline` (timeline-order.ts, pure). Each planned
 * page must also read back exactly: the serialized page parses into the same
 * halves, is a fixed point of the repair, and projects the same timeline rows
 * (same tuples and details), so the publication never deletes, inserts or
 * rewrites a `timeline_entries` row. A removed exact duplicate shared its row
 * with the copy that stays, as it would after a hand edit removing it. A page
 * whose database-only rows the write would materialize (`editing` writer) is
 * kept until those are handled, so the publication adds nothing unplanned.
 *
 * Explicit-only and preview-bound: the preview lists each page with its
 * revision under a hash and writes nothing but the approval checkpoint;
 * `--apply --expect <hash> --yes` publishes exactly that set, one revision-bound
 * `put_page` per page with a request id derived from the hash, so the
 * coordinated write path publishes the canonical file (managed sources) and
 * re-projects the database from it. An apply whose pages moved since the
 * preview refuses `preview_changed` before anything is written. It never runs
 * from `--all`, the remediation plan, the maintenance cycle or an upgrade.
 * Segmented pages are counted, not rewritten.
 */
import type { BrainEngine, PageSnapshot } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { digest } from '../persistence/digest.ts';
import { pendingTimelineRows, storedCanonicalTimeline } from '../persistence/canonical-projections.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { orderTimeline, type TimelineOrderHold } from '../timeline-order.ts';
import { segmentedTimelineNote, segmentedTimelinePages } from './timeline.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

const BATCH = 200;
const DOCS = 'docs/guides/repair.md#timeline-order';

interface Selection { source_ids: string[]; slugs: string[] }
interface PlannedPage { source_id: string; slug: string; id: number; revision: string; moved: number; duplicates: number; sections_joined: number }
interface OrderItem extends RepairItem { page: PlannedPage; hash: string; last: boolean }
type Hold = TimelineOrderHold | 'pending_materialization';
type Verdict = { content: string; moved: number; duplicates: number; sections_joined: number } | { hold: Hold; rows?: number } | null;

const HOLD_TEXT: Record<Hold, string> = {
  unclosed_fence: 'a code fence in the timeline never closes',
  unclosed_comment: 'an HTML comment in the timeline never closes',
  lazy_continuation: 'a plain line directly under a bullet could belong to it',
  ambiguous_indent: 'a line under a bullet is indented by less than two spaces',
  detached_continuation: 'an indented line after a blank line under a bullet could belong to it',
  mixed_bullet_format: 'dated bullets in another format sit between the - **YYYY-MM-DD** | bullets',
  join_not_lossless: 'the timeline sections cannot be joined without moving prose or sub-headings',
  not_conserved: 'the reordered page would not read back with the same text order and timeline rows',
  pending_materialization: 'database-only timeline row(s) would be written into the page by the same write',
};

function previewCommand(scope: RepairScope, slugs: string[]): string {
  return `gbrain repair timeline-order${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}${slugs.map(slug => ` --slug ${slug}`).join('')}`;
}

const sourcesOf = (engine: BrainEngine, scope: RepairScope) => engine.executeRaw<{ id: string; incarnation: string }>(
  'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);

const hashOf = async (engine: BrainEngine, scope: RepairScope, selection: Selection, pages: PlannedPage[]) =>
  previewHash({ kind: 'timeline-order-v1', brain_id: scope.brain_id, sources: await sourcesOf(engine, scope), selection, pages });

/** One request id per page of an approved set: a resumed apply replays it, and the plan knows which pages already published. */
function requestIdOf(hash: string, page: Pick<PlannedPage, 'source_id' | 'slug' | 'revision'>): string {
  const h = digest(['timeline-order-request-v1', hash, page.source_id, page.slug, page.revision]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const rowsKey = (rows: Map<string, { date: string; source?: string | null; summary: string; detail?: string | null }>) =>
  JSON.stringify([...rows].map(([key, row]) => [key, row.date, row.source ?? '', row.summary, row.detail ?? '']).sort());

/** The page's repaired file, or why it is kept; null when its timeline is already in order. */
async function plannedChange(engine: BrainEngine, snapshot: PageSnapshot): Promise<Verdict> {
  const { page, tags } = snapshot;
  const result = orderTimeline(page);
  if (result.status === 'unchanged') return null;
  if (result.status === 'needs_human') return { hold: result.reason };
  const content = serializePageToMarkdown({ ...page, compiled_truth: result.compiled_truth, timeline: result.timeline }, tags);
  const reread = parseMarkdown(content, `${page.slug}.md`);
  const same = reread.compiled_truth.trim() === result.compiled_truth.trim() && (reread.timeline ?? '').trim() === result.timeline.trim()
    && orderTimeline(reread).status === 'unchanged'
    && rowsKey(await storedCanonicalTimeline(engine, page, page.slug)) === rowsKey(await storedCanonicalTimeline(engine, { ...page, ...reread }, page.slug));
  if (!same) return { hold: 'not_conserved' };
  const pending = await pendingTimelineRows(engine, { id: Number(page.id), slug: page.slug, compiled_truth: page.compiled_truth, timeline: page.timeline ?? '' });
  if (pending.materializable) return { hold: 'pending_materialization', rows: pending.materializable };
  return { content, moved: result.moved, duplicates: result.duplicates, sections_joined: result.sections_joined };
}

function holdDetail(hold: Hold, rows: number | undefined, scope: RepairScope): string {
  const source = scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : '';
  if (hold === 'pending_materialization') return `${rows} ${HOLD_TEXT[hold]}; run gbrain repair timeline${source}; for rows an edit removed, run `
    + 'gbrain extract timeline --prune-orphans; then preview again';
  return `${HOLD_TEXT[hold]}; fix the timeline by hand, then preview again`;
}

function changeDetail(page: PlannedPage): string {
  return [page.moved ? `moves ${page.moved} bullet(s) into date order` : '', page.duplicates ? `drops ${page.duplicates} exact duplicate bullet(s)` : '',
    page.sections_joined ? `joins ${page.sections_joined} later timeline section(s) into the first` : ''].filter(Boolean).join(', ');
}

/** Every inline page of the selection whose timeline the repair would change or keep for a person, in id order. Read-only. */
async function scan(engine: BrainEngine, scope: RepairScope, selection: Selection) {
  const planned: PlannedPage[] = [];
  const listing: RepairListing[] = [];
  const residuals: Record<string, number> = { pages_to_reorder: 0, duplicates_to_merge: 0, sections_to_join: 0, needs_human: 0, near_duplicates: 0 };
  for (let cursor = 0; ;) {
    const batch = await engine.executeRaw<{ id: number; source_id: string; slug: string; compiled_truth: string; timeline: string | null }>(
      `SELECT id, source_id, slug, compiled_truth, timeline FROM pages
        WHERE source_id=ANY($1::text[]) AND deleted_at IS NULL AND body_storage='inline' AND id>$2
          AND (timeline LIKE '%- **____-__-__**%' OR compiled_truth LIKE '%- **____-__-__**%')
          AND (cardinality($3::text[])=0 OR slug=ANY($3::text[]))
        ORDER BY id LIMIT ${BATCH}`, [scope.source_ids, cursor, selection.slugs]);
    for (const row of batch) {
      cursor = Number(row.id);
      const quick = orderTimeline(row);
      residuals.near_duplicates! += quick.near_duplicates;
      if (quick.status === 'unchanged') continue;
      const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
      if (!snapshot) continue;
      const verdict = await plannedChange(engine, snapshot);
      if (!verdict) continue;
      const label = `${row.source_id}:${row.slug} (revision ${snapshot.revision})`;
      if ('hold' in verdict) {
        residuals.needs_human!++;
        if (verdict.hold === 'pending_materialization') residuals.pending_materialization = (residuals.pending_materialization ?? 0) + 1;
        listing.push({ item: label, class: 'needs_human', detail: holdDetail(verdict.hold, verdict.rows, scope) });
        continue;
      }
      const page = { source_id: row.source_id, slug: row.slug, id: Number(row.id), revision: snapshot.revision,
        moved: verdict.moved, duplicates: verdict.duplicates, sections_joined: verdict.sections_joined };
      planned.push(page);
      if (page.moved) residuals.pages_to_reorder!++;
      residuals.duplicates_to_merge! += page.duplicates;
      residuals.sections_to_join! += page.sections_joined;
      listing.push({ item: label, class: 'reorder', detail: changeDetail(page) });
    }
    if (batch.length < BATCH) return { planned, listing, residuals };
  }
}

function item(page: PlannedPage, hash: string, last: boolean): OrderItem {
  return { cursor: { phase: 0, id: page.id }, source_id: page.source_id, slug: page.slug, chars: 0, action: changeDetail(page), page, hash, last };
}

export const timelineOrderRepair: RepairHandler = {
  kind: 'timeline-order',
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const selection: Selection = { source_ids: scope.source_ids, slugs: [...new Set(opts?.slugs ?? [])].sort() };
    const command = previewCommand(scope, selection.slugs);
    if (!opts?.apply) {
      const { planned, listing, residuals } = await scan(engine, scope, selection);
      const hash = await hashOf(engine, scope, selection, planned);
      if (planned.length) await saveApprovedSet<PlannedPage & { selection: Selection }>(engine, { command: 'timeline-order', hash }, planned.map(page => ({ ...page, selection })));
      const segmented = selection.slugs.length ? { pages: 0, rows: 0, sample: [] } : await segmentedTimelinePages(engine, scope.source_ids);
      if (segmented.pages) residuals.segmented_pages = segmented.pages;
      return { items: planned.map((page, index) => item(page, hash, index === planned.length - 1)), preview_hash: hash, residuals, listing,
        ...(segmented.pages ? { warnings: [`segmented_pages: ${segmentedTimelineNote(segmented)} gbrain repair timeline-order does not reorder them either.`] } : {}) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair timeline-order --apply reorders only the set a preview printed.',
        `Preview first: ${command} — show the user the listing, then run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, DOCS);
    }
    const expect = opts.expect;
    const approved = (await loadApprovedSet<PlannedPage & { selection: Selection }>(engine, { command: 'timeline-order', hash: expect, previewCommand: command,
      emptyHash: () => hashOf(engine, scope, selection, []) })).items;
    if (approved.some(page => digest(page.selection) !== digest(selection))) throw previewChangedError(expect, command);
    const pages = approved.map(({ selection: _selection, ...page }) => page);
    const published = new Set((await engine.executeRaw<{ request_id: string }>(
      "SELECT request_id::text AS request_id FROM persistence_requests WHERE request_id=ANY($1::uuid[]) AND state='committed'",
      [pages.map(page => requestIdOf(expect, page))])).map(row => row.request_id));
    // Every page not yet published under this hash still has the revision the user saw, or nothing is written.
    for (const page of pages) {
      if (published.has(requestIdOf(expect, page))) continue;
      const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
      if (snapshot?.revision !== page.revision || Number(snapshot.page.id) !== page.id) throw previewChangedError(expect, command);
    }
    return { items: pages.map((page, index) => item(page, expect, index === pages.length - 1)).filter(entry => afterCursor(entry.cursor, after)),
      preview_hash: expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { page, hash, last } = entry as OrderItem;
    try {
      const requestId = requestIdOf(hash, page);
      const [done] = await ctx.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
      const detail = { moved: page.moved, duplicates: page.duplicates, sections_joined: page.sections_joined };
      if (done?.state === 'committed') return { applied: true, outcome: 'reordered', detail };
      const snapshot = await ctx.engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
      if (!snapshot || snapshot.revision !== page.revision) return { applied: false, outcome: 'changed_since_preview', reason: 'the page changed since the preview' };
      const verdict = await plannedChange(ctx.engine, snapshot);
      if (!verdict || 'hold' in verdict) return { applied: false, outcome: 'changed_since_preview', reason: verdict ? verdict.hold : 'the timeline is already in order' };
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: page.slug, source_id: page.source_id, content: verdict.content,
        expected_revision: snapshot.revision, request_id: requestId } });
      return { applied: true, outcome: 'reordered', detail };
    } finally {
      if (last) await clearApprovedSet(ctx.engine, { command: 'timeline-order', hash });
    }
  },
};
