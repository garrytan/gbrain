/**
 * Content Tier 1 rules over both sections of a page (#6188): `header_alias`
 * and `column_default` (header level), the cell rules in rules.ts, and
 * prior-aware `renumber` across body and timeline. Of two rows sharing a
 * number, the one matching the stored row keeps it; otherwise a row in a
 * fence that parses clean keeps it (Invariant 0), and the first occurrence
 * only breaks the remaining tie. A `superseded by #N` reference that names a
 * shared number is ambiguous, except inside a fence `merge_fences` built
 * (#6377): there it names its own before-fence's row N and follows that
 * row's new number (or the number of the kept row a dropped duplicate N
 * equalled).
 *
 * Cells are edited in place by source span; a row is re-rendered only when
 * its header is rewritten, and then every cell keeps its source text and only
 * moves into canonical order. Nothing is re-rendered through
 * `renderFactsTable` / `renderTakesFence`.
 */
import { parseFactsFence } from '../facts-fence.ts';
import { stripStrikethrough } from '../fence-shared.ts';
import { parseTakesFence } from '../takes-fence.ts';
import type { MergeOrigins } from './merge.ts';
import { planRowRules, type CellText, type RowPlan } from './rules.ts';
import { extractRawRows, rowNumOf, type RawFence, type RawRow, type RawSection } from './raw-rows.ts';
import { ALLOWED, BASE_WIDTH, canonicalColumn, CANONICAL_HEADER, collapse, COLUMN_DEFAULTS, COLUMNS, supersededRef } from './schema.ts';
import { headerlessMisfit } from './stray-cells.ts';
import { applyEdits, fenceBlocked, type Edit } from './structure.ts';
import type { FenceCtx, FenceFix, FenceIssue, FenceKind, FenceReason, FenceSection } from './types.ts';

export interface ContentResult {
  texts: Record<FenceSection, string>;
  fixes: FenceFix[];
  residual: FenceIssue[];
}

/** Header rewrite plan for a fence whose header is out of canonical order. */
interface Rewrite {
  target: readonly string[];
  defaults: string[];
}

interface RowWork {
  fence: RawFence;
  row: RawRow;
  num: number | null;
  plan: RowPlan | null;
  /** May take a new number (aligned, in a workable fence, not hidden). */
  eligible: boolean;
  needsNumber: boolean;
  /** The row's fence parses with no warning (Invariant 0 prefers to leave it alone). */
  clean: boolean;
  /** Index of the before fence the row came from, when `merge_fences` built its fence; null otherwise. */
  origin: number | null;
  newNum?: number;
  /** The `superseded by #N` reference the row carries now names this number. */
  refTo?: number;
}

interface FenceWork {
  fence: RawFence;
  rewrite: Rewrite | null;
  rows: RowWork[];
}

interface Pass {
  ctx: FenceCtx;
  fixes: FenceFix[];
  residual: FenceIssue[];
  edits: Record<FenceSection, Edit[]>;
  works: FenceWork[];
  /** All rows of each kind in page order (body first), workable or not. */
  rows: Record<FenceKind, RowWork[]>;
  merges: readonly MergeOrigins[];
  /** Next number to hand out; one counter for both kinds, so no new number repeats on the page. */
  next: number | null;
  nextNumber: () => number;
}

const REPORTED: ReadonlySet<FenceReason> = new Set(['row_before_header', 'no_header', 'short_row', 'extra_cells']);

/** Plan and apply the content rules; `nextNumber` is called only when a row needs a new number. */
export function contentPass(texts: Record<FenceSection, string>, ctx: FenceCtx, nextNumber: () => number, merges: readonly MergeOrigins[] = []): ContentResult {
  const pass: Pass = { ctx, fixes: [], residual: [], edits: { body: [], timeline: [] }, works: [], rows: { facts: [], takes: [] }, next: null, nextNumber, merges };
  for (const section of ['body', 'timeline'] as const) planSection(pass, extractRawRows(texts[section], section));
  for (const kind of ['facts', 'takes'] as const) renumber(pass, kind);
  for (const work of pass.works) emitFence(pass, work);
  return {
    texts: { body: applyEdits(texts.body, pass.edits.body), timeline: applyEdits(texts.timeline, pass.edits.timeline) },
    fixes: pass.fixes,
    residual: pass.residual,
  };
}

