/**
 * `gbrain repair provenance` (#7891, #7918): put back the provenance stamps and lowering markers that writes removed
 * before #7892, and stamp the trust marker on classified pages whose file would re-read higher than the row.
 * trust/provenance-drift.ts decides which pages and what each one gets; every change only lowers.
 *
 * - `restore` (class `remote`, or `ambiguous` with `--include-ambiguous`): the stamps restored, the lost cap stamped
 *   back as the `trust_tier` marker, the page lowered to min(stored, marker), and a `lower_page` proposal filed
 *   (`gbrain trust review` confirms or reverts it), through the owner page write `trust_owner_page` mode
 *   `restore_provenance` (trust/page-handlers.ts `restorePageProvenance`).
 * - `restamp` (#7918): the stored tier stamped as the marker; the row keeps its tier (mode `repair_marker`).
 * - Listed, never written: `needs_review` (a later local write also changed the stamp), `local` (the owner's own
 *   edit), `ambiguous` without the flag.
 *
 * Explicit-only and preview-bound: the preview lists each page with its revision and planned change under a hash and
 * writes nothing but the approval checkpoint; `--apply --expect <hash> --yes` writes exactly that set, one owner page
 * write per page, bound to the previewed revision and change (`preview_changed` when either moved). On a managed
 * brain the write publishes the canonical file through the coordinator (Git stays the parent); on a repo-less brain
 * the database is the record. Local CLI only. It never runs from `--all`, the remediation plan or an upgrade.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { ownerRepairFile, repairPageMarker, restorePageProvenance } from '../trust/page-handlers.ts';
import { plannedDigest, readPageDrift, scanProvenanceDrift, type DriftItem } from '../trust/provenance-drift.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

const DOCS = 'docs/guides/repair.md#provenance';

interface Selection { source_ids: string[]; slugs: string[]; include_ambiguous: boolean }
interface PlannedPage { source_id: string; slug: string; id: number; revision: string; action: 'restore' | 'restamp'; planned: string; summary: string }
interface ProvenanceItem extends RepairItem { page: PlannedPage; hash: string; includeAmbiguous: boolean; last: boolean }

function previewCommand(scope: RepairScope, selection: Selection): string {
  return `gbrain repair provenance${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}${selection.slugs.map(slug => ` --slug ${slug}`).join('')}`
    + (selection.include_ambiguous ? ' --include-ambiguous' : '');
}

const sourcesOf = (engine: BrainEngine, scope: RepairScope) => engine.executeRaw<{ id: string; incarnation: string }>(
  'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);

const hashOf = async (engine: BrainEngine, scope: RepairScope, selection: Selection, pages: PlannedPage[]) =>
  previewHash({ kind: 'provenance-v1', brain_id: scope.brain_id, sources: await sourcesOf(engine, scope), selection,
    pages: pages.map(page => ({ source_id: page.source_id, id: page.id, revision: page.revision, action: page.action, planned: page.planned })) });

const describe = (value: unknown) => value === null || value === undefined ? '(none)' : String(value);

function summaryOf(item: DriftItem): string {
  const { verdict } = item;
  const restore = verdict.restore!;
  const stamps = Object.entries(restore.stamps).map(([key, value]) => {
    const live = verdict.changes.filter(change => change.key === key).at(-1)?.to;
    return `${key} ${describe(live)} -> ${describe(value)}`;
  });
  return [...stamps, `trust_tier marker -> ${describe(restore.marker)}`, `tier ${item.tier} -> ${restore.tier}`].join('; ');
}

function writerDetail(item: DriftItem): string {
  const change = item.verdict.changes.find(entry => entry.writer === item.verdict.writer) ?? item.verdict.changes[0];
  return change ? `written by a ${change.writer} write${change.request_id ? ` (request ${change.request_id})` : ''}` : '';
}

const segmented = async (engine: BrainEngine, pageId: number) =>
  (await engine.executeRaw<{ body_storage: string | null }>('SELECT body_storage FROM pages WHERE id = $1', [pageId]))[0]?.body_storage === 'segmented';

/** Every page of the selection the repair would write or list, in id order. Read-only. */
async function scan(engine: BrainEngine, scope: RepairScope, selection: Selection) {
  const planned: PlannedPage[] = [];
  const listing: RepairListing[] = [];
  const residuals: Record<string, number> = { restore: 0, restamp: 0, ambiguous: 0, needs_review: 0, local: 0 };
  const managedBrain = await managedPersistenceEnabled(engine);
  for (const sourceId of scope.source_ids) {
    const drift = await scanProvenanceDrift(engine, sourceId, { limit: Number.MAX_SAFE_INTEGER, includeAmbiguous: selection.include_ambiguous, slugs: selection.slugs });
    for (const item of drift.items) {
      const label = `${item.source_id}:${item.slug} (revision ${item.revision})`;
      const { verdict } = item;
      if (verdict.class === 'local') { residuals.local!++; listing.push({ item: label, class: 'local', detail: `the owner's own edit, never repaired; ${writerDetail(item)}` }); continue; }
      if (verdict.class === 'needs_review') { residuals.needs_review!++; listing.push({ item: label, class: 'needs_review', detail: `${verdict.reason}; edit the page by hand` }); continue; }
      if (!verdict.restore) {
        residuals.ambiguous!++;
        listing.push({ item: label, class: 'ambiguous', detail: `no recorded writer; previewed with --include-ambiguous only; ${writerDetail(item)}` });
        continue;
      }
      if (await segmented(engine, item.page_id)) {
        residuals.needs_review!++;
        listing.push({ item: label, class: 'needs_review', detail: 'the page stores its body in segments, which this repair does not rewrite; edit its frontmatter by hand' });
        continue;
      }
      const file = managedBrain ? null : await ownerRepairFile(engine, item.source_id, item.slug);
      if (file && !file.ok) {
        residuals.needs_review!++;
        listing.push({ item: label, class: 'needs_review', detail: file.reason === 'file_database_drift'
          ? 'the page file holds an edit the database lacks; run gbrain sync first, then preview again'
          : `the page file cannot be written (${file.reason}); fix the checkout, then preview again` });
        continue;
      }
      const action = verdict.class === 'restamp' ? 'restamp' : 'restore';
      residuals[action]!++;
      const page: PlannedPage = { source_id: item.source_id, slug: item.slug, id: item.page_id, revision: item.revision, action, planned: plannedDigest(item), summary: summaryOf(item) };
      planned.push(page);
      listing.push({ item: label, class: action === 'restamp' ? 'restamp' : verdict.class, detail: action === 'restamp' ? page.summary : `${page.summary}; ${writerDetail(item)}` });
    }
  }
  planned.sort((a, b) => a.id - b.id);
  return { planned, listing, residuals };
}

