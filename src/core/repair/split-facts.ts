/**
 * `gbrain repair split-facts` (#6686, D8): merge the two `## Facts` fences of a
 * page whose fence lived below the timeline sentinel and to which a managed
 * writer before this release added a second fence above it. The merged fence
 * stays where the original one is (the timeline section), holding every row of
 * both fences under its own row number; the body fence goes, with the
 * `## Facts` heading the writer added when that heading holds nothing else.
 *
 * A page is kept, never guessed at, when a fence does not parse cleanly
 * (`unparsed`), when a row number appears in both fences (`row_collision`: a
 * person chooses which row keeps it), or when the merged page would not read
 * back exactly (`not_conserved`: the serialized page must split into the
 * intended body and timeline, carry no fence defect, and hold every before row
 * cell for cell). Explicit-only and preview-bound: the preview lists each page
 * with its revision under a hash; `--apply --expect <hash>` publishes exactly
 * that set through revision-bound `put_page`s (`changed_since_preview` when a
 * page moved). It never runs from `--all`, the remediation plan, the
 * maintenance cycle or an upgrade.
 *
 * A segmented page (Wave B) is not merged: this repair rewrites the whole body
 * as one string. A segmented page whose stored segments record a facts fence
 * in both its body and its timeline is listed (`segmented`) and kept.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { OperationError } from '../ops/contract.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { locateOutsideCode } from '../fence-scan.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, factsFenceSections, parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, type ParsedFact } from '../facts-fence.ts';
import { scanCanonicalFences } from '../fence-repair/refusal.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

type Residual = 'unparsed' | 'row_collision' | 'not_conserved';

const rowKey = (row: ParsedFact) => JSON.stringify(row);
const byRow = (a: ParsedFact, b: ParsedFact) => a.rowNum - b.rowNum;

/** The page body without its facts fence, and without the `## Facts` heading above it when that heading holds only the fence. */
function withoutBodyFence(body: string): string {
  const { beginIdx, endIdx } = locateOutsideCode(body, FACTS_FENCE_BEGIN, FACTS_FENCE_END);
  let before = body.slice(0, beginIdx);
  const after = body.slice(endIdx + FACTS_FENCE_END.length);
  if (/^\s*(#|$)/.test(after)) before = before.replace(/(^|\n)## Facts[ \t]*\n\s*$/, '$1');
  const head = before.trimEnd();
  const tail = after.trim() ? after.replace(/^\s+/, '') : '';
  return head && tail ? `${head}\n\n${tail}` : head || tail;
}

/** The merged page, or why it is kept; null when the page is not split. */
export function mergeSplitFacts(page: Page, tags: string[]): { compiled_truth: string; timeline: string } | { residual: Residual; rows?: number[] } | null {
  const held = factsFenceSections(page);
  if (!held.body || !held.timeline) return null;
  const body = parseFactsFence(page.compiled_truth), timeline = parseFactsFence(page.timeline ?? '');
  if (body.warnings.length || timeline.warnings.length) return { residual: 'unparsed' };
  const numbers = new Set(timeline.facts.map(row => row.rowNum));
  const collisions = [...new Set(body.facts.map(row => row.rowNum).filter(n => numbers.has(n)))].sort((a, b) => a - b);
  if (collisions.length) return { residual: 'row_collision', rows: collisions };
  const merged = [...timeline.facts, ...body.facts].sort(byRow);
  const next = { compiled_truth: withoutBodyFence(page.compiled_truth), timeline: replaceOrInsertFactsFence(page.timeline ?? '', renderFactsTable(merged)) };
  // The published bytes must read back as exactly this page: the same two sections, no fence defect, every before row.
  const reread = parseMarkdown(serializePageToMarkdown({ ...page, ...next }, tags), `${page.slug}.md`);
  const scan = scanCanonicalFences({ compiled_truth: reread.compiled_truth, timeline: reread.timeline });
  const conserved = reread.compiled_truth.trim() === next.compiled_truth.trim() && (reread.timeline ?? '').trim() === next.timeline.trim() && !scan.defects.length
    && JSON.stringify([...scan.facts].sort(byRow).map(rowKey)) === JSON.stringify(merged.map(rowKey))
    && !factsFenceSections(next).body;
  return conserved ? next : { residual: 'not_conserved' };
}

interface ApprovedPage { source_id: string; slug: string; id: number; revision: string }
interface SplitItem extends RepairItem { approved: ApprovedPage; hash: string; last: boolean }

function previewCommand(scope: RepairScope): string {
  return `gbrain repair split-facts${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
}

async function sourcesOf(engine: BrainEngine, scope: RepairScope) {
  return engine.executeRaw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
}

const hashOf = async (engine: BrainEngine, scope: RepairScope, pages: ApprovedPage[]) =>
  previewHash({ kind: 'split-facts-v1', brain_id: scope.brain_id, sources: await sourcesOf(engine, scope), selection: { source_ids: scope.source_ids }, pages });

function item(page: ApprovedPage, hash: string, last: boolean): SplitItem {
  return { cursor: { phase: 0, id: page.id }, source_id: page.source_id, slug: page.slug, chars: 0, action: 'merge the split ## Facts fences', approved: page, hash, last };
}

export const splitFactsRepair: RepairHandler = {
  kind: 'split-facts',
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (opts?.apply) {
      if (!opts.expect) throw new OperationError('invalid_params', 'gbrain repair split-facts --apply merges only the set a preview printed.',
        `Preview first: ${command} — show the user the listing, then run the apply command it prints: ${command} --apply --expect <preview-hash>`, 'docs/guides/repair.md#split-facts');
      const approved = await loadApprovedSet<ApprovedPage>(engine, { command: 'split-facts', hash: opts.expect, previewCommand: command,
        emptyHash: () => hashOf(engine, scope, []) });
      if (approved.items.some(page => !scope.source_ids.includes(page.source_id))) throw previewChangedError(opts.expect, command);
      return { items: approved.items.map((page, index) => item(page, opts.expect!, index === approved.items.length - 1)).filter(entry => afterCursor(entry.cursor, after)),
        preview_hash: opts.expect, residuals: {} };
    }
    const pages = await engine.executeRaw<{ id: number; source_id: string; slug: string }>(
      `SELECT id, source_id, slug FROM pages
        WHERE source_id=ANY($1::text[]) AND deleted_at IS NULL AND compiled_truth LIKE '%gbrain:facts:begin%' AND timeline LIKE '%gbrain:facts:begin%' ORDER BY id`,
      [scope.source_ids]);
    const residuals: Record<string, number> = {};
    const listing: NonNullable<RepairPlan['listing']> = [];
    const segmented = await engine.executeRaw<{ source_id: string; slug: string }>(`SELECT p.source_id, p.slug FROM pages p
      WHERE p.source_id=ANY($1::text[]) AND p.deleted_at IS NULL AND p.body_storage='segmented'
        AND EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=p.id AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.region='truth'
          AND m.protected_regions @> '[{"kind":"facts"}]'::jsonb)
        AND EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=p.id AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.region='timeline'
          AND m.protected_regions @> '[{"kind":"facts"}]'::jsonb)
      ORDER BY p.id`, [scope.source_ids]);
    for (const page of segmented) {
      residuals.segmented = (residuals.segmented ?? 0) + 1;
      listing.push({ item: `${page.source_id}:${page.slug}`, class: 'segmented',
        detail: 'the page stores its body in segments and this repair rewrites the whole body as one string; no command merges its fences yet' });
    }
    const merge: ApprovedPage[] = [];
    for (const page of pages) {
      const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
      if (!snapshot) continue;
      const verdict = mergeSplitFacts(snapshot.page, snapshot.tags);
      if (!verdict) continue;
      const label = `${page.source_id}:${page.slug} (revision ${snapshot.revision})`;
      if ('residual' in verdict) {
        residuals[verdict.residual] = (residuals[verdict.residual] ?? 0) + 1;
        listing.push({ item: label, class: verdict.residual, detail: verdict.residual === 'row_collision'
          ? `rows ${verdict.rows!.join(', ')} are numbered in both fences; edit the page so each number appears once, then preview again`
          : verdict.residual === 'unparsed' ? 'a fence does not parse cleanly; gbrain repair fences previews its repair' : 'the merged page would not read back exactly; merge the fences by hand' });
        continue;
      }
      merge.push({ source_id: page.source_id, slug: page.slug, id: page.id, revision: snapshot.revision });
      listing.push({ item: label, class: 'merge', detail: 'the body fence\'s rows move into the fence below the timeline sentinel' });
    }
    const hash = await hashOf(engine, scope, merge);
    if (merge.length) await saveApprovedSet<ApprovedPage>(engine, { command: 'split-facts', hash }, merge);
    return { items: merge.map((page, index) => item(page, hash, index === merge.length - 1)), preview_hash: hash, residuals, listing };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { approved, hash, last } = entry as SplitItem;
    const outcome = await mergeOne(ctx, entry, approved);
    if (last) await clearApprovedSet(ctx.engine, { command: 'split-facts', hash });
    return outcome;
  },
};

async function mergeOne(ctx: Parameters<RepairHandler['apply']>[0], entry: RepairItem, approved: ApprovedPage): Promise<RepairItemOutcome> {
  const snapshot = await ctx.engine.readPageSnapshot(approved.slug, { sourceId: approved.source_id });
  if (!snapshot || snapshot.revision !== approved.revision) return { applied: false, outcome: 'changed_since_preview', reason: 'the page changed since the preview' };
  const next = mergeSplitFacts(snapshot.page, snapshot.tags);
  if (!next || 'residual' in next) return { applied: false, outcome: 'changed_since_preview', reason: next ? next.residual : 'the page is no longer split' };
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: approved.slug, source_id: approved.source_id,
    content: serializePageToMarkdown({ ...snapshot.page, ...next }, snapshot.tags), expected_revision: snapshot.revision,
    request_id: await repairRequestId(ctx, 'split-facts', entry, snapshot.revision) } });
  return { applied: true, outcome: 'merged' };
}
