/**
 * #8059 prose-quoted fence markers: the repair-only `quote_marker` edit.
 *
 * A page that quotes a facts or takes marker in prose (a transcript about
 * gbrain, a note on the format) fails the strict fence gate. This module
 * finds such mentions and wraps each in backticks, which every reader already
 * treats as code. It changes no reader's fence rule (#8020): it only edits
 * the page, and only the fences repair kind applies the edit, after the
 * validator's gates read the result against the original bytes.
 *
 * A marker is prose-quoted when it is one of the four exact tokens, sits
 * outside markdown code (the readers' own code map), is not on a table line,
 * and either has text after it on its line or sits on a blockquote line. Text
 * only before a marker ("Facts: <marker>") is not a mention: readers accept
 * that line as a fence. A marker next to a backtick is left alone. On every
 * line it touches, the inline code spans after the edit are exactly the old
 * spans plus the new ones, so no existing span re-pairs; a line where that
 * fails keeps its markers. Two shapes are real markers, never mentions,
 * because readers pair a marker with trailing text exactly as one alone on its
 * line (#8020): an end that closes a fence holding rows (in the raw-row
 * extraction), and a begin whose next non-blank line is a table line.
 *
 * `quoteMarkerStep` keeps the edit only when it proves, against the bytes as
 * read: every data row of every fence (primary or repeat) sits in a fence
 * after, at the same line, of the same kind; and every byte the privacy
 * boundary (`protectedRegions`) hid before is still hidden after, mapped
 * through the inserted backticks. The validator's primary-fence pairing
 * cannot judge this edit (it changes which fence is primary), so the rest of
 * the analysis is validated against the quoted page.
 *
 * Pure: no I/O. Fixes are location-only (fence, section, line).
 */
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { codeEndAt, inlineCodeSpans, protectedRegions, scanMarkdownCode, type FencePair } from '../fence-scan.ts';
import { hasFenceText, withSections } from './normalize.ts';
import { sectionsOf } from './page-checks.ts';
import { extractRawRows } from './raw-rows.ts';
import type { FenceFix, FenceKind, FencePage, FenceSection } from './types.ts';

/** Bump when the mention rule changes: an `invalid_fence` hold screened under an older rule is screened once more (sync-holds.ts). */
export const QUOTE_SCREEN_VERSION = 1;

const PAIRS: readonly FencePair[] = [{ begin: FACTS_FENCE_BEGIN, end: FACTS_FENCE_END }, { begin: TAKES_FENCE_BEGIN, end: TAKES_FENCE_END }];

const MARKERS: ReadonlyArray<{ token: string; fence: FenceKind }> = [
  { token: FACTS_FENCE_BEGIN, fence: 'facts' }, { token: FACTS_FENCE_END, fence: 'facts' },
  { token: TAKES_FENCE_BEGIN, fence: 'takes' }, { token: TAKES_FENCE_END, fence: 'takes' },
];

interface Mention { fence: FenceKind; at: number; length: number; lineStart: number; lineEnd: number; line: number }

function lineBounds(text: string, at: number): [number, number] {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  let end = text.indexOf('\n', at);
  if (end === -1) end = text.length;
  if (text[end - 1] === '\r') end--;
  return [start, end];
}

/** The next non-blank line after the line ending at `lineEnd`, or ''. */
function nextLine(text: string, lineEnd: number): string {
  for (let at = text.indexOf('\n', lineEnd); at !== -1 && at < text.length;) {
    const [start, end] = lineBounds(text, at + 1);
    if (text.slice(start, end).trim()) return text.slice(start, end);
    at = text.indexOf('\n', end);
  }
  return '';
}

