/**
 * Lenient raw-row extraction of facts/takes fences (#6188).
 *
 * The repair rules and the validator gates work on this view, never on the
 * strict parsers' output and never on their warning strings (which embed row
 * text). For each fence a section holds it returns the markers (located
 * outside markdown code, like every fence reader), the before-region (begin
 * marker to end marker, or to the end of the section when the end marker is
 * missing), the header and its canonical column map (positional when no
 * header is recognizable), rows before the header, and every row's cells
 * with their source spans. A row's identity is its ordinal among the fence's
 * data rows, so it survives renumbering and duplicate claims.
 *
 * `accepted` replays the strict parser on the same region, so a row is
 * accepted exactly when `parseFactsFence` / `parseTakesFence` would return it.
 */
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { indexOfOutsideCode, scanMarkdownCode, type MarkdownCodeMap } from '../fence-scan.ts';
import { isSeparatorRow } from '../fence-shared.ts';
import { BASE_WIDTH, canonicalColumn, cellValid, COLUMNS, MIN_CELLS, NAMED_COLUMNS, parseRowNum, TOLERATED_TRAILING } from './schema.ts';
import type { FenceIssue, FenceKind, FenceReason, FenceSection } from './types.ts';

export const MARKERS: Record<FenceKind, { begin: string; end: string }> = {
  facts: { begin: FACTS_FENCE_BEGIN, end: FACTS_FENCE_END },
  takes: { begin: TAKES_FENCE_BEGIN, end: TAKES_FENCE_END },
};
/** The two-dash takes markers authors write from memory (#3769). */
const NEAR_MISS = { begin: /^<!--\s*gbrain:takes:begin\s*-->$/, end: /^<!--\s*gbrain:takes:end\s*-->$/ };

export interface RawCell {
  /** Cell text as `parseRowCells` reads it: trimmed, `\|` unescaped, `<br>` decoded. */
  text: string;
  /** Trimmed source text of the cell, escapes kept. */
  raw: string;
  /** Offsets of `raw` in the section. */
  start: number;
  end: number;
}

export interface RawRow {
  /** 1-based line in the section. */
  line: number;
  /** Offsets of the trimmed line in the section. */
  start: number;
  end: number;
  cells: RawCell[];
  /** The trimmed line ends with the pipe `parseRowCells` strips. */
  closed: boolean;
  /** Ordinal among the fence's data rows (rows before the header first); -1 for header and separator lines. */
  occurrence: number;
  /** Sits before the header (every row of a fence with no recognizable header). */
  beforeHeader: boolean;
  /** Cell for each canonical column the row fills. */
  byColumn: Map<string, RawCell>;
  /** Cells that map to no column. */
  extra: RawCell[];
  /** Row-shape problem that makes column positions untrustworthy. */
  shape: 'ok' | 'short_row' | 'extra_cells';
  /** The strict parser returns this row. */
  accepted: boolean;
}

export interface RawMarker {
  start: number;
  end: number;
  line: number;
  /** A two-dash takes marker rather than the canonical three-dash form. */
  nearMiss: boolean;
}

export interface RawFence {
  kind: FenceKind;
  section: FenceSection;
  /** The fence the strict parser reads (later ones are repeats). */
  primary: boolean;
  begin: RawMarker;
  end: RawMarker | null;
  /** The before-region: just after the begin marker to the end marker, or to the section end. */
  regionStart: number;
  regionEnd: number;
  header: RawRow | null;
  /** The strict parser recognizes `header` (its cells include `claim` and `kind`). */
  strictHeader: boolean;
  /** Canonical column per header cell; COLUMNS[kind] when there is no header. */
  columns: Array<string | null>;
  /** The header is not the strict canonical layout (alias-only, out of order, or missing whole columns), so a header rewrite is needed. */
  needsRewrite: boolean;
  separators: RawRow[];
  /** Data rows in order (header and separators excluded). */
  rows: RawRow[];
  issues: FenceIssue[];
}

export interface RawSection {
  section: FenceSection;
  text: string;
  fences: RawFence[];
  /** Marker problems that belong to no extractable fence. */
  issues: FenceIssue[];
}

/** Extract every facts and takes fence of one section. */
export function extractRawRows(text: string, section: FenceSection = 'body'): RawSection {
  const out: RawSection = { section, text, fences: [], issues: [] };
  if (!text.includes('gbrain:facts:') && !text.includes('gbrain:takes:')) return out;
  const code = scanMarkdownCode(text);
  const lines = new LineIndex(text);
  for (const kind of ['facts', 'takes'] as const) extractKind(out, kind, code, lines);
  return out;
}

