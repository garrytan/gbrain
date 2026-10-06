/**
 * Machine-written list sections of a page body (Timeline, See also, Related,
 * Facts, Sources, Links, Email mention links, Backlinks, Significant moments).
 * Link-type inference skips the page-role prior inside them, and the line
 * grammar (src/core/line-grammar.ts) never reads a typed relation or a fact
 * line inside them: writers fill these sections with per-event references.
 */

/**
 * Content index ranges where the page-role prior must NOT apply: the
 * machine-written list sections — Timeline, See also, Related, Facts,
 * Sources, Links, Email mention links, Backlinks, Significant moments
 * (headingRe below is the one source of truth). Links there are list-shaped, per-event references
 * ("2026-05-12 — met with [[companies/x]]", Iron-Law back-links) — the
 * role prior is a statement about the AUTHOR's standing relationships, not
 * about every entity that passes through their timeline, so applying it
 * there mints unevidenced works_at/advises edges on every re-import (on
 * one 12k-page brain: ~7.4k such edges re-minted in a month, right after
 * a ~19.5k cleanup; same class as #3466). Per-edge verbs inside these
 * sections still type normally — only the globalContext fallback is
 * suppressed, so absent explicit evidence the edge stays 'mentions'.
 *
 * A range runs from its heading to the next heading of the same or higher
 * level (or EOF). Case-insensitive; matches "See also" / "See-also". Both
 * grammars require the ATX space after the `#`s, so a column-0 tag line
 * (`#links`) is neither an opener nor a closer.
 */
export function rolePriorSuppressedRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const headingRe = /^(#{1,6})[ \t]+(?:timeline|see[ -]also|related|facts|sources|links|email mention links|backlinks|significant moments)\b[^\n]*$/gim;
  const anyHeadingRe = /^(#{1,6})[ \t]/gm;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(content)) !== null) {
    const level = m[1].length;
    anyHeadingRe.lastIndex = m.index + m[0].length;
    // Deeper headings (`###` under `## Timeline`) stay inside the range; the
    // first same-or-higher one closes it.
    let next: RegExpExecArray | null;
    while ((next = anyHeadingRe.exec(content)) !== null && next[1].length > level) { /* nested subsection */ }
    ranges.push([m.index, next ? next.index : content.length]);
  }
  return ranges;
}

export function inSuppressedRange(ranges: Array<[number, number]>, idx: number): boolean {
  for (const [start, end] of ranges) {
    if (idx >= start && idx < end) return true;
  }
  return false;
}