function issueAt(fence: RawFence, reason: FenceReason, line: number | null, row: number | null = null, column: string | null = null, allowed?: readonly string[]): FenceIssue {
  const out: FenceIssue = { fence: fence.kind, section: fence.section, row, column, line, reason };
  return allowed ? { ...out, allowed } : out;
}

function planSection(pass: Pass, raw: RawSection): void {
  pass.residual.push(...raw.issues);
  for (const fence of raw.fences) {
    if (!fence.primary) continue;
    pass.residual.push(...fence.issues.filter(i => i.reason === 'repeated_marker'));
    const balanced = fence.end !== null && !fence.begin.nearMiss && !fence.end.nearMiss;
    const workable = balanced && !fenceBlocked(raw, fence) && fenceWorkable(pass, fence);
    if (balanced) pass.residual.push(...fence.issues.filter(i => REPORTED.has(i.reason)), ...headerlessIssues(fence));
    const rewrite = workable && fence.needsRewrite ? planRewrite(fence) : null;
    const clean = (fence.kind === 'facts' ? parseFactsFence(raw.text) : parseTakesFence(raw.text)).warnings.length === 0;
    const merged = mergeOf(pass, fence);
    const rows = fence.rows.map(row => rowWork(pass, fence, row, workable, clean, merged?.origins[row.occurrence] ?? null));
    pass.rows[fence.kind].push(...rows);
    if (workable) pass.works.push({ fence, rewrite, rows });
  }
}

/** Rows of a fence with no header that cannot be read by position (stray-cells.ts), held as manual. */
function headerlessIssues(fence: RawFence): FenceIssue[] {
  return fence.rows.flatMap(row => {
    const misfit = headerlessMisfit(fence, row);
    if (!misfit) return [];
    return [misfit === 'claim_split' ? issueAt(fence, misfit, row.line, rowNumOf(fence, row), 'kind', ALLOWED[fence.kind].kind) : issueAt(fence, misfit, row.line, rowNumOf(fence, row))];
  });
}

/** A balanced fence the content rules may edit; reports why not otherwise. */
function fenceWorkable(pass: Pass, fence: RawFence): boolean {
  if (!fence.header) return false;
  const headerLine = fence.header.line;
  if (fence.kind === 'facts' && takesShaped(fence)) {
    pass.residual.push(issueAt(fence, 'takes_in_facts', headerLine));
    return false;
  }
  if (!fence.needsRewrite) return true;
  if (fence.columns.some(c => c === null)) {
    pass.residual.push(issueAt(fence, 'header_unmapped', headerLine, null, null, COLUMNS[fence.kind]));
    return false;
  }
  const missing = fence.kind === 'takes' ? (['who', 'weight'] as const).filter(c => !fence.columns.includes(c)) : [];
  for (const column of missing) pass.residual.push(issueAt(fence, column === 'who' ? 'holder_missing' : 'weight_missing', headerLine, null, column));
  return !missing.length && fence.rows.every(r => r.beforeHeader || r.shape === 'ok');
}

/** A takes table (a holder column, no facts-only columns) inside a facts fence. */
function takesShaped(fence: RawFence): boolean {
  const cells = fence.header!.cells.map(c => c.text);
  const facts = cells.map(c => canonicalColumn('facts', c));
  return cells.some(c => canonicalColumn('takes', c) === 'who') && !facts.includes('visibility') && !facts.includes('notability');
}

function planRewrite(fence: RawFence): Rewrite {
  const { kind } = fence;
  const wide = fence.columns.some(c => c !== null && COLUMNS[kind].indexOf(c) >= BASE_WIDTH[kind]);
  const target = COLUMNS[kind].slice(0, wide ? COLUMNS[kind].length : BASE_WIDTH[kind]);
  const defaults = Object.keys(COLUMN_DEFAULTS[kind]).filter(c => !fence.columns.includes(c));
  return { target, defaults };
}

function mergeOf(pass: Pass, fence: RawFence): MergeOrigins | undefined {
  return pass.merges.find(m => m.section === fence.section && m.kind === fence.kind);
}

