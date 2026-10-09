/**
 * `gbrain repair take-supersession` (#5886): rebuild `takes.superseded_by`
 * for supersession chains written before the pointer moved onto the old
 * fence row.
 *
 * The canonical projection derives `superseded_by` from an inactive fence
 * row whose source cell cites `superseded by #N`. Older `supersedeRow`
 * struck the old row without a pointer and, when the caller gave no source,
 * wrote `superseded by #<own row>` onto the NEW row, so managed brains store
 * `superseded_by = NULL` (and a later strike of that new row projects a
 * self-reference).
 *
 * Per page the repair links each struck row to the row that replaced it,
 * using only evidence, in this order:
 *   1. `journal`: a committed `takes_supersede` receipt for the page names
 *      `old_row` and `new_row`;
 *   2. `database`: the `takes` row of a struck row still holds a
 *      `superseded_by` (the unmanaged mirror wrote it);
 *   3. `fence_structure`: a row that carries the old self-pointer was created
 *      by a supersession, and exactly one struck, unlinked row above it
 *      remains as its predecessor (resolved repeatedly, so a chain resolves
 *      hop by hop).
 * A page where a self-pointer row has two or more candidate predecessors, or
 * where two pieces of evidence disagree, is ambiguous: it is reported with
 * the candidates and the manual edit, and nothing on it changes.
 *
 * A page that needs a link or carries a stale self-pointer is republished
 * through a revision-bound `put_page`, whose canonical projection then
 * writes `superseded_by`: the old row's source cell gains
 * `superseded by #N` after its own provenance, and self-pointers are
 * dropped, exactly as `supersedeRow` writes a new supersession. A page whose
 * fence is already right but whose database pointers differ is reprojected
 * under the page key (a receipted database-only request on a managed brain,
 * a maintenance transaction otherwise). A second apply finds nothing to do.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { TAKES_FENCE_BEGIN, parseTakesFence, type ParsedTake } from '../takes-fence.ts';
import { takesPreparation } from '../takes-write.ts';
import { afterCursor, repairRequestId, type RepairCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairScope } from './core.ts';

export type SupersessionEvidence = 'journal' | 'database' | 'fence_structure';

export interface SupersessionLink { old_row: number; new_row: number; evidence: SupersessionEvidence }

export interface SupersessionAnalysis {
  /** Pointers to write onto struck rows. */
  links: SupersessionLink[];
  /** Rows whose stale `superseded by #<own row>` source cell is dropped. */
  self_pointers: number[];
  /** Self-pointer rows with two or more candidate predecessors, or rows whose evidence conflicts. */
  ambiguous: Array<{ new_row: number; candidates: number[] }>;
  /** The fence after the repair (unchanged rows when nothing moves). */
  takes: ParsedTake[];
  /** Whether the fence text changes. */
  fence_changed: boolean;
}

const POINTER = /superseded by #(\d+)/i;
const SELF_POINTER = /^superseded by #(\d+)$/i;

/** The `superseded_by` the canonical projection derives from a fence row. */
function projectedPointer(t: ParsedTake): number | null {
  return takesPreparation.toCanonicalBatchInput(0, t).superseded_by ?? null;
}

function isSelfPointer(t: ParsedTake): boolean {
  const m = (t.source ?? '').trim().match(SELF_POINTER);
  return m !== null && Number(m[1]) === t.rowNum;
}

/**
 * Infer each struck row's replacement from the evidence, in evidence order.
 * Pure: `journal` and `database` are `[old_row, new_row]` pairs.
 */