function item(page: PlannedPage, hash: string, includeAmbiguous: boolean, last: boolean): ProvenanceItem {
  return { cursor: { phase: 0, id: page.id }, source_id: page.source_id, slug: page.slug, chars: 0, action: page.summary, page, hash, includeAmbiguous, last };
}

/** The page still needs exactly the previewed change. */
async function stillPlanned(engine: BrainEngine, page: PlannedPage, includeAmbiguous: boolean): Promise<'planned' | 'done' | 'moved'> {
  const current = await readPageDrift(engine, page.source_id, page.slug, { includeAmbiguous });
  if (!current) return 'done';
  if (current.page_id !== page.id || !current.verdict.restore) return 'moved';
  return current.revision === page.revision && plannedDigest(current) === page.planned ? 'planned' : 'moved';
}

export const provenanceRepair: RepairHandler = {
  kind: 'provenance',
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const selection: Selection = { source_ids: scope.source_ids, slugs: [...new Set(opts?.slugs ?? [])].sort(), include_ambiguous: opts?.includeAmbiguous === true };
    const command = previewCommand(scope, selection);
    if (!opts?.apply) {
      const { planned, listing, residuals } = await scan(engine, scope, selection);
      const hash = await hashOf(engine, scope, selection, planned);
      if (planned.length) await saveApprovedSet<PlannedPage & { selection: Selection }>(engine, { command: 'provenance', hash }, planned.map(page => ({ ...page, selection })));
      return { items: planned.map((page, index) => item(page, hash, selection.include_ambiguous, index === planned.length - 1)), preview_hash: hash, residuals, listing };
    }
    if (opts.remote !== false) {
      throw opError('permission_denied', 'gbrain repair provenance --apply runs only from the local CLI on the brain host.', `Run it there: ${command}`);
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair provenance --apply writes only the set a preview printed.',
        `Preview first: ${command} — show the user the listing, then run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, DOCS);
    }
    const expect = opts.expect;
    const approved = (await loadApprovedSet<PlannedPage & { selection: Selection }>(engine, { command: 'provenance', hash: expect, previewCommand: command,
      emptyHash: () => hashOf(engine, scope, selection, []) })).items;
    const selectionKey = (value: Selection) => JSON.stringify([value.source_ids, value.slugs, value.include_ambiguous]);
    if (approved.some(page => selectionKey(page.selection) !== selectionKey(selection))) throw previewChangedError(expect, command);
    const pages: PlannedPage[] = [];
    // A page an earlier run of this apply already repaired is done; any other page must still need exactly the previewed change.
    for (const { selection: _selection, ...page } of approved) {
      const state = await stillPlanned(engine, page, selection.include_ambiguous);
      if (state === 'moved') throw previewChangedError(expect, command);
      if (state === 'planned') pages.push(page);
    }
    if (!pages.length) await clearApprovedSet(engine, { command: 'provenance', hash: expect });
    return { items: pages.map((page, index) => item(page, expect, selection.include_ambiguous, index === pages.length - 1)).filter(entry => afterCursor(entry.cursor, after)),
      preview_hash: expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { page, hash, includeAmbiguous, last } = entry as ProvenanceItem;
    try {
      if (await stillPlanned(ctx.engine, page, includeAmbiguous) !== 'planned') return { applied: false, outcome: 'changed_since_preview', reason: 'the page changed since the preview' };
      const input = { sourceId: page.source_id, slug: page.slug, expectedRevision: page.revision, confirmation: { via: 'preview_hash' as const }, config: ctx.config };
      const result = page.action === 'restamp' ? await repairPageMarker(ctx.engine, input)
        : await restorePageProvenance(ctx.engine, { ...input, planned: page.planned, includeAmbiguous });
      return { applied: true, outcome: page.action === 'restamp' ? 'restamped' : 'restored', detail: { tier: result.tier, prior_tier: result.prior_tier } };
    } finally {
      if (last) await clearApprovedSet(ctx.engine, { command: 'provenance', hash });
    }
  },
};