function rowWork(pass: Pass, fence: RawFence, row: RawRow, workable: boolean, clean: boolean, origin: number | null): RowWork {
  const num = rowNumOf(fence, row);
  const aligned = workable && !row.beforeHeader && row.shape === 'ok';
  const plan = aligned ? planRowRules(fence.kind, cellTexts(row), pass.ctx) : null;
  const hidden = num !== null && (pass.ctx.hiddenRows?.has(num) ?? false);
  const minted = aligned && !fence.columns.includes('#') && fence.needsRewrite;
  return { fence, row, num, plan, eligible: aligned && !hidden, needsNumber: minted || (plan?.badNumber ?? false), clean, origin };
}

function cellTexts(row: RawRow): Map<string, CellText> {
  return new Map([...row.byColumn].map(([column, cell]) => [column, { raw: cell.raw, text: cell.text }]));
}

/** Claim text the stored map is keyed by: strikethrough stripped, whitespace collapsed. */
function claimKey(row: RawRow): string {
  return collapse(stripStrikethrough(row.byColumn.get('claim')?.text ?? '').text);
}

const REF_COLUMN: Record<FenceKind, string> = { facts: 'context', takes: 'source' };

function refOf(kind: FenceKind, w: RowWork): number | null {
  return supersededRef(w.row.byColumn.get(REF_COLUMN[kind])?.text ?? '');
}

function renumber(pass: Pass, kind: FenceKind): void {
  const rows = pass.rows[kind];
  // A reference from outside a merged fence makes any shared number it names ambiguous; a merged row's reference is resolved to its own before fence below.
  const refs = new Set(rows.filter(w => w.origin === null).map(w => refOf(kind, w)).filter(n => n !== null));
  const groups = new Map<number, RowWork[]>();
  for (const w of rows) if (w.num !== null) groups.set(w.num, [...(groups.get(w.num) ?? []), w]);
  const targets = new Map<RowWork, RowWork>();
  for (const w of rows) {
    const num = w.origin === null ? null : refOf(kind, w);
    if (num === null) continue;
    const target = localTarget(pass, kind, w, num, groups);
    if (target === 'ambiguous') pass.residual.push(issueAt(w.fence, 'superseded_ambiguous', w.row.line, num, '#'));
    else if (target) targets.set(w, target);
  }
  for (const [num, group] of groups) {
    if (group.length < 2) continue;
    if (refs.has(num)) {
      for (const w of group) pass.residual.push(issueAt(w.fence, 'superseded_ambiguous', w.row.line, num, '#'));
      continue;
    }
    const stored = pass.ctx.storedRows?.[kind].get(num);
    const keeper = group.find(w => stored !== undefined && claimKey(w.row) === collapse(stored))
      ?? group.find(w => w.clean) ?? group[0]!;
    for (const w of group) {
      if (w === keeper) continue;
      if (w.eligible) w.needsNumber = true;
      else if (pass.ctx.hiddenRows?.has(num)) pass.residual.push(issueAt(w.fence, 'row_collision', w.row.line, num, '#'));
    }
  }
  for (const w of rows) {
    if (!w.needsNumber || !w.eligible) continue;
    pass.next ??= pass.nextNumber();
    w.newNum = pass.next++;
  }
  for (const [w, target] of targets) {
    const final = finalNum(target);
    if (final === null || final === refOf(kind, w)) continue;
    if (!w.plan) {
      pass.residual.push(issueAt(w.fence, 'superseded_ambiguous', w.row.line, refOf(kind, w), '#'));
      continue;
    }
    w.refTo = final;
  }
}

/**
 * The row a merged row's `superseded by #N` names: the one row numbered N of
 * its own before fence, or the kept row a dropped duplicate numbered N of
 * that fence equalled. With neither, N must not be a shared number.
 */
function localTarget(pass: Pass, kind: FenceKind, w: RowWork, num: number, groups: ReadonlyMap<number, RowWork[]>): RowWork | 'ambiguous' | null {
  const merged = mergeOf(pass, w.fence)!;
  const section = pass.rows[kind].filter(r => r.fence.section === w.fence.section);
  const own = section.filter(r => r.origin === w.origin && r.num === num);
  const dropped = merged.dropped.filter(d => d.fence === w.origin && d.num === num).map(d => section[d.keptOccurrence]!);
  const candidates = [...own, ...dropped];
  if (candidates.length > 1) return 'ambiguous';
  if (candidates.length === 1) return candidates[0]!;
  return (groups.get(num)?.length ?? 0) > 1 ? 'ambiguous' : null;
}

