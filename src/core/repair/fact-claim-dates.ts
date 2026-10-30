/**
 * `gbrain repair fact-claim-dates --source <id> [--day YYYY-MM-DD]` (#7247): give facts that a bulk load dated with
 * the day it ran the date their own claim states.
 *
 * A one-time backfill wrote one date, the day it ran, into the valid_from cell of a large share of a source's facts.
 * Those dates record when the facts were loaded, not when they happened, so timelines put every such fact on one day.
 * The real dates are unknown, except where the claim states one: "Acme Example closed a seed round on 2025-03-14".
 *
 * Candidates are active facts of the source whose valid_from falls on a bulk day (`findBulkFactDays`, the rule doctor
 * `fact_bulk_dates` reports with, or the explicit --day) and whose claim states exactly one ISO date, a real calendar
 * date from 1900 up to the day before (`claimDate`). Facts without a date, with several, or with one out of range are
 * counted and left as they are, and so is a fact whose valid_until falls before its claim's date.
 *
 * A fact held by a page's facts fence (`row_num` on `source_markdown_slug`) is moved in the page: its row's valid_from
 * cell becomes the claim's date and the page is published through a revision-bound put_page, so the canonical file
 * stays the source of truth and the facts row is re-projected from it. Every other row and cell of the fence is kept;
 * a page is listed and kept when its fence does not parse, it has fences on both sides of the timeline sentinel
 * (`gbrain repair split-facts`), it is stored in segments, or the rewritten fence would not read back as exactly the
 * planned rows. A row whose fence cell no longer reads the bulk day is counted `fence_mismatch`. A database-only fact
 * (no fence row) takes a direct valid_from update on an unmanaged brain; on a managed brain it is counted
 * `database_only_managed` and kept, because a managed write never changes a fact the canonical files do not hold.
 *
 * Explicit-only, preview-bound and destructive: the preview writes nothing, lists every page and database-only group
 * with its rows, and prints a hash over the pages' revisions, row numbers and new dates. `--apply --expect <hash> --yes`
 * recomputes the plan first and refuses `preview_changed` when it differs, then applies exactly the saved set,
 * keeping a page that moved meanwhile as `changed_since_preview`. Nothing runs on upgrade, from --all or from the
 * remediation plan.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { factsFenceSection, factsFenceSections, normalizeClaimWhitespace, parseFactsFence, renderFactsTable, replaceOrInsertFactsFence } from '../facts-fence.ts';
import { claimDate, findBulkFactDays, type BulkFactDay } from '../facts/bulk-days.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

const DOCS = 'docs/guides/repair.md#fact-claim-dates';
/** Rows a listing line names before it counts the rest. */
const LISTED_ROWS = 5;

type Section = 'compiled_truth' | 'timeline';
interface PlannedRow { row: number; day: string; date: string }
interface PagePlan { source_id: string; slug: string; revision: string; section: Section; rows: PlannedRow[] }
interface FactsPlan { source_id: string; entity_slug: string | null; rows: Array<{ id: number; valid_from: string; day: string; date: string }> }
interface Selection { source_ids: string[]; day: string | null }
interface Approved { selection: Selection; page?: PagePlan; facts?: FactsPlan }
interface ClaimItem extends RepairItem { approved: Approved; hash: string; last: boolean }

interface FactRow { id: number | string; entity_slug: string | null; fact: string; row_num: number | string | null; source_markdown_slug: string | null;
  valid_from: string; valid_until_day: string | null }

interface Plan { hash: string; days: BulkFactDay[]; pages: PagePlan[]; facts: FactsPlan[]; residuals: Record<string, number>; listing: RepairListing[] }

const previewCommand = (sourceId: string, day: string | null) => `gbrain repair fact-claim-dates --source ${sourceId}${day ? ` --day ${day}` : ''}`;

