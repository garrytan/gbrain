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
 *   (g) protection_loosened  nothing the privacy boundary hid is shown after
 *
 * Gates (b), (c), (e) and (f) read the raw-row extraction of the
 * before-region, never strict-parser output. (e) runs before (b) so a dropped
 * or stranded row reports the row-count gate. Failures carry the reason, the
 * gate letter and row numbers only.
 */
import { normalizeFences } from './normalize.ts';
import { exposedLines, sectionsOf, strictFailures } from './page-checks.ts';
import { extractRawRows, primaryFence, rowNumOf, type RawFence, type RawRow } from './raw-rows.ts';
import { cellsChanged } from './validate-cells.ts';
import { GATE_REASONS } from './reasons.ts';
import { cellValid, collapse, enumSynonym } from './schema.ts';
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

/** One fence kind in one section, before and after. */
export interface FencePair {
  section: FenceSection;
  kind: FenceKind;
  before: RawFence | null;
  after: RawFence | null;
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
  const pairs = fencePairs(before, after);
  for (const check of [rowCount, claims, rowNumbers, visibility, cells]) {
    const failed = check(pairs, ctx);
    if (failed) return failed;
  }
  return protection(before, after);
}

function fencePairs(before: FencePage, after: FencePage): FencePair[] {
  const afterSections = new Map(sectionsOf(after));
  return sectionsOf(before).flatMap(([section, text]) => {
    const b = extractRawRows(text, section);
    const a = extractRawRows(afterSections.get(section) ?? '', section);
    return (['facts', 'takes'] as const).map(kind => ({ section, kind, before: primaryFence(b, kind), after: primaryFence(a, kind) }));
  });
}

const rowsOf = (fence: RawFence | null): RawRow[] => fence?.rows ?? [];
const numOf = (fence: RawFence | null, row: RawRow | undefined): number | null => (fence && row ? rowNumOf(fence, row) : null);
const claimOf = (row: RawRow): string => collapse(row.byColumn.get('claim')?.text ?? '');

function numbers(fence: RawFence | null, rows: readonly RawRow[]): number[] {
  return rows.map(r => numOf(fence, r)).filter((n): n is number => n !== null);
}

/** (e) */
function rowCount(pairs: FencePair[]): Failure | null {
  for (const pair of pairs) {
    const b = rowsOf(pair.before);
    const a = rowsOf(pair.after);
    if (b.length === a.length) continue;
    const longer = b.length > a.length ? { fence: pair.before, rows: b } : { fence: pair.after, rows: a };
    return at(pair, 'e', numbers(longer.fence, longer.rows.slice(Math.min(a.length, b.length))));
  }
  return null;
}

/** (b) */
function claims(pairs: FencePair[]): Failure | null {
  for (const pair of pairs) {
    const a = rowsOf(pair.after);
    const changed = rowsOf(pair.before).filter((row, k) => claimOf(row) !== claimOf(a[k]!));
    if (changed.length) return at(pair, 'b', numbers(pair.after, changed.map(r => a[r.occurrence]!)));
  }
  return null;
}

/** (c) */
function rowNumbers(pairs: FencePair[]): Failure | null {
  for (const kind of ['facts', 'takes'] as const) {
    const of = pairs.filter(p => p.kind === kind);
    const before = of.flatMap(p => rowsOf(p.before).map(row => ({ num: numOf(p.before, row), claim: claimOf(row), pair: p })));
    const after = new Set(of.flatMap(p => rowsOf(p.after).map(row => `${numOf(p.after, row)}\u0000${claimOf(row)}`)));
    for (const row of before) {
      if (row.num === null || before.filter(r => r.num === row.num).length > 1) continue;
      if (!after.has(`${row.num}\u0000${row.claim}`)) return at(row.pair, 'c', [row.num]);
    }
  }
  return null;
}

/** (d) */
function visibility(pairs: FencePair[], ctx: ValidateCtx): Failure | null {
  for (const pair of pairs.filter(p => p.kind === 'facts')) {
    const a = rowsOf(pair.after);
    for (const row of rowsOf(pair.before)) {
      const after = a[row.occurrence]!;
      if (after.byColumn.get('visibility')?.text.trim().toLowerCase() !== 'world') continue;
      if (!mayBecomeWorld(row, ctx)) return at(pair, 'd', numbers(pair.after, [after]));
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
    const a = rowsOf(pair.after);
    for (const row of rowsOf(pair.before)) {
      const after = a[row.occurrence]!;
      if (cellsChanged(pair, row, after, ctx).length) return at(pair, 'f', numbers(pair.after, [after]));
    }
  }
  return null;
}

/** (g) */
function protection(before: FencePage, after: FencePage): Failure | null {
  const afterSections = new Map(sectionsOf(after));
  for (const [section, text] of sectionsOf(before)) {
    if (exposedLines(text, afterSections.get(section) ?? '').length) {
      return { gate: 'g', fence: null, section, rows: [] };
    }
  }
  return null;
}
