/**
 * The fence repair validator (#6188): the one gate every tier's output
 * passes before anything is written.
 *
 *   (a) still_invalid        the after page compiles (strict parse, markers, unique rows)
 *   (e) row_count_changed    same data-row count; every before row sits in the after fence
 *   (b) claim_changed        claim cells identical, in order (strikethrough kept, whitespace collapsed)
 *   (c) row_number_changed   every valid, page-unique row number keeps its claim
 *   (d) visibility_loosened  a private row never becomes world; invalid becomes world only via `public` on a world page
 *   (f) cell_changed         per row, a valid non-claim cell keeps its column and text; a misaligned cell may move
 *                            with its text unchanged; text changes only where an issue names the row and column
 *                            and a named rule produced it (TE2)
 *   (g) protection_loosened  nothing the privacy boundary hid is shown after, except the trailing lines of a fence a
 *                            `close_fence_trailing` fix closed (#6377): the structural rule admits that fix only on a private
 *                            page or under the user's hash-bound approval, and the gate accepts exactly those lines
 *
 * Gates (b), (c), (e) and (f) read the raw-row extraction of the
 * before-region, never strict-parser output. (e) runs before (b) so a dropped
 * or stranded row reports the row-count gate. Failures carry the reason, the
 * gate letter and row numbers only.
 *
 * Before rows pair with after rows by occurrence in the primary fence. When
 * the fixes name `merge_fences` for a section and kind (#6377), the pairing
 * is the merge mapping re-derived from the before page (`merge.ts`): every
 * fence's rows in document order, each kept at its merged occurrence or
 * dropped as an exact duplicate of a kept row. Gate (e) then accepts exactly
 * the dropped rows, each only when its cells equal the kept row's cells as
 * written; the other gates run row by row through the mapping; a
 * `superseded by #N` reference in a merged row may read the new number of
 * its own before-fence's row N. Without a merge fix nothing changes.
 */
import { mergePlans, rowKey, type MergePlan } from './merge.ts';
import { normalizeFences } from './normalize.ts';
import { exposedLines, sectionsOf, strictFailures } from './page-checks.ts';
import { extractRawRows, primaryFence, rowNumOf, type RawFence, type RawRow } from './raw-rows.ts';
import { trailingLinesOf } from './structure.ts';
import { cellsChanged } from './validate-cells.ts';
import { GATE_REASONS } from './reasons.ts';
import { cellValid, collapse, enumSynonym, supersededRef } from './schema.ts';
import type { FenceCtx, FenceKind, FenceLocation, FencePage, FenceReason, FenceSection, FenceTier, GateLetter } from './types.ts';

export interface ValidateCtx extends FenceCtx {
  /** The tier whose output is checked. */
  tier: Exclude<FenceTier, 'manual'>;
  /** Issues and fixes found on the before page; a cell may change only where one names it. */
  issues: readonly FenceLocation[];
}

export type ValidateResult =
  | { ok: true }
  | {
    ok: false;
    reason: FenceReason;
    gate: GateLetter;
    tier: Exclude<FenceTier, 'manual'>;
    fence: FenceKind | null;
    section: FenceSection | null;
    rows: number[];
  };

/** One before row and the after row it pairs with (null for a dropped duplicate). */
interface Paired {
  row: RawRow;
  /** The before fence holding the row. */
  fence: RawFence;
  after: RawRow | null;
  /** The before row an exact duplicate was dropped for. */
  duplicateOf: Paired | null;
}

/** One fence kind in one section, before and after. */
export interface FencePair {
  section: FenceSection;
  kind: FenceKind;
  before: RawFence | null;
  after: RawFence | null;
  /** Every before row in document order (all fences of the kind under a merge). */
  rows: Paired[];
}

type Failure = { gate: GateLetter; fence: FenceKind | null; section: FenceSection | null; rows: number[] };

const at = (pair: FencePair, gate: GateLetter, rows: number[]): Failure => ({ gate, fence: pair.kind, section: pair.section, rows });

export function validateFenceRepair(before: FencePage, after: FencePage, ctx: ValidateCtx): ValidateResult {
  const failure = firstFailure(before, after, ctx);
  if (!failure) return { ok: true };
  return {
    ok: false, reason: GATE_REASONS[failure.gate], gate: failure.gate, tier: ctx.tier,
    fence: failure.fence, section: failure.section, rows: [...new Set(failure.rows)],
  };
}

