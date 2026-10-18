/**
 * Tier 1 `merge_fences` (#6377): a section that holds more than one fence of
 * a kind becomes one fence, so `repeated_marker` no longer needs a person
 * when the merge has one obvious meaning.
 *
 * The rule applies only when every fence of the kind is balanced (begin and
 * end marker, no near-miss form), every header maps to the same canonical
 * columns in the same order, every marker stands alone on its line and
 * nothing but the header, separators and rows sits inside any fence region.
 * The later fences' rows are appended to the primary fence in document
 * order; a later row whose cells (every column but `#`, trimmed source text)
 * equal a kept row's cells is dropped as a duplicate. The later fences'
 * markers and tables go, together with a section heading that repeats an
 * earlier heading directly above a removed fence, and the blank lines around
 * each removed block collapse to one. Row numbers that now collide are
 * renumbered by the content pass (`renumber`), and a `superseded by #N`
 * reference inside a merged fence follows its own fence's row N.
 *
 * `mergePlan` is the one source of the before-to-after row mapping: the
 * normalizer edits from it, the validator (`validate.ts`) re-derives it from
 * the before page to check gates (b)-(f) row by row, and the receipt carries
 * it location-only (`mergedReceipt`).
 */
import { indexOfOutsideCode, scanMarkdownCode, type MarkdownCodeMap } from '../fence-scan.ts';
import { sectionsOf } from './page-checks.ts';
import { extractRawRows, MARKERS, parseRowSpans, rowNumOf, type RawFence, type RawRow, type RawSection } from './raw-rows.ts';
import type { MergedFenceReceipt } from './receipt.ts';
import type { Edit } from './structure.ts';
import type { FenceFix, FenceKind, FencePage, FenceSection } from './types.ts';

export interface MergeRow {
  /** Index into `MergePlan.fences` (0 is the primary). */
  fence: number;
  /** The row's occurrence in that fence. */
  occurrence: number;
  row: RawRow;
  /** Occurrence in the merged fence; null for a dropped duplicate. */
  keptAs: number | null;
  /** Index into `MergePlan.rows` of the kept row this one duplicates; null for a kept row. */
  duplicateOf: number | null;
}

export interface MergePlan {
  kind: FenceKind;
  section: FenceSection;
  /** Every fence of the kind, in document order. */
  fences: RawFence[];
  /** Every row of every fence, in document order. */
  rows: MergeRow[];
}

/** What the content pass needs to know about a merged fence in the text it reads. */
export interface MergeOrigins {
  section: FenceSection;
  kind: FenceKind;
  /** Per merged-fence occurrence: the index of the fence the row came from. */
  origins: number[];
  /** Per merged-fence occurrence: the row's line in the merged section text. */
  mergedLines: number[];
  /** Per merged-fence occurrence: the row's line in the before section text. */
  beforeLines: number[];
  /** Dropped duplicates: the fence and row number each had, and the merged occurrence of the row it duplicates. */
  dropped: Array<{ fence: number; num: number | null; keptOccurrence: number }>;
}

const HEADING = /^#{1,6}\s/;
const BLANK = /^[ \t]*$/;

/** The merge of a kind's fences in one section, or null when the rule does not apply. */
export function mergePlan(raw: RawSection, kind: FenceKind): MergePlan | null {
  const fences = raw.fences.filter(f => f.kind === kind);
  if (fences.length < 2 || !fences[0]!.primary) return null;
  if (raw.issues.some(i => i.fence === kind && i.reason === 'missing_begin')) return null;
  const code = scanMarkdownCode(raw.text);
  if (countOutsideCode(raw.text, MARKERS[kind].begin, code) !== fences.length || countOutsideCode(raw.text, MARKERS[kind].end, code) !== fences.length) return null;
  const columns = fences[0]!.columns;
  for (const fence of fences) {
    if (!fence.end || fence.begin.nearMiss || fence.end.nearMiss || !fence.header) return null;
    if (fence.columns.length !== columns.length || fence.columns.some((c, i) => c === null || c !== columns[i])) return null;
    if (fence.issues.some(i => i.reason === 'row_before_header')) return null;
    if (!markerAlone(raw.text, fence.begin) || !markerAlone(raw.text, fence.end) || !tableOnly(raw.text, fence.regionStart, fence.regionEnd)) return null;
  }
  const rows: MergeRow[] = [];
  const kept = new Map<string, number>();
  let next = 0;
  fences.forEach((fence, index) => {
    for (const row of fence.rows) {
      const key = rowKey(fence, row);
      const earlier = index > 0 ? kept.get(key) : undefined;
      if (earlier !== undefined) {
        rows.push({ fence: index, occurrence: row.occurrence, row, keptAs: null, duplicateOf: earlier });
        continue;
      }
      kept.set(key, rows.length);
      rows.push({ fence: index, occurrence: row.occurrence, row, keptAs: next++, duplicateOf: null });
    }
  });
  return { kind, section: raw.section, fences, rows };
}