/** The reference cell rewritten to the row's new number, on top of any rule change to the same cell. */
function refEdit(w: RowWork, kind: FenceKind): void {
  const column = REF_COLUMN[kind];
  const change = w.plan!.changes.find(c => c.column === column);
  const raw = (change?.raw ?? w.row.byColumn.get(column)?.raw ?? '').replace(/(superseded by #)\d+/i, `$1${w.refTo}`);
  if (change) change.raw = raw;
  else w.plan!.changes.push({ column, raw, class: 'renumber' });
}

/** The number the row was written with (`0` and negatives included), or null when the cell is not numeric or absent. */
function writtenNum(row: RawRow): number | null {
  const n = parseInt(row.byColumn.get('#')?.text ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

function finalNum(w: RowWork): number | null {
  return w.newNum ?? w.num;
}

function emitFence(pass: Pass, work: FenceWork): void {
  const { fence } = work;
  if (work.rewrite) emitRewrite(pass, fence, work.rewrite);
  for (const w of work.rows) {
    if (!w.plan) continue;
    const row = finalNum(w);
    if (w.newNum !== undefined) {
      pass.fixes.push({ fence: fence.kind, section: fence.section, row, column: '#', line: w.row.line, class: 'renumber', from: writtenNum(w.row) });
    }
    if (w.refTo !== undefined) {
      refEdit(w, fence.kind);
      pass.fixes.push({ fence: fence.kind, section: fence.section, row, column: REF_COLUMN[fence.kind], line: w.row.line, class: 'renumber' });
    }
    for (const change of w.plan.changes) {
      if (change.column === 'context' && change.class === 'kind_map') continue;
      if (change.column === REF_COLUMN[fence.kind] && change.class === 'renumber') continue;
      pass.fixes.push({ fence: fence.kind, section: fence.section, row, column: change.column, line: w.row.line, class: change.class });
    }
    for (const i of w.plan.issues) pass.residual.push(issueAt(fence, i.reason, w.row.line, row, i.column, i.allowed));
    if (work.rewrite) pass.edits[fence.section].push(renderRow(w, work.rewrite));
    else pass.edits[fence.section].push(...cellEdits(w));
  }
}

function emitRewrite(pass: Pass, fence: RawFence, rewrite: Rewrite): void {
  const header = fence.header!;
  const wide = rewrite.target.length > BASE_WIDTH[fence.kind];
  const text = CANONICAL_HEADER[fence.kind];
  pass.edits[fence.section].push({ start: header.start, end: header.end, text: wide ? text.wide : text.narrow });
  const sep = fence.separators.find(s => s.line === header.line + 1);
  if (sep) pass.edits[fence.section].push({ start: sep.start, end: sep.end, text: wide ? text.wideSep : text.narrowSep });
  const at = { fence: fence.kind, section: fence.section, row: null, line: header.line };
  pass.fixes.push({ ...at, column: null, class: 'header_alias' });
  for (const column of rewrite.defaults) pass.fixes.push({ ...at, column, class: 'column_default' });
}

/** The row re-rendered in canonical column order from its own source cells. */
function renderRow(w: RowWork, rewrite: Rewrite): Edit {
  const changes = new Map(w.plan!.changes.map(c => [c.column, c.raw]));
  const defaults = COLUMN_DEFAULTS[w.fence.kind];
  const cells = rewrite.target.map(column => {
    if (column === '#' && w.newNum !== undefined) return String(w.newNum);
    return changes.get(column) ?? w.row.byColumn.get(column)?.raw ?? defaults[column] ?? '';
  });
  return { start: w.row.start, end: w.row.end, text: `| ${cells.join(' | ')} |` };
}

/** In-place cell edits; a facts context the row lacks is appended as its last cell. */
function cellEdits(w: RowWork): Edit[] {
  const edits: Edit[] = [];
  const { row } = w;
  const num = row.byColumn.get('#');
  if (w.newNum !== undefined && num) edits.push({ start: num.start, end: num.end, text: String(w.newNum) });
  for (const change of w.plan!.changes) {
    const cell = row.byColumn.get(change.column);
    if (cell) edits.push({ start: cell.start, end: cell.end, text: change.raw });
    else edits.push({ start: row.end, end: row.end, text: row.closed ? ` ${change.raw} |` : ` | ${change.raw}` });
  }
  return edits;
}