/** The primary fence of a kind, or null. */
export function primaryFence(raw: RawSection, kind: FenceKind): RawFence | null {
  return raw.fences.find(f => f.kind === kind && f.primary) ?? null;
}

class LineIndex {
  private readonly starts: number[] = [0];
  constructor(readonly text: string) {
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) this.starts.push(i + 1);
  }
  /** 1-based line holding offset `at`. */
  lineOf(at: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= at) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }
  /** Trimmed bounds of the line holding `at`. */
  trimmedLine(at: number): { start: number; end: number } {
    const lineStart = this.starts[this.lineOf(at) - 1]!;
    const nl = this.text.indexOf('\n', at);
    const lineEnd = nl === -1 ? this.text.length : nl;
    const raw = this.text.slice(lineStart, lineEnd);
    const lead = raw.length - raw.trimStart().length;
    return { start: lineStart + lead, end: lineStart + raw.trimEnd().length };
  }
}

function issue(kind: FenceKind, section: FenceSection, reason: FenceReason, line: number | null, row: number | null = null, column: string | null = null): FenceIssue {
  return { fence: kind, section, row, column, line, reason };
}

function countOutsideCode(text: string, needle: string, code: MarkdownCodeMap): number[] {
  const at: number[] = [];
  for (let i = indexOfOutsideCode(text, needle, 0, code); i !== -1; i = indexOfOutsideCode(text, needle, i + needle.length, code)) at.push(i);
  return at;
}

function extractKind(out: RawSection, kind: FenceKind, code: MarkdownCodeMap, lines: LineIndex): void {
  const { text, section } = out;
  const { begin, end } = MARKERS[kind];
  const begins = countOutsideCode(text, begin, code);
  const ends = countOutsideCode(text, end, code);
  const first = begins.length ? marker(begins[0]!, begin.length, lines, false) : kind === 'takes' ? nearMissBegin(out, code, lines) : null;
  if (ends.length && (!first || ends[0]! < first.start)) {
    out.issues.push(issue(kind, section, 'missing_begin', lines.lineOf(ends[0]!)));
  }
  if (!first) return;
  let cursor: RawMarker | null = first;
  while (cursor) {
    const fence = buildFence(out, kind, cursor, code, lines, out.fences.every(f => f.kind !== kind));
    out.fences.push(fence);
    if (!fence.end) break;
    const next = indexOfOutsideCode(text, begin, fence.end.end, code);
    cursor = next === -1 ? null : marker(next, begin.length, lines, false);
  }
  const primary = out.fences.find(f => f.kind === kind && f.primary)!;
  const repeats = [begin, end].flatMap(m => countOutsideCode(text, m, code).slice(1));
  if (repeats.length) primary.issues.unshift(issue(kind, section, 'repeated_marker', lines.lineOf(Math.min(...repeats))));
}

function marker(at: number, length: number, lines: LineIndex, nearMiss: boolean): RawMarker {
  return { start: at, end: at + length, line: lines.lineOf(at), nearMiss };
}

/** A two-dash takes begin marker standing alone on its line, when no canonical begin exists. */
function nearMissBegin(out: RawSection, code: MarkdownCodeMap, lines: LineIndex): RawMarker | null {
  if (!out.text.includes('gbrain:takes:begin')) return null;
  const at = indexOfOutsideCode(out.text, 'gbrain:takes:begin', 0, code);
  if (at === -1) return null;
  const bounds = lines.trimmedLine(at);
  if (NEAR_MISS.begin.test(out.text.slice(bounds.start, bounds.end))) {
    return { ...bounds, line: lines.lineOf(at), nearMiss: true };
  }
  out.issues.push(issue('takes', out.section, 'marker_near_miss', lines.lineOf(at)));
  return null;
}

function findEnd(text: string, kind: FenceKind, from: number, code: MarkdownCodeMap, lines: LineIndex): RawMarker | null {
  const end = MARKERS[kind].end;
  const at = indexOfOutsideCode(text, end, from, code);
  if (at !== -1) return marker(at, end.length, lines, false);
  if (kind !== 'takes') return null;
  for (let i = indexOfOutsideCode(text, 'gbrain:takes:end', from, code); i !== -1; i = indexOfOutsideCode(text, 'gbrain:takes:end', i + 1, code)) {
    const bounds = lines.trimmedLine(i);
    if (NEAR_MISS.end.test(text.slice(bounds.start, bounds.end))) return { ...bounds, line: lines.lineOf(i), nearMiss: true };
  }
  return null;
}