/** Every cell but `#` as written (trimmed source text), in column order, then the cells no column takes. */
export function rowKey(fence: RawFence, row: RawRow): string {
  const cells = fence.columns.filter((c): c is string => c !== null && c !== '#').map(c => row.byColumn.get(c)?.raw ?? '');
  return [...cells, ...row.extra.map(c => c.raw)].join('\u0000');
}

function countOutsideCode(text: string, needle: string, code: MarkdownCodeMap): number {
  let n = 0;
  for (let i = indexOfOutsideCode(text, needle, 0, code); i !== -1; i = indexOfOutsideCode(text, needle, i + needle.length, code)) n++;
  return n;
}

/** The marker is the whole of its line (so the line can go with the fence). */
function markerAlone(text: string, marker: { start: number; end: number }): boolean {
  const [start, end] = lineBounds(text, marker.start);
  return text.slice(start, end).trim() === text.slice(marker.start, marker.end);
}

/** Every non-blank line of the region is a pipe-table line. */
function tableOnly(text: string, start: number, end: number): boolean {
  for (let at = start; at < end;) {
    const nl = text.indexOf('\n', at);
    const lineEnd = nl === -1 || nl > end ? end : nl;
    if (text.slice(at, lineEnd).trim() && parseRowSpans(text, at, lineEnd, 0) === null) return false;
    if (lineEnd === end) break;
    at = lineEnd + 1;
  }
  return true;
}

/** `[start, end)` of the line holding `at`, without its line ending. */
function lineBounds(text: string, at: number): [number, number] {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const nl = text.indexOf('\n', at);
  let end = nl === -1 ? text.length : nl;
  if (end > start && text[end - 1] === '\r') end--;
  return [start, end];
}

/** Offset just past the line ending of the line holding `at` (the text end when it has none). */
function lineAfter(text: string, at: number): number {
  const nl = text.indexOf('\n', at);
  return nl === -1 ? text.length : nl + 1;
}