export function analyzeSupersession(takes: ParsedTake[], evidence: { journal: Array<[number, number]>; database: Array<[number, number]> }): SupersessionAnalysis {
  const byRow = new Map(takes.map(t => [t.rowNum, t]));
  const linkedTo = new Map<number, number>();
  const linkedFrom = new Map<number, number>();
  for (const t of takes) {
    const p = projectedPointer(t);
    if (p !== null && p !== t.rowNum && byRow.has(p)) { linkedTo.set(t.rowNum, p); linkedFrom.set(p, t.rowNum); }
  }
  // Struck rows that cite nothing, or only their own row number: the rows a link may be written onto.
  const open = new Set(takes.filter(t => !t.active && !linkedTo.has(t.rowNum) && (!POINTER.test(t.source ?? '') || isSelfPointer(t))).map(t => t.rowNum));
  const links: SupersessionLink[] = [];
  const ambiguous = new Map<number, number[]>();
  const link = (oldRow: number, newRow: number, kind: SupersessionEvidence) => {
    links.push({ old_row: oldRow, new_row: newRow, evidence: kind });
    linkedTo.set(oldRow, newRow); linkedFrom.set(newRow, oldRow); open.delete(oldRow);
  };

  for (const kind of ['journal', 'database'] as const) {
    const pairs = evidence[kind].filter(([o, n]) => n > o && byRow.has(n) && byRow.has(o) && !byRow.get(o)!.active);
    for (const [o, n] of pairs) {
      if (!open.has(o) || linkedFrom.get(n) === o) continue;
      // Evidence that gives this row a second successor, or this successor a second predecessor, is a conflict.
      const rivals = pairs.filter(([o2, n2]) => (o2 === o) !== (n2 === n)).map(([o2]) => o2);
      const taken = linkedFrom.get(n);
      if (rivals.length || taken !== undefined) {
        ambiguous.set(n, [...new Set([...(ambiguous.get(n) ?? []), o, ...rivals, ...(taken !== undefined ? [taken] : [])])].sort((a, b) => a - b));
        continue;
      }
      link(o, n, kind);
    }
  }

  // A self-pointer row was created by a supersession; resolve the ones with exactly one candidate, repeatedly.
  let pending = takes.filter(t => isSelfPointer(t) && !linkedFrom.has(t.rowNum) && !ambiguous.has(t.rowNum)).map(t => t.rowNum);
  for (let progress = true; progress;) {
    progress = false;
    for (const n of pending) {
      const candidates = [...open].filter(o => o < n);
      if (candidates.length !== 1) continue;
      link(candidates[0], n, 'fence_structure');
      pending = pending.filter(row => row !== n);
      progress = true;
    }
  }
  for (const n of pending) {
    const candidates = [...open].filter(o => o < n).sort((a, b) => a - b);
    if (candidates.length > 1) ambiguous.set(n, candidates);
  }

  const result = { ambiguous: [...ambiguous].map(([new_row, candidates]) => ({ new_row, candidates })).sort((a, b) => a.new_row - b.new_row) };
  if (result.ambiguous.length) return { links: [], self_pointers: [], ...result, takes, fence_changed: false };
  const self_pointers = takes.filter(isSelfPointer).map(t => t.rowNum);
  const next = takes.map(t => {
    const own = isSelfPointer(t) ? '' : (t.source ?? '').trim();
    const target = links.find(l => l.old_row === t.rowNum)?.new_row;
    if (target !== undefined) return { ...t, source: own ? `${own}; superseded by #${target}` : `superseded by #${target}` };
    if (isSelfPointer(t)) return { ...t, source: undefined };
    return t;
  });
  return { links, self_pointers, ...result, takes: next, fence_changed: links.length > 0 || self_pointers.length > 0 };
}

interface TakePage { id: number; source_id: string; slug: string }

interface PagePlan {
  page: TakePage;
  revision: string;
  content: string;
  analysis: SupersessionAnalysis;
  /** Rows whose stored `superseded_by` differs from the (repaired) fence. */
  reproject: Array<{ row_num: number; from: number | null; to: number | null }>;
}

type PageState = PagePlan | { skipped: 'unparsed' } | null;

