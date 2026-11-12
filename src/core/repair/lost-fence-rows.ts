/**
 * `gbrain repair lost-fence-rows`: put back the fact and take rows an older gbrain retired after a page rewrite dropped
 * their `## Facts` or takes section. The rewrite itself was safe: the rows stayed live, held `fence_absent`. But the
 * next `remember`, `takes_add`, fact extraction or `facts relink` built a new section holding only its own rows, and the write
 * after that read the new section as the user's answer: the facts expired and the takes were deleted, with no receipt.
 * Those writers now carry the held rows (unfenced-facts.ts `withHeldFactsFence`, takes-prepare.ts); this repair brings
 * back the rows they already lost.
 *
 * A row is listed only when the records prove that shape:
 *   1. a fact_fence or take_fence generation retired it (`derived_generation_items`, action `retired`) without an
 *      empty-fence or deleted-page proof, and the fact was live when it did (a take is deleted outright);
 *   2. no live fact with the same claim and visibility (no take with the same claim) is on the page now, and the fact's
 *      claim is not withdrawn (forget) or purged;
 *   3. page history holds the claim in a fence (at any row number, so a later re-add counts), and the newest body
 *      holding it is followed by one with no fence of that kind at all: the section vanished, then came back without
 *      it. A claim removed later from a section that stayed (an edit, a forget strike, a takes_remove) is not listed. A row an edit removed from
 *      a fence that stayed in place is a deliberate removal and is never listed.
 * The fence cell comes from the newest version that held it, byte for byte; a row number now taken gets the next free
 * one. A page with no fence of that kind today also carries its held rows, as the append does.
 *
 * Explicit-only and preview-bound: the preview lists each page with the rows it would restore and writes nothing but the
 * approval checkpoint; `--apply --expect <hash> --yes` republishes exactly that set, one revision-bound `put_page` per
 * page, so the page projection re-derives the rows. A restored fact is a new facts row (the expired one stays as
 * history), lowered to the trust tier the expired row had; a restored take's earlier tier is in no record.
 */
import type { BrainEngine } from '../engine.ts';
import { factsFenceSection, parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, type ParsedFact } from '../facts-fence.ts';
import { heldFenceFactRows } from '../facts/unfenced-facts.ts';
import { isFactWithdrawn } from '../facts/withdrawal.ts';
import { readFenceBlocks } from '../generations/fence.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { stableJson } from '../persistence/digest.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { materializedSnapshot, segmentedOverCeiling } from '../persistence/segmented-apply.ts';
import { heldTakeRows } from '../persistence/takes-prepare.ts';
import { parseTakesFence, upsertTakeRow, type ParsedTake } from '../takes-fence.ts';
import { takesPreparation } from '../takes-write.ts';
import { setRowTier } from '../trust/page-handlers.ts';
import { compareTrust, isTrustTier, storedTrustTier, type TrustTier } from '../trust/tier.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairScope } from './core.ts';

const DOCS = 'docs/guides/repair.md#lost-fence-rows';
const COMMAND = 'gbrain repair lost-fence-rows';

/** One retired row the records prove was lost to a re-created section, with the cell to restore. */
interface LostRow { kind: 'fact' | 'take'; id: number; row_num: number; claim: string; version_id: number; retired_at: string; fact?: ParsedFact; take?: ParsedTake; trust_tier?: string | null }
/** One page to republish: its revision at the preview and the rows it gets back, at the numbers they take. */
export interface LostRowsPage { source_id: string; slug: string; page_id: number; revision: string; rows: LostRow[] }
interface LostRowsItem extends RepairItem { page: LostRowsPage; hash: string; last: boolean }
type Residual = 'no_history' | 'page_missing' | 'fence_unreadable';

interface Retired { kind: 'fact_fence' | 'take_fence'; source_id: string; slug: string; retired_at: string; preimage: Record<string, unknown> }

const hasFence = (body: { compiled_truth: string | null; timeline: string | null }, fence: 'facts' | 'takes') => readFenceBlocks(body, fence).state !== 'absent';

/** A page's bodies in write order: every stored version (by id, not timestamp: a version's snapshot time and its write's
 * generation time are not ordered alike on every engine), then the page as it is now (`id` null). */