/** The page is a Tier 1 fixed point: normalizing it applies no fix. */
export function isFenceFixedPoint(page: FencePage, ctx: FenceCtx): boolean {
  return normalizeFences(page, ctx).fixes.length === 0;
}

function firstFailure(before: FencePage, after: FencePage, ctx: ValidateCtx): Failure | null {
  const strict = strictFailures(after);
  if (strict.length) {
    const f = strict[0]!;
    return { gate: 'a', fence: f.fence, section: f.section, rows: f.rows };
  }
  const pairs = fencePairs(before, after, ctx);
  if (!pairs) return { gate: 'e', fence: null, section: null, rows: [] };
  for (const check of [rowCount, claims, rowNumbers, visibility, cells]) {
    const failed = check(pairs, ctx);
    if (failed) return failed;
  }
  return protection(before, after, ctx);
}

/** Null when the fixes name a merge the before page does not admit (nothing the mapping could vouch for). */
function fencePairs(before: FencePage, after: FencePage, ctx: ValidateCtx): FencePair[] | null {
  const merges = mergePlans(before, ctx.issues.flatMap(i => ('class' in i && typeof i.class === 'string' ? [{ fence: i.fence, section: i.section, class: i.class }] : [])));
  if (!merges) return null;
  const afterSections = new Map(sectionsOf(after));
  return sectionsOf(before).flatMap(([section, text]) => {
    const b = extractRawRows(text, section);
    const a = extractRawRows(afterSections.get(section) ?? '', section);
    return (['facts', 'takes'] as const).map(kind => {
      const pair: FencePair = { section, kind, before: primaryFence(b, kind), after: primaryFence(a, kind), rows: [] };
      const plan = merges.get(`${section}:${kind}`);
      pair.rows = plan ? mergedRows(plan, pair.after) : rowsOf(pair.before).map(row => ({ row, fence: pair.before!, after: rowsOf(pair.after)[row.occurrence] ?? null, duplicateOf: null }));
      return pair;
    });
  });
}

function mergedRows(plan: MergePlan, after: RawFence | null): Paired[] {
  const afterRows = rowsOf(after);
  const paired: Paired[] = [];
  for (const r of plan.rows) {
    paired.push({ row: r.row, fence: plan.fences[r.fence]!, after: r.keptAs === null ? null : afterRows[r.keptAs] ?? null, duplicateOf: r.duplicateOf === null ? null : paired[r.duplicateOf]! });
  }
  return paired;
}

const rowsOf = (fence: RawFence | null): RawRow[] => fence?.rows ?? [];
const numOf = (fence: RawFence | null, row: RawRow | undefined | null): number | null => (fence && row ? rowNumOf(fence, row) : null);
const claimOf = (row: RawRow): string => collapse(row.byColumn.get('claim')?.text ?? '');

function numbers(fence: RawFence | null, rows: readonly RawRow[]): number[] {
  return rows.map(r => numOf(fence, r)).filter((n): n is number => n !== null);
}

/** (e) */
function rowCount(pairs: FencePair[]): Failure | null {
  for (const pair of pairs) {
    const kept = pair.rows.filter(p => p.duplicateOf === null);
    const a = rowsOf(pair.after);
    if (kept.length !== a.length) {
      const longer = kept.length > a.length ? { fence: pair.before, rows: kept.map(p => p.row) } : { fence: pair.after, rows: a };
      return at(pair, 'e', numbers(longer.fence, longer.rows.slice(Math.min(a.length, kept.length))));
    }
    // A dropped row is admitted only as an exact copy of its kept row, as both were written.
    const dropped = pair.rows.filter(p => p.duplicateOf !== null && rowKey(p.fence, p.row) !== rowKey(p.duplicateOf!.fence, p.duplicateOf!.row));
    if (dropped.length) return at(pair, 'e', dropped.map(p => numOf(p.fence, p.row)).filter((n): n is number => n !== null));
  }
  return null;
}

/** (b) */
function claims(pairs: FencePair[]): Failure | null {
  for (const pair of pairs) {
    const changed = pair.rows.filter(p => p.after && claimOf(p.row) !== claimOf(p.after));
    if (changed.length) return at(pair, 'b', numbers(pair.after, changed.map(p => p.after!)));
  }
  return null;
}

