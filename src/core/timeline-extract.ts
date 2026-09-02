/**
 * Timeline extraction from rendered markdown — CORE module.
 *
 * Lives in core (not commands/extract.ts, its historical home) because core
 * consumers (timeline-write-through.ts re-derives the canonical DB tuple from
 * the spliced bullet; the cycle synthesize path) must not import the command
 * module: commands/extract.ts transitively loads the write-through/ops layer,
 * and a core->commands import closes a module cycle that leaves the command
 * module partially evaluated under dynamic import ("Export named ... not
 * found" at runtime, invisible to tsc). commands/extract.ts re-exports these
 * names, so its existing importers are unaffected.
 */

import { parseInlineCitationTimelineEntries, findTimelineSourceDelimiter } from './link-extraction.ts';

export interface ExtractedTimelineEntry {
  slug: string;
  date: string;
  source: string;
  summary: string;
  detail?: string;
}

// #3957: the link-aware `Source — Summary` delimiter finder moved to
// link-extraction.ts (findTimelineSourceDelimiter) so the DB-side parser
// (parseTimelineEntries) applies the IDENTICAL split — FS- and DB-extracted
// rows must share one (source, summary) shape or the timeline dedup index
// duplicates every bullet extracted through both paths.
const findDelimiterOutsideLinks = findTimelineSourceDelimiter;

/** Extract timeline entries from markdown content */
export function extractTimelineFromContent(content: string, slug: string): ExtractedTimelineEntry[] {
  const entries: ExtractedTimelineEntry[] = [];

  // Format 1: Bullet — - **YYYY-MM-DD** | Source — Summary
  // The delimiter search is link-aware (see findDelimiterOutsideLinks): a
  // no-delimiter bullet is kept whole as the summary rather than fragmented.
  const bulletPattern = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|\s*(.+)$/gm;
  let match;
  while ((match = bulletPattern.exec(content)) !== null) {
    const rest = match[2].trim();
    // #4277: dated auto-generated backlink receipts
    // (`- **date** | Referenced in [X](y.md)`) are graph-maintenance noise —
    // the date is the backlink write's, not an entity event's. Skip them.
    // Pre-split guard (rest must START with the marker) mirrors
    // parseTimelineEntries in link-extraction.ts so FS- and DB-side
    // extraction stay in lockstep, and leaves write-through rendered
    // `source — summary` bullets that merely mention the phrase intact.
    if (/^Referenced in\s+\[/i.test(rest)) continue;
    const at = findDelimiterOutsideLinks(rest);
    if (at >= 0) {
      entries.push({ slug, date: match[1], source: rest.slice(0, at).trim(), summary: rest.slice(at + 1).trim() });
    } else {
      entries.push({ slug, date: match[1], source: 'markdown', summary: rest });
    }
  }

  // Format 2: Header — ### YYYY-MM-DD — Title
  const headerPattern = /^###\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)$/gm;
  while ((match = headerPattern.exec(content)) !== null) {
    const afterIdx = match.index + match[0].length;
    const nextHeader = content.indexOf('\n### ', afterIdx);
    const nextSection = content.indexOf('\n## ', afterIdx);
    const endIdx = Math.min(
      nextHeader >= 0 ? nextHeader : content.length,
      nextSection >= 0 ? nextSection : content.length,
    );
    const detail = content.slice(afterIdx, endIdx).trim();
    entries.push({ slug, date: match[1], source: 'markdown', summary: match[2].trim(), detail: detail || undefined });
  }

  // Format 3: Inline citation — [Source: <source>, YYYY-MM-DD]
  //
  // This is the citation convention gbrain's own quality rules require on
  // every brain write (skills/conventions/quality.md), so dated evidence is
  // pervasive in curated pages — but until now the extractor could not see
  // it, and a page whose dates all live in citations scored zero timeline
  // coverage. The entry's summary is the sentence the citation annotates
  // (the surrounding line with citation markers stripped).
  //
  // Lines already captured by Format 1 are skipped: a timeline bullet often
  // carries its own [Source: ...] citation, and re-extracting it would file
  // a duplicate entry under a different (source, summary) shape that the
  // DB-level uniqueness cannot collapse.
  const bulletLinePattern = /^-\s+\*\*\d{4}-\d{2}-\d{2}\*\*\s*\|/;
  for (const entry of parseInlineCitationTimelineEntries(content, {
    skipLine: (line) => bulletLinePattern.test(line),
  })) {
    entries.push({ slug, date: entry.date, source: entry.source, summary: entry.summary });
  }

  return entries;
}
