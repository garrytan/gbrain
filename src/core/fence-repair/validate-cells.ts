/**
 * Gate (f), per-cell preservation (#6188, TE2), for one before row and the
 * after row at the same position.
 *
 * Aligned before rows (under a header, no shape problem): a cell valid in
 * its column keeps its column and text (whitespace collapsed); a changed cell
 * must be named by an issue on that row and column (or a fence-level issue)
 * and equal what a named rule writes for the before text; a cell invalid in
 * its column may instead move to another column with its text unchanged.
 * A column absent from the before header may only take its write default
 * (`column_default`) or stay empty. Misaligned before rows (rows before the
 * header, short rows, extra cells) may have every cell moved, with text
 * unchanged or rewritten by a named rule. In both cases no before text may
 * vanish, and a facts kind rewritten by `kind_map` must leave its original
 * word in `context`.
 */
import type { RawFence, RawRow } from './raw-rows.ts';
import { ruleOutputs } from './rules.ts';
import { appendOriginalKind, cellValid, collapse, COLUMN_DEFAULTS, factsKindMap } from './schema.ts';
import type { FenceKind, FenceSection } from './types.ts';
import type { ValidateCtx } from './validate.ts';

interface PairLike {
  section: FenceSection;
  kind: FenceKind;
  before: RawFence | null;
}

interface Source {
  column: string | null;
  text: string;
  /** Free to move: invalid in its column, unmapped, or from a misaligned row. */
  movable: boolean;
  used: boolean;
}

interface RowCheck {
  pair: PairLike;
  kind: FenceKind;
  ctx: ValidateCtx;
  aligned: boolean;
  sources: Source[];
  byColumn: Map<string, Source>;
  named: (column: string) => boolean;
  /** Before word `kind_map` rewrote (facts), for the `context` check. */
  kindWord: string | null;
  failed: string[];
}

const SKIP = new Set(['claim', '#']);

/** Columns of `after` that gate (f) rejects for this before row (empty when the row passes). */
export function cellsChanged(pair: PairLike, before: RawRow, after: RawRow, ctx: ValidateCtx): string[] {
  const check = rowCheck(pair, before, ctx);
  const columns = [...after.byColumn.keys()].filter(c => !SKIP.has(c));
  const ordered = [...columns.filter(c => c !== 'context'), ...columns.filter(c => c === 'context')];
  for (const column of ordered) {
    const text = collapse(after.byColumn.get(column)!.text);
    const ok = column === 'context' && check.kind === 'facts' ? contextOk(check, text) : cellOk(check, column, text);
    if (!ok) check.failed.push(column);
  }
  for (const cell of after.extra) {
    const text = collapse(cell.text);
    const kept = check.sources.find(s => !s.used && s.text === text);
    if (kept) use(kept);
    else if (text) check.failed.push('extra');
  }
  for (const s of check.sources) if (!s.used && s.text) check.failed.push(s.column ?? 'extra');
  return check.failed;
}

function rowCheck(pair: PairLike, row: RawRow, ctx: ValidateCtx): RowCheck {
  const aligned = !row.beforeHeader && row.shape === 'ok';
  const byColumn = new Map<string, Source>();
  const sources: Source[] = [];
  for (const [column, cell] of row.byColumn) {
    if (SKIP.has(column)) continue;
    const source = { column, text: collapse(cell.text), movable: !aligned || !cellValid(pair.kind, column, cell.text), used: false };
    sources.push(source);
    byColumn.set(column, source);
  }
  for (const cell of row.extra) sources.push({ column: null, text: collapse(cell.text), movable: true, used: false });
  return { pair, kind: pair.kind, ctx, aligned, sources, byColumn, named: namer(pair, row, ctx), kindWord: null, failed: [] };
}

/** An issue names this row and column: same line, or a fence-level issue (begin or header line). */
function namer(pair: PairLike, row: RawRow, ctx: ValidateCtx): (column: string) => boolean {
  const fenceLines = new Set([pair.before?.begin.line, pair.before?.header?.line].filter(n => n !== undefined));
  const issues = ctx.issues.filter(i => i.fence === pair.kind && i.section === pair.section && i.line !== null
    && (i.line === row.line || (i.row === null && fenceLines.has(i.line))));
  return column => issues.some(i => i.column === null || i.column === column);
}

function cellOk(check: RowCheck, column: string, text: string): boolean {
  const own = check.byColumn.get(column);
  if (check.aligned && own && !own.movable && own.text !== text) return ruleChange(check, column, own, text);
  if (own && !own.used && own.text === text) return use(own);
  // A misaligned row realigns by moving text unchanged; prefer that over a rule rewriting this column's own cell,
  // or an empty kind cell (kind_map reads it as `fact`) would claim the column and strand the real `fact` cell.
  const exact = check.aligned ? undefined : check.sources.find(s => !s.used && s.movable && s !== own && s.text === text);
  if (exact) return use(exact);
  if (own && !own.used && ruleChange(check, column, own, text)) return true;
  const moved = check.sources.find(s => !s.used && s.movable && s !== own
    && (s.text === text || (!check.aligned && check.named(column) && ruleFits(check, column, s, text))));
  if (moved) return noteKind(check, column, moved, text) && use(moved);
  if (!text) return true;
  return absentFromHeader(check, column) && COLUMN_DEFAULTS[check.kind][column] === text;
}

/** A named rule rewrote `source` into `text` in its own column. */
function ruleChange(check: RowCheck, column: string, source: Source, text: string): boolean {
  if (source.used || !check.named(column) || !ruleFits(check, column, source, text)) return false;
  return noteKind(check, column, source, text) && use(source);
}

function ruleFits(check: RowCheck, column: string, source: Source, text: string): boolean {
  return ruleOutputs(check.kind, column, source.text, check.ctx).some(o => collapse(o.text) === text);
}

function noteKind(check: RowCheck, column: string, source: Source, text: string): boolean {
  if (check.kind === 'facts' && column === 'kind' && factsKindMap(source.text) === text && !cellValid('facts', 'kind', source.text)) {
    check.kindWord = source.text;
  }
  return true;
}

function use(source: Source): true {
  source.used = true;
  return true;
}

/** The before layout has no such column (so its write default may appear). */
function absentFromHeader(check: RowCheck, column: string): boolean {
  const fence = check.pair.before;
  return !fence?.header || !fence.columns.includes(column);
}

/** Facts `context`: unchanged, or the before context with `kind_map`'s original word appended (required when it ran). */
function contextOk(check: RowCheck, text: string): boolean {
  const own = check.byColumn.get('context');
  const candidates = own && !own.used ? [own] : [];
  if (!check.aligned) candidates.push(...check.sources.filter(s => !s.used && s !== own));
  const empty: Source = { column: 'context', text: '', movable: false, used: false };
  for (const source of [...candidates, empty]) {
    const expected = collapse(check.kindWord === null ? source.text : appendOriginalKind(source.text, check.kindWord));
    if (expected === text) return source === empty || use(source);
  }
  return false;
}