type History = Array<{ id: number | null; compiled_truth: string; timeline: string | null }>;

/**
 * The newest body whose fence holds the claim (at any row number: a later re-add counts), when the body after it has
 * no fence of that kind at all; `removed` when the body after it kept the fence without the claim (an edit, a forget
 * strike or a takes_remove reservation after any re-add), when any later body holds an explicit empty fence of that kind
 * (the user's answer for every row the section ever held), or when it is the page as it is now; null when no stored
 * version holds it.
 */
function lostIn(history: History, fence: 'facts' | 'takes', holds: (body: string) => ParsedFact | ParsedTake | undefined) {
  let held: { version_id: number; cell: ParsedFact | ParsedTake } | null = null;
  let next: 'absent' | 'fence' | null = null;
  let emptied = false;
  for (const body of history) {
    const text = `${body.compiled_truth}\n${body.timeline ?? ''}`;
    const cell = holds(text);
    if (cell) {
      if (body.id === null) return 'removed' as const;
      held = { version_id: body.id, cell }; next = null; emptied = false;
    } else if (held) {
      if (next === null) next = hasFence(body, fence) ? 'fence' : 'absent';
      if (hasFence(body, fence) && (fence === 'facts' ? parseFactsFence(text).facts.length : parseTakesFence(text).takes.length) === 0) emptied = true;
    }
  }
  return !held ? null : next === 'absent' && !emptied ? held : 'removed' as const;
}

