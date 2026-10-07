/**
 * Page-level checks shared by the normalizer and the validator (#6188).
 *
 * `strictFailures` is gate (a): the same three checks
 * `compileCanonicalProjections` refuses on (a repeated marker outside code,
 * any strict-parser warning, a row number used twice across the page), so a
 * page with none of them compiles. `exposedLines` is gate (g): text that the
 * privacy boundary (`protectedRegions`, which `sanitizeRemoteBody`, the
 * chunker and the strip functions share) hid before a repair and shows after
 * it.
 */
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence } from '../takes-fence.ts';
import { indexOfOutsideCode, protectedRegions, scanMarkdownCode } from '../fence-scan.ts';
import type { FenceKind, FencePage, FenceSection } from './types.ts';

export interface StrictFailure {
  section: FenceSection | null;
  fence: FenceKind;
  check: 'repeated_marker' | 'warnings' | 'row_collision';
  /** Row numbers involved (collisions only). */
  rows: number[];
}

const MARKER_KIND: ReadonlyArray<[string, FenceKind]> = [
  [FACTS_FENCE_BEGIN, 'facts'], [FACTS_FENCE_END, 'facts'], [TAKES_FENCE_BEGIN, 'takes'], [TAKES_FENCE_END, 'takes'],
];
const PROTECTED_PAIRS = [
  { begin: FACTS_FENCE_BEGIN, end: FACTS_FENCE_END },
  { begin: TAKES_FENCE_BEGIN, end: TAKES_FENCE_END },
];

/** The page's two sections, labelled. */
export function sectionsOf(page: FencePage): Array<[FenceSection, string]> {
  return [['body', page.compiled_truth ?? ''], ['timeline', page.timeline ?? '']];
}

/** Why `compileCanonicalProjections` would refuse this page's fences; empty when it compiles. */
export function strictFailures(page: FencePage): StrictFailure[] {
  const failures: StrictFailure[] = [];
  const numbers: Record<FenceKind, number[]> = { facts: [], takes: [] };
  for (const [section, text] of sectionsOf(page)) {
    for (const kind of repeatedMarkerKinds(text)) failures.push({ section, fence: kind, check: 'repeated_marker', rows: [] });
    const facts = parseFactsFence(text);
    const takes = parseTakesFence(text);
    if (facts.warnings.length) failures.push({ section, fence: 'facts', check: 'warnings', rows: [] });
    if (takes.warnings.length) failures.push({ section, fence: 'takes', check: 'warnings', rows: [] });
    numbers.facts.push(...facts.facts.map(f => f.rowNum));
    numbers.takes.push(...takes.takes.map(t => t.rowNum));
  }
  for (const kind of ['facts', 'takes'] as const) {
    const dup = numbers[kind].filter((n, i, all) => all.indexOf(n) !== i);
    if (dup.length) failures.push({ section: null, fence: kind, check: 'row_collision', rows: [...new Set(dup)] });
  }
  return failures;
}

export function strictPageClean(page: FencePage): boolean {
  return strictFailures(page).length === 0;
}

function repeatedMarkerKinds(text: string): Set<FenceKind> {
  const kinds = new Set<FenceKind>();
  if (!MARKER_KIND.some(([marker]) => text.includes(marker))) return kinds;
  const code = scanMarkdownCode(text);
  for (const [marker, kind] of MARKER_KIND) {
    const first = indexOfOutsideCode(text, marker, 0, code);
    if (first !== -1 && indexOfOutsideCode(text, marker, first + marker.length, code) !== -1) kinds.add(kind);
  }
  return kinds;
}

/** Lines the privacy boundary shows: text outside every protected region and before an ambiguous tail. */
export function visibleLines(text: string): string[] {
  const { regions, truncatedAt } = protectedRegions(text, PROTECTED_PAIRS);
  const segments: string[] = [];
  let cursor = 0;
  for (const region of regions) {
    segments.push(text.slice(cursor, region.start));
    cursor = region.end;
  }
  segments.push(truncatedAt === -1 ? text.slice(cursor) : text.slice(cursor, truncatedAt));
  return segments.flatMap(s => s.split(/\r\n|\r|\n/)).map(l => l.trim()).filter(Boolean);
}

/**
 * Lines visible in `after` that were not visible in `before` (as a multiset).
 * Rows that move into a fence are hidden, so they never count.
 */
export function exposedLines(before: string, after: string): string[] {
  const seen = new Map<string, number>();
  for (const line of visibleLines(before)) seen.set(line, (seen.get(line) ?? 0) + 1);
  const exposed: string[] = [];
  for (const line of visibleLines(after)) {
    const left = seen.get(line) ?? 0;
    if (left > 0) seen.set(line, left - 1);
    else exposed.push(line);
  }
  return exposed;
}