async function readPage(engine: BrainEngine, page: TakePage): Promise<PageState> {
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
  if (!snapshot) return null;
  const content = serializePageToMarkdown(snapshot.page, snapshot.tags);
  if (content.split(TAKES_FENCE_BEGIN).length !== 2) return { skipped: 'unparsed' };
  const parsed = parseTakesFence(content);
  if (parsed.warnings.length || !parsed.takes.length) return { skipped: 'unparsed' };
  const stored = await engine.executeRaw<{ row_num: number; superseded_by: number | null }>(
    'SELECT row_num, superseded_by FROM takes WHERE page_id = $1', [snapshot.page.id]);
  const journal = await engine.executeRaw<{ old_row: string | null; new_row: string | null }>(
    `SELECT outcome->>'old_row' AS old_row, outcome->>'new_row' AS new_row FROM persistence_requests
      WHERE operation = 'takes_supersede' AND state = 'committed' AND source_id = $1
        AND (page_id = $2 OR (page_id IS NULL AND slug = $3))`, [page.source_id, snapshot.page.id, page.slug]);
  const pairs = (rows: Array<[unknown, unknown]>): Array<[number, number]> => rows
    .map(([o, n]) => [Number(o), Number(n)] as [number, number])
    .filter(([o, n]) => Number.isSafeInteger(o) && Number.isSafeInteger(n) && o > 0 && n > 0);
  const analysis = analyzeSupersession(parsed.takes, {
    journal: pairs(journal.map(r => [r.old_row, r.new_row])),
    database: pairs(stored.filter(r => r.superseded_by !== null).map(r => [r.row_num, r.superseded_by])),
  });
  const storedBy = new Map(stored.map(r => [Number(r.row_num), r.superseded_by === null ? null : Number(r.superseded_by)]));
  const reproject = analysis.ambiguous.length ? [] : analysis.takes
    .filter(t => storedBy.has(t.rowNum) && storedBy.get(t.rowNum) !== projectedPointer(t))
    .map(t => ({ row_num: t.rowNum, from: storedBy.get(t.rowNum)!, to: projectedPointer(t) }));
  return { page: { ...page, id: snapshot.page.id }, revision: snapshot.revision, content, analysis, reproject };
}

function actionText(plan: PagePlan): string {
  const parts = [
    ...plan.analysis.links.map(l => `link #${l.old_row}->#${l.new_row} (${l.evidence})`),
    ...(plan.analysis.self_pointers.length ? [`drop self-pointer on #${plan.analysis.self_pointers.join(', #')}`] : []),
    ...(!plan.analysis.fence_changed && plan.reproject.length ? [`reproject superseded_by on #${plan.reproject.map(r => r.row_num).join(', #')}`] : []),
  ];
  return parts.join('; ');
}

function ambiguityFix(page: TakePage, ambiguous: SupersessionAnalysis['ambiguous']): string {
  return ambiguous.map(a => `row #${a.new_row} replaced one of #${a.candidates.join(', #')}`).join('; ')
    + `. Read the page (gbrain get --source ${page.source_id} -- ${page.slug}), append "; superseded by #<new row>" to the source cell of the row each new row replaced, `
    + 'save it with the current expected_revision, then run gbrain repair take-supersession again.';
}

async function candidatePages(engine: BrainEngine, sourceIds: string[], after: RepairCursor | null): Promise<TakePage[]> {
  const pages = await engine.executeRaw<TakePage>(
    `SELECT p.id, p.source_id, p.slug FROM pages p
      WHERE p.source_id = ANY($1::text[]) AND p.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM takes t WHERE t.page_id = p.id AND (t.active = false OR t.source ILIKE '%superseded by #%'))
      ORDER BY p.id`, [sourceIds]);
  return pages.filter(page => afterCursor({ phase: 0, id: page.id }, after));
}

export const TAKE_REPROJECT_INTENT = 'managed_maintenance_take_reproject';

const revisionConflict = (page: TakePage) => opError('revision_conflict', 'The page changed after the supersession repair read it; nothing was written.',
  `Page ${page.slug} in source ${page.source_id} changed during the repair, so its take pointers were left as they are. Preview again with the command in fix; it plans against the current page.`,
  { fix: readFix('Previews the take supersession repair against the current pages without changing anything.', { argv: ['gbrain', 'repair', 'take-supersession', '--source', page.source_id] }) });

async function writeReprojection(tx: BrainEngine, plan: PagePlan): Promise<void> {
  for (const row of plan.reproject) {
    await tx.executeRaw('UPDATE takes SET superseded_by = $3 WHERE page_id = $1 AND row_num = $2', [plan.page.id, row.row_num, row.to]);
  }
}

/**
 * Reproject a page whose fence is already right, against the planned
 * revision: a receipted database-only request on a managed brain (its
 * preparer replans under the page key), a maintenance transaction otherwise.
 */
async function reprojectPage(ctx: OperationContext, entry: RepairItem, plan: PagePlan): Promise<void> {
  const { page } = plan;
  if (await managedPersistenceEnabled(ctx.engine)) {
    const authority = (await maintenancePreflight(ctx.engine, page.source_id))!;
    try {
      await submitDatabaseMaintenanceIntent(ctx.engine, authority, page.slug, { kind: TAKE_REPROJECT_INTENT, expected_revision: plan.revision,
        page_id: page.id, reproject: plan.reproject }, await repairRequestId(ctx, 'take-supersession', entry, plan.revision));
    } catch (error) {
      if (error instanceof OperationError && error.code === 'revision_conflict') throw revisionConflict(page);
      throw error;
    }
    return;
  }
  await maintenanceTransaction(ctx.engine, async tx => {
    await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
    const current = await tx.readPageSnapshot(page.slug, { sourceId: page.source_id });
    if (!current || current.revision !== plan.revision) throw revisionConflict(page);
    await writeReprojection(tx, plan);
  });
}