/** Every lost row of the selected sources, grouped by page with the numbers they take, and the count of each reason a row is not listed. */
export async function scanLostFenceRows(engine: BrainEngine, sourceIds: readonly string[], only?: { source_id: string; slug: string }): Promise<{ pages: LostRowsPage[]; residuals: Record<Residual, number> }> {
  const residuals: Record<Residual, number> = { no_history: 0, page_missing: 0, fence_unreadable: 0 };
  const retired = await engine.executeRaw<Retired>(`SELECT g.kind, g.source_id, substr(g.owner_key, 6) AS slug, g.created_at::text AS retired_at, i.preimage
      FROM derived_generation_items i JOIN derived_generations g ON g.id = i.generation_id
     WHERE g.source_id = ANY($1::text[]) AND g.kind IN ('fact_fence','take_fence') AND g.state <> 'held' AND left(g.owner_key, 5) = 'page:'
       AND i.action = 'retired' AND i.preimage IS NOT NULL AND COALESCE(g.completeness->>'proof', '') = ''
       AND ($2::text IS NULL OR (g.source_id = $2 AND g.owner_key = 'page:' || $3))
     ORDER BY g.source_id, g.owner_key, g.id, i.item_key`, [[...sourceIds], only?.source_id ?? null, only?.slug ?? null]);
  const byPage = new Map<string, { source_id: string; slug: string; rows: LostRow[] }>();
  const histories = new Map<string, History | Residual>();
  const historyOf = async (sourceId: string, slug: string): Promise<History | Residual> => {
    const key = `${sourceId}\u0000${slug}`;
    if (!histories.has(key)) {
      const raw = await engine.readPageSnapshot(slug, { sourceId });
      if (!raw || raw.page.deleted_at) histories.set(key, 'page_missing');
      else if (segmentedOverCeiling(raw.page as never)) histories.set(key, 'fence_unreadable');
      else {
        const now = (await materializedSnapshot(engine, raw))!.page;
        const versions = await engine.executeRaw<{ id: number; compiled_truth: string; timeline: string | null }>(`SELECT id::int AS id, compiled_truth, timeline
          FROM page_versions WHERE page_id=$1 AND compiled_truth IS NOT NULL ORDER BY id`, [Number(now.id)]);
        histories.set(key, [...versions.map(v => ({ ...v, id: Number(v.id) })), { id: null, compiled_truth: now.compiled_truth, timeline: now.timeline ?? null }]);
      }
    }
    return histories.get(key)!;
  };
  for (const r of retired) {
    const p = r.preimage;
    const fact = r.kind === 'fact_fence';
    if (fact && p.expired_at != null) continue;
    const [page] = await engine.executeRaw<{ id: number }>('SELECT id::int AS id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [r.source_id, r.slug]);
    if (!page) { residuals.page_missing++; continue; }
    const back = fact
      ? await engine.executeRaw(`SELECT 1 FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL AND fact=$3 AND visibility=$4`, [r.source_id, r.slug, p.fact, p.visibility])
      : await engine.executeRaw('SELECT 1 FROM takes WHERE page_id=$1 AND claim=$2', [page.id, p.claim]);
    if (back.length) continue;
    if (fact && await isFactWithdrawn(engine, r.source_id, String(p.visibility), String(p.fact), (p.entity_slug as string | null) ?? r.slug, r.slug)) continue;
    const history = await historyOf(r.source_id, r.slug);
    if (typeof history === 'string') { residuals[history]++; continue; }
    const rowNum = Number(p.row_num);
    const found = fact
      ? lostIn(history, 'facts', body => parseFactsFence(body).facts.find(f => f.claim === p.fact && f.visibility === p.visibility && f.active))
      : lostIn(history, 'takes', body => parseTakesFence(body).takes.find(t => t.claim === p.claim));
    if (found === 'removed') continue;
    if (!found) { residuals.no_history++; continue; }
    const key = `${r.source_id}\u0000${r.slug}`;
    const entry = byPage.get(key) ?? { source_id: r.source_id, slug: r.slug, rows: [] };
    if (entry.rows.some(row => row.kind === (fact ? 'fact' : 'take') && row.claim === String(fact ? p.fact : p.claim))) continue;
    const tier = fact ? (await engine.executeRaw<{ trust_tier: string | null }>('SELECT trust_tier FROM facts WHERE id=$1', [p.id]))[0]?.trust_tier ?? null : null;
    entry.rows.push({ kind: fact ? 'fact' : 'take', id: Number(p.id), row_num: rowNum, claim: String(fact ? p.fact : p.claim), version_id: found.version_id,
      retired_at: r.retired_at, ...(fact ? { fact: found.cell as ParsedFact, trust_tier: tier } : { take: found.cell as ParsedTake }) });
    byPage.set(key, entry);
  }
  const pages: LostRowsPage[] = [];
  for (const entry of byPage.values()) {
    const planned = await plannedPage(engine, entry);
    if (typeof planned === 'string') { residuals[planned]++; continue; }
    pages.push(planned.page);
  }
  return { pages: pages.sort((a, b) => a.page_id - b.page_id), residuals };
}

/** The page as it is now with the lost rows at the numbers they take, and the content that republishes it. */
async function plannedPage(engine: BrainEngine, entry: { source_id: string; slug: string; rows: LostRow[] }): Promise<{ page: LostRowsPage; content: string } | Residual> {
  const raw = await engine.readPageSnapshot(entry.slug, { sourceId: entry.source_id });
  if (!raw || raw.page.deleted_at) return 'page_missing';
  if (segmentedOverCeiling(raw.page as never)) return 'fence_unreadable';
  const snapshot = (await materializedSnapshot(engine, raw))!;
  const pageId = Number(snapshot.page.id);
  const halves = { compiled_truth: snapshot.page.compiled_truth, timeline: snapshot.page.timeline ?? '' };
  const rows: LostRow[] = [];
  const facts = entry.rows.filter(row => row.kind === 'fact');
  if (facts.length) {
    const section = factsFenceSection(halves);
    const parsed = parseFactsFence(halves[section]);
    if (parsed.warnings.length) return 'fence_unreadable';
    const current = hasFence(halves, 'facts') ? parsed.facts : await heldFenceFactRows(engine, entry.source_id, entry.slug);
    const stored = (await engine.executeRaw<{ n: number }>('SELECT row_num AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL', [entry.source_id, entry.slug])).map(r => Number(r.n));
    const taken = new Set([...current.map(f => f.rowNum), ...stored]);
    let next = Math.max(0, ...taken) + 1;
    const placed = facts.map(row => { const n = taken.has(row.row_num) ? next++ : row.row_num; taken.add(n); return { ...row, row_num: n, fact: { ...row.fact!, rowNum: n } }; });
    rows.push(...placed);
    halves[section] = replaceOrInsertFactsFence(halves[section], renderFactsTable([...current, ...placed.map(row => row.fact)].sort((a, b) => a.rowNum - b.rowNum)));
  }
  let content = serializePageToMarkdown({ ...snapshot.page, ...halves }, snapshot.tags);
  const takes = entry.rows.filter(row => row.kind === 'take');
  if (takes.length) {
    const parsed = parseTakesFence(content);
    if (parsed.warnings.length) return 'fence_unreadable';
    const current = hasFence(halves, 'takes') ? parsed.takes : await heldTakeRows(engine, entry.source_id, entry.slug, pageId);
    const stored = (await engine.executeRaw<{ n: number }>('SELECT row_num AS n FROM takes WHERE page_id=$1', [pageId])).map(r => Number(r.n));
    const taken = new Set([...current.map(t => t.rowNum), ...parsed.reservedRowNums, ...stored]);
    let next = Math.max(0, ...taken) + 1;
    const placed = takes.map(row => { const n = taken.has(row.row_num) ? next++ : row.row_num; taken.add(n); return { ...row, row_num: n, take: { ...row.take!, rowNum: n } }; });
    rows.push(...placed);
    const all = [...current, ...placed.map(row => row.take)].sort((a, b) => a.rowNum - b.rowNum);
    content = takesPreparation.replaceFence(hasFence(halves, 'takes') ? content : upsertTakeRow(content, all[0]!).body, all);
  }
  return { page: { source_id: entry.source_id, slug: entry.slug, page_id: pageId, revision: snapshot.revision, rows }, content };
}

const hashParts = (scope: RepairScope, pages: LostRowsPage[]) => ({ kind: 'lost-fence-rows-v1', brain_id: scope.brain_id, source_ids: scope.source_ids, pages });
const item = (page: LostRowsPage, hash: string, last: boolean): LostRowsItem => ({ cursor: { phase: 1, id: page.page_id }, source_id: page.source_id, slug: page.slug,
  chars: 0, action: `restore_rows:${page.rows.length}`, page, hash, last });
const describeRow = (row: LostRow) => `${row.kind} #${row.row_num} "${row.claim}" (retired ${row.retired_at}, restored from page version ${row.version_id}, `
  + `${restoreTier(row) === 'external_untrusted' && !(row.kind === 'fact' && row.trust_tier === 'external_untrusted') ? 'at the lowest trust tier: no record of its earlier tier' : `at trust tier ${restoreTier(row)}`})`;

/**
 * The tier a restored row may have at most: the tier the expired fact had, or the lowest tier when no record holds one (a
 * fact with no stored tier, every take: a deleted take's tier is in no record). A repair never hands a row more trust.
 */
const restoreTier = (row: LostRow): TrustTier => row.kind === 'fact' && isTrustTier(row.trust_tier) ? row.trust_tier : 'external_untrusted';

/**
 * Lowers each restored row of `page` (live at its planned number with its claim) to `restoreTier`. With `onlyIfAll`, does
 * nothing and returns false unless every row is already live: the rerun of an apply whose page write was left pending.
 */
async function lowerRestoredTiers(engine: BrainEngine, page: LostRowsPage, onlyIfAll: boolean): Promise<boolean> {
  const live = await Promise.all(page.rows.map(async row => (row.kind === 'fact'
    ? await engine.executeRaw<{ id: number; trust_tier: string | null }>(`SELECT id::int AS id, trust_tier FROM facts
        WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=$3 AND fact=$4 AND expired_at IS NULL`, [page.source_id, page.slug, row.row_num, row.claim])
    : await engine.executeRaw<{ id: number; trust_tier: string | null }>('SELECT id::int AS id, trust_tier FROM takes WHERE page_id=$1 AND row_num=$2 AND claim=$3',
      [page.page_id, row.row_num, row.claim]))[0]));
  if (onlyIfAll && live.some(row => !row)) return false;
  for (const [index, row] of page.rows.entries()) {
    const restored = live[index];
    const tier = restoreTier(row);
    if (restored && compareTrust(storedTrustTier(restored.trust_tier), tier) > 0) {
      await setRowTier(engine, { table: row.kind === 'fact' ? 'facts' : 'takes', id: Number(restored.id), sourceId: page.source_id, tier,
        note: { repair: 'lost-fence-rows', [row.kind]: row.id } });
    }
  }
  return true;
}

export const lostFenceRowsRepair: RepairHandler = {
  kind: 'lost-fence-rows',
  async plan(engine, scope, after, opts) {
    if (!opts?.apply) {
      const scan = await scanLostFenceRows(engine, scope.source_ids);
      const hash = previewHash(hashParts(scope, scan.pages));
      if (scan.pages.length) await saveApprovedSet(engine, { command: 'lost-fence-rows', hash }, scan.pages);
      const listing: RepairListing[] = scan.pages.map(page => ({ item: `${page.source_id}:${page.slug} (revision ${page.revision})`, class: 'restore',
        detail: page.rows.map(describeRow).join('; ') }));
      return { items: scan.pages.map((page, index) => item(page, hash, index === scan.pages.length - 1)), preview_hash: hash, residuals: scan.residuals, listing,
        ...(scan.pages.length ? { warnings: ['A restored fact comes back as a new facts row; the expired row stays as history. A restored row never gets more trust than it had: a take, or a fact with no recorded tier, comes back at the lowest tier.'] } : {}),
        details: { docs: DOCS } };
    }
    if (!opts.expect) {
      throw opError('invalid_params', `${COMMAND} --apply restores only the set a preview printed.`,
        `Preview first: ${COMMAND} — show the user the listing, then run the apply command it prints: ${COMMAND} --apply --expect <preview-hash> --yes`,
        { fix: readFix('Previews the fact and take rows lost after a page rewrite dropped their section; writes nothing.', { argv: ['gbrain', 'repair', 'lost-fence-rows', '--json'] }), docs: DOCS });
    }
    const approved = await loadApprovedSet<LostRowsPage>(engine, { command: 'lost-fence-rows', hash: opts.expect, previewCommand: COMMAND,
      emptyHash: async () => previewHash(hashParts(scope, [])) });
    const items = approved.items.map((page, index) => item(page, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { page, hash, last } = entry as LostRowsItem;
    const detail = { facts: page.rows.filter(r => r.kind === 'fact').length, takes: page.rows.filter(r => r.kind === 'take').length };
    // The approved set is retired only when the last page ends without an error, so a stopped run's rerun can still lower the tiers.
    const done = async (outcome: RepairItemOutcome): Promise<RepairItemOutcome> => {
      if (last) await clearApprovedSet(ctx.engine, { command: 'lost-fence-rows', hash });
      return outcome;
    };
    // A rerun after this repair's own page write was left pending finds the rows live at their numbers: it only lowers their tiers.
    if (await lowerRestoredTiers(ctx.engine, page, true)) return done({ applied: true, outcome: 'restored', detail });
    const changed = (reason: string) => done({ applied: false, outcome: 'changed_since_preview', reason: `${page.slug}: ${reason}; run ${COMMAND} again for a new preview.` });
    const [now] = (await scanLostFenceRows(ctx.engine, [page.source_id], page)).pages;
    if (!now || now.revision !== page.revision || stableJson(now.rows) !== stableJson(page.rows)) return changed('the page or its lost rows changed since the preview');
    const planned = await plannedPage(ctx.engine, page);
    if (typeof planned === 'string') return changed(planned);
    try {
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: page.slug, source_id: page.source_id, content: planned.content, expected_revision: page.revision,
        request_id: await repairRequestId(ctx, 'lost-fence-rows', entry, page.revision) } });
    } catch (error) {
      // Without its receipt a pending write stops the run here, before the cursor passes this page: the runner would otherwise settle
      // the write on its own later and never come back to lower the restored tiers. The rerun replays the same request, then lowers them.
      if (error instanceof OperationError && error.code === 'write_pending') error.writeRequest = undefined;
      throw error;
    }
    await lowerRestoredTiers(ctx.engine, page, false);
    return done({ applied: true, outcome: 'restored', detail });
  },
  render(details) {
    return [`  each page: republished with the rows page history last held, through a revision-bound put_page; guide: ${details.docs}`];
  },
};
