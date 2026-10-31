/**
 * `gbrain repair contact-rows` (#8109): collapse duplicated frontmatter contact
 * rows. A writer that appended a `{type, value, last_used}` row on every touch
 * instead of updating the existing one left the same value many times; the
 * repair keeps one row per (type, value) with the newest `last_used`
 * (`dedupeContactRows`, contact-rows.ts), and never drops a distinct value.
 *
 * Explicit-only and preview-bound: the preview lists each page with its
 * revision and row counts under a hash and writes nothing but the approval
 * checkpoint; `--apply --expect <hash> --yes` publishes exactly that set, one
 * revision-bound `put_page` per page with a request id derived from the hash,
 * so a source with a checkout commits the canonical file through the
 * coordinated writer and a database-only (repo-less) source writes the
 * database. Only the `contacts` frontmatter key changes. A page whose canonical
 * file differs from the database is listed `needs_reconcile` with the
 * `--auto-additive` reconcile command (a `last_used`-only drift is
 * structurally additive), never written. Segmented pages are left alone. It
 * never runs from `--all`, the remediation plan, maintenance or an upgrade.
 */
import type { BrainEngine, PageSnapshot } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { dedupeFrontmatterContacts } from '../contact-rows.ts';
import { digest } from '../persistence/digest.ts';
import { liveFileDrift } from '../persistence/drift-conflicts.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

const BATCH = 200;
const DOCS = 'docs/guides/repair.md#contact-rows';

interface Selection { source_ids: string[]; slugs: string[] }
interface PlannedPage { source_id: string; slug: string; id: number; revision: string; rows_before: number; rows_after: number }
interface RowsItem extends RepairItem { page: PlannedPage; hash: string; last: boolean }

function previewCommand(scope: RepairScope, slugs: string[]): string {
  return `gbrain repair contact-rows${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}${slugs.map(slug => ` --slug ${slug}`).join('')}`;
}

const hashOf = async (engine: BrainEngine, scope: RepairScope, selection: Selection, pages: PlannedPage[]) => previewHash({ kind: 'contact-rows-v1', brain_id: scope.brain_id,
  sources: await engine.executeRaw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]),
  selection, pages });