function lineEnding(text: string, at: number): string {
  const nl = text.indexOf('\n', at);
  return nl !== -1 && nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

/** The edits that turn the section into one fence: appended rows, removed later fences, removed repeated headings, collapsed blanks. */
export function mergeEdits(text: string, plan: MergePlan): Edit[] {
  const primary = plan.fences[0]!;
  const tail = [primary.header, ...primary.separators, ...primary.rows].filter((r): r is RawRow => r !== null).sort((a, b) => b.line - a.line)[0]!;
  const [, tailEnd] = lineBounds(text, tail.start);
  const eol = lineEnding(text, tail.start);
  const appended = plan.rows.filter(r => r.fence > 0 && r.keptAs !== null).map(r => `${eol}${text.slice(r.row.start, r.row.end)}`).join('');
  const edits: Edit[] = appended ? [{ start: tailEnd, end: tailEnd, text: appended }] : [];
  const headings = new Set<string>();
  for (const fence of plan.fences.slice(1)) {
    let [start] = lineBounds(text, fence.begin.start);
    for (const line of linesBefore(text, start)) {
      if (BLANK.test(line.text)) continue;
      if (HEADING.test(line.text) && earlierHeading(text, line.start, line.text.trim(), headings)) start = line.start;
      break;
    }
    let end = lineAfter(text, fence.end!.start);
    let blankBefore = false;
    for (const line of linesBefore(text, start)) {
      if (!BLANK.test(line.text)) break;
      start = line.start;
      blankBefore = true;
    }
    let blankAfter = false;
    while (end < text.length) {
      const [lineStart, lineEnd] = lineBounds(text, end);
      if (!BLANK.test(text.slice(lineStart, lineEnd))) break;
      end = lineAfter(text, end);
      blankAfter = true;
    }
    edits.push({ start, end, text: (blankBefore || blankAfter) && start > 0 && end < text.length ? lineEnding(text, fence.begin.start) : '' });
  }
  return edits;
}

/** The lines before offset `at` (which starts a line), nearest first, without line endings. */
function* linesBefore(text: string, at: number): Generator<{ start: number; text: string }> {
  while (at > 0) {
    const [start, end] = lineBounds(text, at - 1);
    yield { start, text: text.slice(start, end) };
    at = start;
  }
}

/** A line with the same trimmed heading text appears before `before` in the section. */
function earlierHeading(text: string, before: number, heading: string, cache: Set<string>): boolean {
  if (cache.has(heading)) return true;
  let at = 0;
  while (at < before) {
    const nl = text.indexOf('\n', at);
    const end = nl === -1 || nl > before ? before : nl;
    if (text.slice(at, end).trim() === heading) {
      cache.add(heading);
      return true;
    }
    if (nl === -1 || nl >= before) break;
    at = nl + 1;
  }
  return false;
}

/** The merged fence's row origins in `merged`, the section text after `mergeEdits`. */
export function mergeOrigins(plan: MergePlan, merged: string): MergeOrigins {
  const fence = extractRawRows(merged, plan.section).fences.find(f => f.kind === plan.kind && f.primary);
  const kept = plan.rows.filter(r => r.keptAs !== null);
  if (!fence || fence.rows.length !== kept.length) throw new Error('merged fence rows do not match the merge plan');
  return {
    section: plan.section, kind: plan.kind,
    origins: kept.map(r => r.fence),
    mergedLines: fence.rows.map(r => r.line),
    beforeLines: kept.map(r => r.row.line),
    dropped: plan.rows.filter(r => r.keptAs === null).map(r => ({ fence: r.fence, num: rowNumOf(plan.fences[r.fence]!, r.row), keptOccurrence: plan.rows[r.duplicateOf!]!.keptAs! })),
  };
}

/** Lines of fixes and issues reported on the merged text, mapped back to the before section's lines. */
export function beforeLine(merges: readonly MergeOrigins[], item: { fence: FenceKind; section: FenceSection; line: number | null }): number | null {
  if (item.line === null) return null;
  const origin = merges.find(m => m.section === item.section && m.kind === item.fence);
  if (!origin) return item.line;
  const at = origin.mergedLines.indexOf(item.line);
  return at === -1 ? item.line : origin.beforeLines[at]!;
}

/** The merge plans the fixes of a repair name, re-derived from the before page (null when a named merge does not apply to it). */
export function mergePlans(before: FencePage, fixes: ReadonlyArray<{ class: string; fence: FenceKind; section: FenceSection }>): Map<string, MergePlan> | null {
  const plans = new Map<string, MergePlan>();
  const sections = new Map(sectionsOf(before));
  for (const fix of fixes) {
    if (fix.class !== 'merge_fences' || plans.has(`${fix.section}:${fix.fence}`)) continue;
    const plan = mergePlan(extractRawRows(sections.get(fix.section) ?? '', fix.section), fix.fence);
    if (!plan) return null;
    plans.set(`${fix.section}:${fix.fence}`, plan);
  }
  return plans;
}

/** The receipt's `merged` entries for a repair whose fixes include `merge_fences`; undefined when none does. Location only. */
export function mergedReceipt(before: FencePage, fixes: readonly FenceFix[]): MergedFenceReceipt[] | undefined {
  const plans = mergePlans(before, fixes);
  if (!plans?.size) return undefined;
  return [...plans.values()].map(plan => ({
    fence: plan.kind, section: plan.section, fences: plan.fences.length,
    rows: plan.rows.map(r => ({
      occurrence: r.occurrence, from_fence: r.fence,
      ...(r.keptAs !== null ? { kept_as: r.keptAs } : { duplicate_of: plan.rows[r.duplicateOf!]!.keptAs! }),
    })),
  }));
}