/** (c) */
function rowNumbers(pairs: FencePair[]): Failure | null {
  for (const kind of ['facts', 'takes'] as const) {
    const of = pairs.filter(p => p.kind === kind);
    const before = of.flatMap(p => p.rows.map(r => ({ num: numOf(r.fence, r.row), claim: claimOf(r.row), dropped: r.duplicateOf !== null, pair: p })));
    const after = new Set(of.flatMap(p => rowsOf(p.after).map(row => `${numOf(p.after, row)}\u0000${claimOf(row)}`)));
    for (const row of before) {
      if (row.num === null || row.dropped || before.filter(r => r.num === row.num).length > 1) continue;
      if (!after.has(`${row.num}\u0000${row.claim}`)) return at(row.pair, 'c', [row.num]);
    }
  }
  return null;
}

/** (d) */
function visibility(pairs: FencePair[], ctx: ValidateCtx): Failure | null {
  for (const pair of pairs.filter(p => p.kind === 'facts')) {
    for (const p of pair.rows) {
      if (!p.after || p.after.byColumn.get('visibility')?.text.trim().toLowerCase() !== 'world') continue;
      if (!mayBecomeWorld(p.row, ctx)) return at(pair, 'd', numbers(pair.after, [p.after]));
    }
  }
  return null;
}

function mayBecomeWorld(row: RawRow, ctx: ValidateCtx): boolean {
  const toWorld = (text: string) => enumSynonym('visibility', text, ctx.pageVisibility) === 'world';
  const aligned = !row.beforeHeader && row.shape === 'ok';
  if (!aligned) return [...row.byColumn.values(), ...row.extra].some(c => toWorld(c.text));
  const vis = row.byColumn.get('visibility');
  if (!vis) return false;
  return cellValid('facts', 'visibility', vis.text) ? vis.text.trim().toLowerCase() === 'world' : toWorld(vis.text);
}

/** (f) */
function cells(pairs: FencePair[], ctx: ValidateCtx): Failure | null {
  for (const pair of pairs) {
    for (const p of pair.rows) {
      if (!p.after) continue;
      if (cellsChanged(pair, withFollowedRef(pair, p), p.after, ctx).length) return at(pair, 'f', numbers(pair.after, [p.after]));
    }
  }
  return null;
}

/**
 * Under a merge, a `superseded by #N` reference in a before row may follow
 * the one row numbered N of the row's own before fence (kept, or the kept
 * row its exact duplicate equalled) to that row's after number: the before
 * row is compared as if written with the new number. Any other reference
 * change fails gate (f) as a changed cell.
 */
function withFollowedRef(pair: FencePair, p: Paired): RawRow {
  if (pair.rows.every(r => r.fence === pair.before)) return p.row;
  const column = pair.kind === 'facts' ? 'context' : 'source';
  const cell = p.row.byColumn.get(column);
  const ref = cell ? supersededRef(cell.text) : null;
  if (ref === null) return p.row;
  const own = pair.rows.filter(r => r.fence === p.fence && numOf(r.fence, r.row) === ref);
  if (own.length !== 1) return p.row;
  const target = own[0]!.duplicateOf ?? own[0]!;
  const now = numOf(pair.after, target.after);
  if (now === null || now === ref) return p.row;
  const rewrite = (text: string) => text.replace(/(superseded by #)\d+/i, `$1${now}`);
  const followed = { ...cell!, text: rewrite(cell!.text), raw: rewrite(cell!.raw) };
  const byColumn = new Map(p.row.byColumn);
  byColumn.set(column, followed);
  return { ...p.row, byColumn, cells: p.row.cells.map(c => (c === cell ? followed : c)) };
}

/** (g) */
function protection(before: FencePage, after: FencePage, ctx: ValidateCtx): Failure | null {
  const afterSections = new Map(sectionsOf(after));
  for (const [section, text] of sectionsOf(before)) {
    const exposed = exposedLines(text, afterSections.get(section) ?? '');
    if (!exposed.length) continue;
    const closed = ctx.issues.filter((i): i is FenceLocation & { class: 'close_fence_trailing' } => 'class' in i && i.class === 'close_fence_trailing' && i.section === section);
    if (!closed.length) return { gate: 'g', fence: null, section, rows: [] };
    const allowed = new Map<string, number>();
    const tails = trailingLinesOf(text, section);
    for (const fix of closed) for (const line of tails.get(`${section}:${fix.fence}`) ?? []) allowed.set(line, (allowed.get(line) ?? 0) + 1);
    for (const line of exposed) {
      const left = allowed.get(line) ?? 0;
      if (left <= 0) return { gate: 'g', fence: closed[0]!.fence, section, rows: [] };
      allowed.set(line, left - 1);
    }
  }
  return null;
}