/** How many of the ascending `sorted` values are below `value`. */
function countBelow(sorted: ReadonlyArray<number>, value: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** The prose-quoted marker mentions of one section, in text order. Linear in the section: lines come from one newline index. */
function mentions(text: string, section: FenceSection): Mention[] {
  if (!hasFenceText(text)) return [];
  const code = scanMarkdownCode(text);
  const closesRows = new Set(extractRawRows(text, section).fences.filter(f => f.rows.length && f.end).map(f => f.end!.start));
  const newlines: number[] = [];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) newlines.push(at);
  const nextLines = new Map<number, string>();
  const found: Mention[] = [];
  for (const { token, fence } of MARKERS) {
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + token.length)) {
      if (closesRows.has(at) || codeEndAt(code, at) !== -1 || text[at - 1] === '`' || text[at + token.length] === '`') continue;
      const index = countBelow(newlines, at);
      const lineStart = index ? newlines[index - 1]! + 1 : 0;
      let lineEnd = index < newlines.length ? newlines[index]! : text.length;
      if (text[lineEnd - 1] === '\r') lineEnd--;
      if (token.endsWith('begin -->')) {
        if (!nextLines.has(lineEnd)) nextLines.set(lineEnd, nextLine(text, lineEnd));
        if (/^\s*\|/.test(nextLines.get(lineEnd)!)) continue;
      }
      const line = text.slice(lineStart, lineEnd);
      if (/^\s*\|/.test(line)) continue;
      const rest = /\S/g;
      rest.lastIndex = at + token.length;
      const after = rest.exec(text);
      if ((!after || after.index >= lineEnd) && !/^ {0,3}>/.test(line)) continue;
      found.push({ fence, at, length: token.length, lineStart, lineEnd, line: index + 1 });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** One line with its mentions wrapped, or null when the line's code spans would change beyond the new ones. */
function wrapLine(line: string, offsets: ReadonlyArray<{ at: number; length: number }>): string | null {
  let out = '';
  let from = 0;
  for (const { at, length } of offsets) {
    out += `${line.slice(from, at)}\`${line.slice(at, at + length)}\``;
    from = at + length;
  }
  out += line.slice(from);
  const starts = offsets.map(o => o.at);
  const shift = (pos: number) => pos + 2 * countBelow(starts, pos);
  const expected = [
    ...inlineCodeSpans(line).map(([s, e]) => [shift(s), shift(e)] as [number, number]),
    ...offsets.map(o => [shift(o.at), shift(o.at) + o.length + 2] as [number, number]),
  ].sort((a, b) => a[0] - b[0]);
  const actual = inlineCodeSpans(out);
  return actual.length === expected.length && actual.every(([s, e], i) => s === expected[i]![0] && e === expected[i]![1]) ? out : null;
}

/** Where the edit inserted a backtick, in before offsets (one before and one after each wrapped marker). */
type Inserts = number[];

function quoteSection(text: string, section: FenceSection): { text: string; fixes: FenceFix[]; inserts: Inserts } {
  const byLine = new Map<number, Mention[]>();
  for (const m of mentions(text, section)) {
    const group = byLine.get(m.lineStart);
    if (group) group.push(m); else byLine.set(m.lineStart, [m]);
  }
  const inserts: Inserts = [];
  if (!byLine.size) return { text, fixes: [], inserts };
  let out = '';
  let from = 0;
  const fixes: FenceFix[] = [];
  for (const [lineStart, group] of byLine) {
    const lineEnd = group[0]!.lineEnd;
    const wrapped = wrapLine(text.slice(lineStart, lineEnd), group.map(m => ({ at: m.at - lineStart, length: m.length })));
    if (wrapped === null) continue;
    out += text.slice(from, lineStart) + wrapped;
    from = lineEnd;
    for (const m of group) {
      inserts.push(m.at, m.at + m.length);
      fixes.push({ fence: m.fence, section, row: null, column: null, line: m.line, class: 'quote_marker' });
    }
  }
  return { text: out + text.slice(from), fixes, inserts };
}

/** Every data row of every fence, as `kind:line:text`. */
function rowKeys(text: string, section: FenceSection): string[] {
  return extractRawRows(text, section).fences.flatMap(f => f.rows.map(r => `${f.kind}:${r.line}:${text.slice(r.start, r.end)}`)).sort();
}

/** Bytes the privacy boundary hides: every protected region, and everything from an ambiguous tail on. */
function hiddenBytes(text: string): Uint8Array {
  const hidden = new Uint8Array(text.length);
  const { regions, truncatedAt } = protectedRegions(text, PAIRS);
  for (const r of regions) hidden.fill(1, r.start, r.end);
  if (truncatedAt !== -1) hidden.fill(1, truncatedAt);
  return hidden;
}

/** The edit drops, moves or re-kinds no row, and hides at least what the bytes as read hid. */
function quoteEditHolds(before: string, after: string, inserts: Inserts, section: FenceSection): boolean {
  const rowsBefore = rowKeys(before, section), rowsAfter = rowKeys(after, section);
  if (rowsBefore.length !== rowsAfter.length || rowsBefore.some((key, i) => key !== rowsAfter[i])) return false;
  const was = hiddenBytes(before), now = hiddenBytes(after);
  const sorted = [...inserts].sort((a, b) => a - b);
  for (let p = 0, k = 0; p < before.length; p++) {
    while (k < sorted.length && sorted[k]! <= p) k++;
    if (was[p] && !now[p + k]) return false;
  }
  return true;
}

/**
 * The page with every prose-quoted marker wrapped in backticks, and one `quote_marker` fix per wrapped marker; the page
 * unchanged with no fixes when there is no mention, or when the edit fails its row or privacy proof in either section.
 */
export function quoteMarkerStep<T extends FencePage>(page: T): { page: T; fixes: FenceFix[] } {
  const texts: Record<FenceSection, string> = { body: '', timeline: '' };
  const fixes: FenceFix[] = [];
  for (const [section, text] of sectionsOf(page)) {
    const quoted = quoteSection(text, section);
    if (quoted.fixes.length && !quoteEditHolds(text, quoted.text, quoted.inserts, section)) return { page, fixes: [] };
    texts[section] = quoted.text;
    fixes.push(...quoted.fixes);
  }
  return fixes.length ? { page: withSections(page, texts), fixes } : { page, fixes };
}