/** One request id per page of an approved set: a resumed apply replays it, and the plan knows which pages already published. */
function requestIdOf(hash: string, page: Pick<PlannedPage, 'source_id' | 'slug' | 'revision'>): string {
  const h = digest(['contact-rows-request-v1', hash, page.source_id, page.slug, page.revision]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The page's repaired file, or null when its contact rows need no change or the rendered page would not read back with exactly those rows. */
function plannedChange(snapshot: PageSnapshot): { content: string; rows_before: number; rows_after: number } | null {
  const { page, tags } = snapshot;
  const deduped = dedupeFrontmatterContacts(page.frontmatter);
  if (!deduped) return null;
  const content = serializePageToMarkdown({ ...page, frontmatter: deduped.frontmatter }, tags);
  const reread = parseMarkdown(content, `${page.slug}.md`);
  const { contacts: _after, ...restAfter } = reread.frontmatter;
  const { contacts: _before, ...restBefore } = page.frontmatter;
  if (digest(reread.frontmatter.contacts) !== digest(deduped.dedupe.rows) || digest(restAfter) !== digest(restBefore)
    || reread.compiled_truth.trim() !== page.compiled_truth.trim() || (reread.timeline ?? '').trim() !== (page.timeline ?? '').trim()) return null;
  return { content, rows_before: (page.frontmatter.contacts as unknown[]).length, rows_after: deduped.dedupe.rows.length };
}

const reconcileCommand = (page: Pick<PlannedPage, 'source_id' | 'slug'>) => `gbrain sources reconcile ${page.source_id} ${page.slug} --brain host --preview --auto-additive`;

/** Every inline page of the selection whose contact rows the repair would collapse, in id order. Read-only. */
async function scan(engine: BrainEngine, scope: RepairScope, selection: Selection) {
  const planned: PlannedPage[] = [];
  const listing: RepairListing[] = [];
  const residuals: Record<string, number> = { pages_to_dedupe: 0, rows_to_remove: 0, needs_reconcile: 0 };
  for (let cursor = 0; ;) {
    const batch = await engine.executeRaw<{ id: number; source_id: string; slug: string }>(
      `SELECT id, source_id, slug FROM pages
        WHERE source_id=ANY($1::text[]) AND deleted_at IS NULL AND body_storage='inline' AND id>$2
          AND jsonb_typeof(frontmatter->'contacts')='array' AND jsonb_array_length(frontmatter->'contacts')>1
          AND (cardinality($3::text[])=0 OR slug=ANY($3::text[]))
        ORDER BY id LIMIT ${BATCH}`, [scope.source_ids, cursor, selection.slugs]);
    for (const row of batch) {
      cursor = Number(row.id);
      const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
      const change = snapshot && plannedChange(snapshot);
      if (!snapshot || !change) continue;
      const page = { source_id: row.source_id, slug: row.slug, id: Number(row.id), revision: snapshot.revision, rows_before: change.rows_before, rows_after: change.rows_after };
      const label = `${row.source_id}:${row.slug} (revision ${snapshot.revision})`;
      if ((await liveFileDrift(engine, row.source_id, row.slug, snapshot)).still_present === true) {
        residuals.needs_reconcile!++;
        listing.push({ item: label, class: 'needs_reconcile', detail: `its canonical file differs from the database; preview ${reconcileCommand(page)}, apply it, then preview this repair again` });
        continue;
      }
      planned.push(page);
      residuals.pages_to_dedupe!++;
      residuals.rows_to_remove! += page.rows_before - page.rows_after;
      listing.push({ item: label, class: 'dedupe', detail: `${page.rows_before} contact rows become ${page.rows_after}` });
    }
    if (batch.length < BATCH) return { planned, listing, residuals };
  }
}

function item(page: PlannedPage, hash: string, last: boolean): RowsItem {
  return { cursor: { phase: 0, id: page.id }, source_id: page.source_id, slug: page.slug, chars: 0, action: `collapses ${page.rows_before} contact rows to ${page.rows_after}`, page, hash, last };
}

export const contactRowsRepair: RepairHandler = {
  kind: 'contact-rows',
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const selection: Selection = { source_ids: scope.source_ids, slugs: [...new Set(opts?.slugs ?? [])].sort() };
    const command = previewCommand(scope, selection.slugs);
    if (!opts?.apply) {
      const { planned, listing, residuals } = await scan(engine, scope, selection);
      const hash = await hashOf(engine, scope, selection, planned);
      if (planned.length) await saveApprovedSet<PlannedPage & { selection: Selection }>(engine, { command: 'contact-rows', hash }, planned.map(page => ({ ...page, selection })));
      return { items: planned.map((page, index) => item(page, hash, index === planned.length - 1)), preview_hash: hash, residuals, listing };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair contact-rows --apply rewrites only the set a preview printed.',
        `Preview first: ${command} — show the user the listing, then run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, DOCS);
    }
    const expect = opts.expect;
    const approved = (await loadApprovedSet<PlannedPage & { selection: Selection }>(engine, { command: 'contact-rows', hash: expect, previewCommand: command,
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
    const { page, hash, last } = entry as RowsItem;
    try {
      const requestId = requestIdOf(hash, page);
      const detail = { rows_before: page.rows_before, rows_after: page.rows_after };
      const [done] = await ctx.engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
      if (done?.state === 'committed') return { applied: true, outcome: 'deduped', detail };
      const snapshot = await ctx.engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
      if (!snapshot || snapshot.revision !== page.revision) return { applied: false, outcome: 'changed_since_preview', reason: 'the page changed since the preview' };
      const change = plannedChange(snapshot);
      if (!change) return { applied: false, outcome: 'changed_since_preview', reason: 'the contact rows need no change' };
      try {
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: page.slug, source_id: page.source_id, content: change.content,
          expected_revision: snapshot.revision, request_id: requestId } });
      } catch (error) {
        if (!(error instanceof OperationError) || error.code !== 'source_changed' || error.detail !== 'file_database_drift') throw error;
        return { applied: false, outcome: 'needs_reconcile', reason: `the canonical file differs from the database; preview ${reconcileCommand(page)}, apply it, then preview this repair again` };
      }
      return { applied: true, outcome: 'deduped', detail };
    } finally {
      if (last) await clearApprovedSet(ctx.engine, { command: 'contact-rows', hash });
    }
  },
};