/** The UTC day a fence valid_from cell projects to, read the way the fence projection reads it. */
function cellDay(cell: string | undefined): string | null {
  if (!cell) return null;
  const date = new Date(cell);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/**
 * The section's text with each planned row's valid_from cell set to its claim date, or null when the fence does not
 * parse cleanly, a planned row is gone, inactive or no longer on its bulk day, or the rewritten fence would not read
 * back as exactly the planned rows.
 */
function rewriteFence(page: Page, section: Section, rows: PlannedRow[]): string | null {
  const text = page[section] ?? '';
  const parsed = parseFactsFence(text);
  if (parsed.warnings.length) return null;
  const planned = new Map(rows.map(row => [row.row, row]));
  if (rows.some(row => { const fact = parsed.facts.find(f => f.rowNum === row.row); return !fact?.active || cellDay(fact.validFrom) !== row.day; })) return null;
  const next = parsed.facts.map(fact => planned.has(fact.rowNum) ? { ...fact, validFrom: planned.get(fact.rowNum)!.date } : fact);
  const rewritten = replaceOrInsertFactsFence(text, renderFactsTable(next));
  const reread = parseFactsFence(rewritten);
  return !reread.warnings.length && JSON.stringify(reread.facts) === JSON.stringify(next) ? rewritten : null;
}

const PAGE_RESIDUALS: Record<string, string> = {
  no_page: 'the page that holds these rows does not exist any more; nothing changed',
  segmented_page: 'the page stores its body in segments and this repair rewrites a fence by publishing the whole body; nothing changed',
  split_fences: 'the page has a facts fence on both sides of the timeline sentinel; merge them with gbrain repair split-facts, then preview again',
  unparsed: 'the facts fence does not parse cleanly; gbrain repair fences previews its repair, then preview again',
  not_conserved: 'the rewritten fence would not read back as exactly the planned rows; change these cells by hand',
};

/** The plan for one page's candidate rows: the rows to move, or the residual class that keeps the page. */
async function planPage(engine: BrainEngine, sourceId: string, slug: string, candidates: Array<{ row: FactRow; day: string; date: string }>,
  count: (key: string, n?: number) => void): Promise<{ plan: PagePlan } | { residual: string } | null> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return { residual: 'no_page' };
  if (isSegmentedPage(snapshot.page)) return { residual: 'segmented_page' };
  if (Object.values(factsFenceSections(snapshot.page)).every(Boolean)) return { residual: 'split_fences' };
  const section: Section = factsFenceSection(snapshot.page);
  const parsed = parseFactsFence(snapshot.page[section] ?? '');
  if (parsed.warnings.length) return { residual: 'unparsed' };
  const rows: PlannedRow[] = [];
  for (const { row, day, date } of candidates) {
    const fact = parsed.facts.find(f => f.rowNum === Number(row.row_num));
    if (fact?.active && cellDay(fact.validFrom) === day && normalizeClaimWhitespace(fact.claim) === normalizeClaimWhitespace(row.fact)) rows.push({ row: fact.rowNum, day, date });
    else count('fence_mismatch');
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a.row - b.row);
  if (rewriteFence(snapshot.page, section, rows) === null) return { residual: 'not_conserved' };
  return { plan: { source_id: sourceId, slug, revision: snapshot.revision, section, rows } };
}