function buildFence(out: RawSection, kind: FenceKind, begin: RawMarker, code: MarkdownCodeMap, lines: LineIndex, primary: boolean): RawFence {
  const end = findEnd(out.text, kind, begin.end, code, lines);
  const fence: RawFence = {
    kind, section: out.section, primary, begin, end,
    regionStart: begin.end, regionEnd: end ? end.start : out.text.length,
    header: null, strictHeader: false, columns: [...COLUMNS[kind]], needsRewrite: false,
    separators: [], rows: [], issues: [],
  };
  const pipeLines = regionRows(out.text, fence.regionStart, fence.regionEnd, lines);
  classifyLines(fence, pipeLines);
  markAccepted(fence, pipeLines);
  return fence;
}

/** Every pipe-table line of a region, parsed with source spans. */
function regionRows(text: string, start: number, end: number, lines: LineIndex): RawRow[] {
  const rows: RawRow[] = [];
  let lineNo = lines.lineOf(start);
  for (let at = start; at <= end; lineNo++) {
    const nl = text.indexOf('\n', at);
    const lineEnd = nl === -1 || nl > end ? end : nl;
    const row = parseRowSpans(text, at, lineEnd, lineNo);
    if (row) rows.push(row);
    if (lineEnd === end) break;
    at = lineEnd + 1;
  }
  return rows;
}

/** `parseRowCells` with offsets: null unless the trimmed line starts with `|` and has a second pipe. */
export function parseRowSpans(text: string, lineStart: number, lineEnd: number, line: number): RawRow | null {
  const rawLine = text.slice(lineStart, lineEnd);
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith('|') || !trimmed.includes('|', 1)) return null;
  const start = lineStart + (rawLine.length - rawLine.trimStart().length);
  const end = start + trimmed.length;
  const closed = trimmed.length >= 2 && trimmed.endsWith('|');
  const cells: RawCell[] = [];
  const innerEnd = closed ? end - 1 : end;
  let cellStart = start + 1;
  for (let i = start + 1; i <= innerEnd; i++) {
    if (i < innerEnd && text[i] === '\\' && text[i + 1] === '|' && i + 1 < innerEnd) { i++; continue; }
    if (i < innerEnd && text[i] !== '|') continue;
    cells.push(cellAt(text, cellStart, i));
    cellStart = i + 1;
  }
  return { line, start, end, cells, closed, occurrence: -1, beforeHeader: false, byColumn: new Map(), extra: [], shape: 'ok', accepted: false };
}

