/**
 * Tier 1 `stray_empty_cell` (#6188): a row with more cells than its fence's
 * layout loses empty cells, but only when exactly one choice of empty cells
 * to delete leaves every validated column (`#`, kind, confidence,
 * visibility, notability, claim_value; takes kind, holder, weight) valid.
 * No choice, or two that differ, leaves the row as written, so it stays
 * residual `extra_cells` (manual): a person decides, because no gate can tell
 * a claim cut in two by an unescaped `|` from a misplaced cell.
 *
 * Only rows read by position qualify: a balanced primary fence whose header
 * is the canonical layout, or a fence with no header at all. Each deletion
 * removes the empty cell's slot (its leading pipe and whitespace), so every
 * other byte of the row stays.
 *
 * With no header nothing marks a row's shape, so `headerlessMisfit` reads a
 * row that starts with a row number positionally: a `kind` cell holding text
 * that is not a kind word is `claim_split`, and a row wider than any layout
 * (facts 10 or 14 cells, takes 7) with a validated column invalid is
 * `extra_cells`. Unless this rule lines it up, the content pass holds it as
 * manual, so a claim an unescaped `|` cut in two never reaches the model
 * (gate (b) would compare against the cut claim).
 */
import { extractRawRows, rowNumOf, type RawCell, type RawFence, type RawRow } from './raw-rows.ts';
import { kindWord } from './rules.ts';
import { BASE_WIDTH, cellValid, COLUMNS } from './schema.ts';
import { applyEdits, fenceBlocked, type Edit } from './structure.ts';
import type { FenceFix, FenceKind, FenceSection } from './types.ts';

/** Rows with more extra cells than this are left alone (the choices grow combinatorially). */
const MAX_EXTRA = 4;

export function strayCellPass(text: string, section: FenceSection): { text: string; fixes: FenceFix[] } {
  const raw = extractRawRows(text, section);
  const edits: Edit[] = [];
  const fixes: FenceFix[] = [];
  for (const fence of raw.fences) {
    if (!fence.primary || !fence.end || fence.begin.nearMiss || fence.end.nearMiss || fence.needsRewrite || fenceBlocked(raw, fence)) continue;
    for (const row of fence.rows) {
      if (fence.header ? row.beforeHeader || row.shape !== 'extra_cells' : !headerlessMisfit(fence, row)) continue;
      const removed = uniqueDeletion(fence, row);
      if (!removed) continue;
      edits.push(...removed.map(cell => slotOf(text, row, cell)));
      fixes.push({ fence: fence.kind, section, row: rowNumOf(fence, row), column: null, line: row.line, class: 'stray_empty_cell' });
    }
  }
  return { text: edits.length ? applyEdits(text, edits) : text, fixes };
}

/**
 * Why a row of a fence with no header cannot be read by position, or null:
 * only for a row that starts with a row number (the one anchor a headerless
 * row has).
 */
export function headerlessMisfit(fence: RawFence, row: RawRow): 'claim_split' | 'extra_cells' | null {
  const kind = fence.kind;
  if (fence.header || !cellValid(kind, '#', row.cells[0]?.text ?? '')) return null;
  const kindCell = row.cells[2]?.text.trim() ?? '';
  if (kindCell && !cellValid(kind, 'kind', kindCell) && !kindWord(kindCell)) return 'claim_split';
  const n = row.cells.length;
  const fits = kind === 'facts' ? n <= BASE_WIDTH.facts || n === COLUMNS.facts.length : n <= BASE_WIDTH.takes;
  return fits || row.cells.every((cell, j) => columnValid(fence, kind, j, cell.text)) ? null : 'extra_cells';
}

/** The widths a row may be cut back to: the header's layout, or with no header the narrow layout (facts 14 for a wider row). */
function layoutWidths(fence: RawFence, row: RawRow): Set<number> {
  const kind = fence.kind;
  if (!fence.header) return new Set([kind === 'facts' && row.cells.length > COLUMNS.facts.length ? COLUMNS.facts.length : BASE_WIDTH[kind]]);
  const headerLen = fence.columns.length;
  const widths = new Set([Math.max(headerLen, BASE_WIDTH[kind])]);
  if (kind === 'facts' && headerLen < COLUMNS.facts.length && row.cells.length > COLUMNS.facts.length) widths.add(COLUMNS.facts.length);
  return widths;
}

/** The empty cells to delete, when exactly one distinct result makes every validated column valid. */
function uniqueDeletion(fence: RawFence, row: RawRow): RawCell[] | null {
  const kind = fence.kind;
  const widths = layoutWidths(fence, row);
  const empty = row.cells.flatMap((cell, i) => (cell.raw ? [] : [i]));
  const valid = new Map<string, number[]>();
  for (const width of widths) {
    const extra = row.cells.length - width;
    if (extra < 1 || extra > MAX_EXTRA || extra > empty.length) continue;
    for (const drop of combinations(empty, extra)) {
      const kept = row.cells.filter((_, i) => !drop.includes(i)).map(cell => cell.text);
      if (!kept.every((cell, j) => columnValid(fence, kind, j, cell))) continue;
      const key = JSON.stringify(kept);
      if (!valid.has(key)) valid.set(key, drop);
    }
  }
  if (valid.size !== 1) return null;
  const [drop] = valid.values();
  return drop!.map(i => row.cells[i]!);
}

/** The cell at index `j` passes its column's strict check (a cell with no column, or a free-text one, passes). */
function columnValid(fence: RawFence, kind: FenceKind, j: number, text: string): boolean {
  const column = kind === 'takes' && j >= BASE_WIDTH.takes ? (fence.header ? fence.columns[j] ?? null : null) : COLUMNS[kind][j] ?? null;
  return column === null || cellValid(kind, column, text);
}

function combinations(items: readonly number[], k: number): number[][] {
  if (k === 0) return [[]];
  return items.flatMap((item, i) => combinations(items.slice(i + 1), k - 1).map(rest => [item, ...rest]));
}

/** The whole slot of an empty cell: from its leading pipe up to (not including) the next pipe or the row end. */
function slotOf(text: string, row: RawRow, cell: RawCell): Edit {
  let start = cell.start;
  while (start > row.start && text[start - 1] !== '|') start--;
  let end = cell.start;
  while (end < row.end && text[end] !== '|') end++;
  return { start: start - 1, end, text: '' };
}