/** The whole plan for one source and selection, read-only, with the hash an apply must match. */
async function buildPlan(engine: BrainEngine, scope: RepairScope, selection: Selection): Promise<Plan> {
  const sourceId = selection.source_ids[0]!;
  const days = selection.day ? [] : await findBulkFactDays(engine, [sourceId]);
  const dayList = selection.day ? [selection.day] : days.map(d => d.day);
  const managed = await managedPersistenceEnabled(engine);
  const residuals: Record<string, number> = {};
  const count = (key: string, n = 1) => { residuals[key] = (residuals[key] ?? 0) + n; };
  const byPage = new Map<string, Array<{ row: FactRow; day: string; date: string }>>();
  const byEntity = new Map<string, FactsPlan>();
  for (const day of dayList) {
    const rows = await engine.executeRaw<FactRow>(`SELECT f.id, f.entity_slug, f.fact, f.row_num, f.source_markdown_slug, f.valid_from::text AS valid_from,
        to_char(f.valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS valid_until_day
      FROM facts f WHERE f.source_id = $1 AND f.expired_at IS NULL AND (f.valid_from AT TIME ZONE 'UTC')::date = $2::date ORDER BY f.id`, [sourceId, day]);
    for (const row of rows) {
      const found = claimDate(row.fact, day);
      if ('skip' in found) { count(found.skip); continue; }
      if (row.valid_until_day !== null && row.valid_until_day < found.date) { count('ends_before_claim_date'); continue; }
      if (row.row_num !== null && row.source_markdown_slug) {
        byPage.set(row.source_markdown_slug, [...(byPage.get(row.source_markdown_slug) ?? []), { row, day, date: found.date }]);
      } else if (managed) count('database_only_managed');
      else {
        const key = row.entity_slug ?? '';
        const group = byEntity.get(key) ?? { source_id: sourceId, entity_slug: row.entity_slug, rows: [] };
        group.rows.push({ id: Number(row.id), valid_from: row.valid_from, day, date: found.date });
        byEntity.set(key, group);
      }
    }
  }
  const pages: PagePlan[] = [];
  const listing: RepairListing[] = [];
  for (const slug of [...byPage.keys()].sort()) {
    const candidates = byPage.get(slug)!;
    const verdict = await planPage(engine, sourceId, slug, candidates, count);
    if (!verdict) continue;
    if ('residual' in verdict) {
      count(verdict.residual, candidates.length);
      listing.push({ item: `${sourceId}:${slug}`, class: verdict.residual, detail: `${candidates.length} row(s): ${PAGE_RESIDUALS[verdict.residual]}` });
      continue;
    }
    pages.push(verdict.plan);
    const shown = verdict.plan.rows.slice(0, LISTED_ROWS).map(row => `#${row.row} ${row.day} -> ${row.date}`).join(', ');
    const more = verdict.plan.rows.length - LISTED_ROWS;
    listing.push({ item: `${sourceId}:${slug} (revision ${verdict.plan.revision})`, class: 'rewrite',
      detail: `${verdict.plan.rows.length} fence row(s) take the date their claim states: ${shown}${more > 0 ? ` (+${more} more)` : ''}` });
  }
  const facts = [...byEntity.values()].sort((a, b) => (a.entity_slug ?? '').localeCompare(b.entity_slug ?? ''));
  for (const group of facts) {
    listing.push({ item: `${sourceId}:${group.entity_slug ?? '(no entity)'}`, class: 'update',
      detail: `${group.rows.length} database-only fact(s) take the date their claim states: ${group.rows.slice(0, LISTED_ROWS).map(row => `fact ${row.id} -> ${row.date}`).join(', ')}` });
  }
  const [brain] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id = $1', [sourceId]);
  const hash = previewHash({ kind: 'fact-claim-dates-v1', brain_id: scope.brain_id, source: { id: sourceId, incarnation: brain?.incarnation ?? null }, selection,
    days: dayList, pages: pages.map(({ slug, revision, section, rows }) => ({ slug, revision, section, rows })), facts });
  return { hash, days, pages, facts, residuals, listing };
}

function dayWarnings(plan: Plan, selection: Selection): string[] {
  if (selection.day) return [`--day ${selection.day} selects the active facts of ${selection.source_ids[0]} whose valid_from falls on that UTC day.`];
  return plan.days.map(d => `${d.source_id}: ${d.day} holds ${d.facts} of ${d.source_facts} active facts (${Math.round(100 * d.facts / d.source_facts)}%) across `
    + `${d.entities} entities${d.top_sources.length ? `, most tagged ${d.top_sources.map(top => `${top.source} (${top.facts})`).join(', ')}` : ''}. `
    + 'These dates record when the facts were loaded, not when they happened.');
}

function item(approved: Approved, index: number, hash: string, last: boolean): ClaimItem {
  const slug = approved.page?.slug ?? approved.facts?.entity_slug ?? '(no entity)';
  const rows = approved.page?.rows.length ?? approved.facts?.rows.length ?? 0;
  return { cursor: { phase: 1, id: index }, source_id: (approved.page ?? approved.facts)!.source_id, slug, chars: 0,
    action: approved.page ? `move ${rows} fence row(s) to their claim date` : `move ${rows} database-only fact(s) to their claim date`, approved, hash, last };
}