function cellAt(text: string, from: number, to: number): RawCell {
  const slice = text.slice(from, to);
  const raw = slice.trim();
  const lead = slice.length - slice.trimStart().length;
  const start = raw ? from + lead : from + Math.min(1, slice.length);
  return { raw, start, end: start + raw.length, text: raw.replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n') };
}

function strictHeaderCells(row: RawRow): boolean {
  const lower = row.cells.map(c => c.text.toLowerCase());
  return lower.includes('claim') && lower.includes('kind');
}

function aliasHeaderCells(kind: FenceKind, row: RawRow): boolean {
  const mapped = row.cells.map(c => canonicalColumn(kind, c.text));
  return mapped.every(c => c !== null) && mapped.includes('claim') && mapped.includes('kind');
}

function classifyLines(fence: RawFence, pipeLines: RawRow[]): void {
  const { kind } = fence;
  const headerAt = pipeLines.findIndex(r => !isSeparatorRow(r.cells.map(c => c.text)) && (strictHeaderCells(r) || aliasHeaderCells(kind, r)));
  if (headerAt !== -1) setHeader(fence, pipeLines[headerAt]!);
  pipeLines.forEach((row, i) => {
    if (i === headerAt) return;
    const separator = isSeparatorRow(row.cells.map(c => c.text));
    row.beforeHeader = headerAt === -1 || i < headerAt;
    if (row.beforeHeader && pipeLines.length && headerAt !== -1) {
      fence.issues.push(issue(kind, fence.section, 'row_before_header', row.line, rowNumOf(fence, row)));
    }
    if (separator) { fence.separators.push(row); return; }
    row.occurrence = fence.rows.length;
    mapRow(fence, row);
    fence.rows.push(row);
  });
  if (headerAt === -1 && fence.rows.length) fence.issues.push(issue(kind, fence.section, 'no_header', fence.begin.line));
}

function setHeader(fence: RawFence, header: RawRow): void {
  const { kind } = fence;
  fence.header = header;
  fence.strictHeader = strictHeaderCells(header);
  const seen = new Set<string>();
  fence.columns = header.cells.map(cell => {
    const column = canonicalColumn(kind, cell.text);
    if (!column || seen.has(column)) return null;
    seen.add(column);
    return column;
  });
  // A header shorter than the narrowest row the parser reads leaves whole columns absent.
  fence.needsRewrite = !fence.strictHeader || !canonicalOrder(kind, fence.columns) || fence.columns.length < MIN_CELLS[kind];
}

/** The header puts every column the strict parser reads by position at its canonical position. */
function canonicalOrder(kind: FenceKind, columns: Array<string | null>): boolean {
  const canonical = COLUMNS[kind];
  const named = NAMED_COLUMNS[kind];
  return columns.every((column, i) => {
    if (kind === 'takes' && i >= 7) return column === null || named.has(column);
    if (i >= canonical.length) return true;
    return column === canonical[i];
  });
}

/** Row number in the `#` column, or null. */
export function rowNumOf(fence: RawFence, row: RawRow): number | null {
  const at = fence.columns.indexOf('#');
  const cell = at === -1 ? undefined : row.cells[at];
  return cell ? parseRowNum(cell.text) : null;
}

function mapRow(fence: RawFence, row: RawRow): void {
  const { kind } = fence;
  const positional = !fence.header || !fence.needsRewrite;
  row.cells.forEach((cell, j) => {
    const column = positional ? positionalColumn(fence, j) : fence.columns[j] ?? null;
    if (column && !row.byColumn.has(column)) row.byColumn.set(column, cell);
    else row.extra.push(cell);
  });
  if (row.beforeHeader) return;
  row.shape = rowShape(fence, row);
  if (row.shape !== 'ok') fence.issues.push(issue(kind, fence.section, row.shape, row.line, rowNumOf(fence, row)));
}

/** The column the strict parser reads at index `j` (takes resolution columns by header name). */
function positionalColumn(fence: RawFence, j: number): string | null {
  const canonical = COLUMNS[fence.kind];
  if (fence.kind === 'takes' && j >= 7) return fence.header ? (fence.columns[j] ?? null) : null;
  return canonical[j] ?? null;
}

function rowShape(fence: RawFence, row: RawRow): RawRow['shape'] {
  const { kind } = fence;
  const headerLen = fence.columns.length;
  if (!fence.needsRewrite) {
    if (row.cells.length < MIN_CELLS[kind]) return 'short_row';
    // Facts rows of 14 cells are the typed layout even under a narrow header.
    const layoutMax = kind === 'facts' && row.cells.length === 14 ? 14 : Math.max(headerLen, BASE_WIDTH[kind]);
    const allValid = [...row.byColumn].every(([column, cell]) => cellValid(kind, column, cell.text));
    return row.cells.length > layoutMax && !allValid ? 'extra_cells' : 'ok';
  }
  if (row.cells.length > headerLen) return 'extra_cells';
  const missing = fence.columns.slice(row.cells.length).filter((c): c is string => c !== null);
  return missing.every(c => TOLERATED_TRAILING[kind].has(c)) ? 'ok' : 'short_row';
}

/** Cells the strict parsers reject a row for, with their positions (takes holders only warn). */
const FACTS_CHECKED: ReadonlyArray<[string, number]> = [['kind', 2], ['visibility', 4], ['notability', 5], ['confidence', 3], ['claim_value', 11]];
const TAKES_CHECKED: ReadonlyArray<[string, number]> = [['kind', 2], ['weight', 4]];

/** Replay the strict parser over the region: which rows it returns. */
function markAccepted(fence: RawFence, pipeLines: RawRow[]): void {
  if (!fence.primary || !fence.end || fence.begin.nearMiss || fence.end.nearMiss) return;
  const { kind } = fence;
  const seen = new Set<number>();
  let sawHeader = false;
  for (const row of pipeLines) {
    if (!sawHeader) { sawHeader = strictHeaderCells(row); continue; }
    const texts = row.cells.map(c => c.text);
    if (isSeparatorRow(texts) || texts.length < MIN_CELLS[kind]) continue;
    const rowNum = parseRowNum(texts[0]!);
    if (rowNum === null || seen.has(rowNum)) continue;
    seen.add(rowNum);
    const checked = kind === 'facts' ? FACTS_CHECKED : TAKES_CHECKED;
    row.accepted = checked.every(([column, at]) => cellValid(kind, column, texts[at] ?? ''));
  }
}
