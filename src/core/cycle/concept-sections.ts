/**
 * #6161: body sections a human curates on a concept page that synthesis must
 * carry through republication verbatim, like the facts and takes fences. The
 * concept-synthesis skill records a merge as a `## Facets` section on the
 * canonical page (`## Merged` is accepted for the same purpose). A section
 * runs from its heading to the next `#`/`##` heading or fence marker; headings
 * inside code are ignored.
 */
import { stripCodeBlocks } from '../markdown-code.ts';

const SECTION_HEADING_RE = /^##[ \t]+(?:Facets|Merged)[ \t]*$/i;
const SECTION_END_RE = /^(?:#{1,2}[ \t]|<!---? gbrain:)/;

function sectionRanges(body: string): Array<[number, number]> {
  const masked = stripCodeBlocks(body);
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let open = -1;
  for (const line of masked.split('\n')) {
    const text = line.replace(/\r$/, '');
    if (open !== -1 && SECTION_END_RE.test(text)) { ranges.push([open, offset]); open = -1; }
    if (open === -1 && SECTION_HEADING_RE.test(text)) open = offset;
    offset += line.length + 1;
  }
  if (open !== -1) ranges.push([open, body.length]);
  return ranges;
}

/** The preserved sections of a body, each trimmed, in order. */
export function preservedConceptSections(body: string): string[] {
  return sectionRanges(body).map(([start, end]) => body.slice(start, end).trim());
}

/** The body without its preserved sections. */
export function stripPreservedConceptSections(body: string): string {
  let out = '';
  let at = 0;
  for (const [start, end] of sectionRanges(body)) { out += body.slice(at, start); at = end; }
  return (out + body.slice(at)).replace(/\n{3,}/g, '\n\n');
}