/** Preparer for `managed_maintenance_take_reproject`: replans the page under its key and writes the pointers it still needs. */
export async function prepareTakeReprojection(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const page = { id: Number(row.page_id), source_id: row.source_id, slug: row.slug };
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== page.id) throw revisionConflict(page);
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  return { observedRevision: snapshot.revision, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => {
      const state = await readPage(tx, page);
      if (!state || 'skipped' in state || state.analysis.ambiguous.length || state.analysis.fence_changed) {
        return { status: 'completed', reprojected: [] };
      }
      await writeReprojection(tx, state);
      return { status: 'completed', reprojected: state.reproject };
    } };
}

interface SupersessionItem extends RepairItem { page: TakePage }

export const takeSupersessionRepair: RepairHandler = {
  kind: 'take-supersession',
  async plan(engine, scope: RepairScope, after) {
    const items: SupersessionItem[] = [];
    const pages: Array<Record<string, unknown>> = [];
    const ambiguous: Array<Record<string, unknown>> = [];
    let unparsed = 0;
    for (const page of await candidatePages(engine, scope.source_ids, after)) {
      const state = await readPage(engine, page);
      if (!state) continue;
      if ('skipped' in state) { unparsed++; continue; }
      if (state.analysis.ambiguous.length) {
        ambiguous.push({ source_id: page.source_id, slug: page.slug, rows: state.analysis.ambiguous, fix: ambiguityFix(page, state.analysis.ambiguous) });
        continue;
      }
      if (!state.analysis.fence_changed && !state.reproject.length) continue;
      const action = actionText(state);
      items.push({ cursor: { phase: 0, id: page.id }, source_id: page.source_id, slug: page.slug, chars: state.content.length, action, page });
      pages.push({ source_id: page.source_id, slug: page.slug, links: state.analysis.links, self_pointers: state.analysis.self_pointers,
        reproject: state.analysis.fence_changed ? [] : state.reproject, action });
    }
    return {
      items,
      residuals: {
        links: pages.reduce((n, p) => n + (p.links as unknown[]).length, 0),
        ambiguous_pages: ambiguous.length,
        ambiguous_rows: ambiguous.reduce((n, p) => n + (p.rows as unknown[]).length, 0),
        unparsed_pages: unparsed,
      },
      ...(pages.length || ambiguous.length ? { details: { pages, ambiguous } } : {}),
    };
  },
  async apply(ctx: OperationContext, entry): Promise<RepairItemOutcome> {
    const { page } = entry as SupersessionItem;
    const state = await readPage(ctx.engine, page);
    if (!state || 'skipped' in state) return { applied: false, outcome: 'unchanged', reason: 'the page or its takes fence is no longer readable' };
    if (state.analysis.ambiguous.length) return { applied: false, outcome: 'ambiguous', reason: ambiguityFix(page, state.analysis.ambiguous) };
    if (state.analysis.fence_changed) {
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: page.slug, source_id: page.source_id,
        content: takesPreparation.replaceFence(state.content, state.analysis.takes), expected_revision: state.revision,
        request_id: await repairRequestId(ctx, 'take-supersession', entry, state.revision) } });
      return { applied: true, outcome: 'repaired', detail: { links: state.analysis.links, self_pointers: state.analysis.self_pointers } };
    }
    if (!state.reproject.length) return { applied: false, outcome: 'unchanged' };
    await reprojectPage(ctx, entry, state);
    return { applied: true, outcome: 'reprojected', detail: { rows: state.reproject } };
  },
  render(details) {
    const lines: string[] = [];
    for (const p of (details.pages ?? []) as Array<{ source_id: string; slug: string; action: string }>) lines.push(`  ${p.source_id}:${p.slug}: ${p.action}`);
    for (const p of (details.ambiguous ?? []) as Array<{ source_id: string; slug: string; fix: string }>) lines.push(`  ambiguous ${p.source_id}:${p.slug}: ${p.fix}`);
    return lines;
  },
};
