/**
 * Offset-preserving text masking for link extraction (src/core/link-extraction.ts).
 * Kept in its own module so the published `gbrain/link-extraction` export
 * surface does not grow; the parity test imports it from here.
 */

/**
 * Replace the UTF-16 code-unit ranges (integer offsets, clipped, may overlap)
 * with spaces, preserving offsets, by copying slices. Used by extractEntityRefs
 * so the unqualified wikilink regex cannot match inside a qualified span.
 */
export function maskRanges(content: string, ranges: Array<[number, number]>): string {
  if (ranges.length === 0) return content;
  const spans = ranges.map(([s, e]) => [Math.max(0, s), Math.min(e, content.length)]).filter(([s, e]) => s < e).sort((a, b) => a[0]! - b[0]!);
  let out = '';
  let at = 0;
  for (const [s, e] of spans) if (e! > at) { out += content.slice(at, Math.max(at, s!)) + ' '.repeat(e! - Math.max(at, s!)); at = e!; }
  return out + content.slice(at);
}