export const factClaimDatesRepair: RepairHandler = {
  kind: 'fact-claim-dates',
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    if (scope.source_ids.length !== 1) {
      throw opError('invalid_params', 'gbrain repair fact-claim-dates needs --source <id>.',
        'A bulk load dates the facts of one source; name it, e.g. gbrain repair fact-claim-dates --source default.',
        { fix: readFix('Reports the bulk-dated days of every source, read-only.', { argv: ['gbrain', 'doctor', '--only', 'fact_bulk_dates', '--json'] }), docs: DOCS });
    }
    const selection: Selection = { source_ids: scope.source_ids, day: opts?.day ?? null };
    const command = previewCommand(scope.source_ids[0]!, selection.day);
    if (!opts?.apply) {
      const plan = await buildPlan(engine, scope, selection);
      const approved: Approved[] = [...plan.pages.map(page => ({ selection, page })), ...plan.facts.map(facts => ({ selection, facts }))];
      if (approved.length) await saveApprovedSet<Approved>(engine, { command: 'fact-claim-dates', hash: plan.hash }, approved);
      return { items: approved.map((entry, index) => item(entry, index, plan.hash, index === approved.length - 1)), preview_hash: plan.hash,
        residuals: plan.residuals, listing: plan.listing, warnings: dayWarnings(plan, selection) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair fact-claim-dates --apply moves only the set a preview printed.',
        `Preview first: ${command} — show the user the listing, then run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`, DOCS);
    }
    // A fresh apply recomputes the plan; a resumed one replays the saved set, whose finished items moved their pages.
    const fresh = after ? null : await buildPlan(engine, scope, selection);
    if (fresh && fresh.hash !== opts.expect) throw previewChangedError(opts.expect, command);
    const approved = await loadApprovedSet<Approved>(engine, { command: 'fact-claim-dates', hash: opts.expect, previewCommand: command,
      emptyHash: async () => (fresh ?? await buildPlan(engine, scope, selection)).hash });
    if (approved.items.some(entry => entry.selection.day !== selection.day || entry.selection.source_ids.join('\u0000') !== selection.source_ids.join('\u0000'))) {
      throw previewChangedError(opts.expect, command);
    }
    return { items: approved.items.map((entry, index) => item(entry, index, opts.expect!, index === approved.items.length - 1)).filter(entry => afterCursor(entry.cursor, after)),
      preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { approved, hash, last } = entry as ClaimItem;
    const outcome = approved.page ? await movePage(ctx, entry, approved.page) : await moveFacts(ctx.engine, approved.facts!);
    if (last) await clearApprovedSet(ctx.engine, { command: 'fact-claim-dates', hash });
    return outcome;
  },
};

async function movePage(ctx: Parameters<RepairHandler['apply']>[0], entry: RepairItem, plan: PagePlan): Promise<RepairItemOutcome> {
  const snapshot = await ctx.engine.readPageSnapshot(plan.slug, { sourceId: plan.source_id });
  if (!snapshot || snapshot.revision !== plan.revision || isSegmentedPage(snapshot.page)) {
    return { applied: false, outcome: 'changed_since_preview', reason: 'the page changed since the preview' };
  }
  const text = rewriteFence(snapshot.page, plan.section, plan.rows);
  if (text === null) return { applied: false, outcome: 'changed_since_preview', reason: 'the planned fence rows no longer read their bulk day' };
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: plan.slug, source_id: plan.source_id,
    content: serializePageToMarkdown({ ...snapshot.page, [plan.section]: text }, snapshot.tags), expected_revision: snapshot.revision,
    request_id: await repairRequestId(ctx, 'fact-claim-dates', entry, snapshot.revision) } });
  return { applied: true, outcome: 'rewritten', detail: { rows: plan.rows.length } };
}

/** Database-only facts on an unmanaged brain: one maintenance transaction; a fact edited since the preview is left alone. */
async function moveFacts(engine: BrainEngine, plan: FactsPlan): Promise<RepairItemOutcome> {
  if (await managedPersistenceEnabled(engine)) return { applied: false, outcome: 'changed_since_preview', reason: 'the brain is managed now; database-only facts are kept' };
  const moved = await maintenanceTransaction(engine, tx => tx.executeRaw<{ id: number | string }>(`UPDATE facts f
      SET valid_from = (r.date || 'T00:00:00Z')::timestamptz
     FROM jsonb_to_recordset($2::text::jsonb) AS r(id bigint, valid_from text, date text)
    WHERE f.source_id = $1 AND f.id = r.id AND f.valid_from = r.valid_from::timestamptz AND f.expired_at IS NULL AND f.row_num IS NULL
    RETURNING f.id`, [plan.source_id, JSON.stringify(plan.rows.map(({ id, valid_from, date }) => ({ id, valid_from, date })))]));
  if (!moved.length) return { applied: false, outcome: 'changed_since_preview', reason: 'every fact was edited or expired since the preview' };
  return { applied: true, outcome: 'updated', detail: { facts: moved.length }, ...(moved.length < plan.rows.length
    ? { reason: `${plan.rows.length - moved.length} fact(s) were edited or expired since the preview and kept` } : {}) };
}
