/**
 * Outside-authored text, made inert before it lands in a page body (GBRA-221).
 *
 * gbrain reads machine structures out of page bodies: the `## Facts`, `## Takes` and `## Links` fences
 * (`<!--- gbrain:<kind>:begin -->` … `<!--- gbrain:<kind>:end -->`) and the other `gbrain:<name>` markers, the
 * timeline sentinel and bare `## Timeline` section that split compiled truth from the timeline, dated timeline rows
 * and `[Source: …, YYYY-MM-DD]` citations that become timeline entries, and the transcript anchor lines the
 * conversation parser reads as speaker turns. Text a third party wrote (an inbound email, a calendar description, a
 * chat message, an issue body, model output over an untrusted book) that reached a body verbatim could forge any of
 * them: a sender's facts table became the page's own world-visible facts, extract_facts promoted it, and because a
 * render that brings its own fence owns it, the planted fence replaced the facts gbrain had already written there.
 *
 * Every renderer that puts outside-controlled text into a body passes that text through `neutralizeOutsideText`.
 * Apply it to the outside text (each field, or a composed line that holds one), never to a whole page that may hold
 * gbrain's own fences or citations. Each rule adds one backslash where the parsers' exact matchers break, so the text
 * stays readable in raw markdown and renders unchanged, and each is idempotent:
 *
 * - `gbrain<ws>:<ws><name>` → `gbrain\:<name>`, case-insensitively. Every marker consumer, including the
 *   fence-repair near-miss recognizer and its `gbrain:facts:` pre-check, matches the exact token, so no marker of any
 *   kind survives and Tier 1 repair cannot upgrade a near miss into a live marker.
 * - `[Source:` → `[Source\:`, so no inline citation files a timeline entry.
 * - NUL is stripped first, as the connector render boundary (`connectorRender`) and page storage strip it, so a NUL
 *   inside a token cannot hide it from the rules below and rebuild it in the stored page.
 * - CR, CRLF, U+2028 and U+2029 become LF: the multiline (`/m`) timeline extractors treat each as a line start,
 *   so a line test on `\n` alone would let a separator-joined row through.
 * - A backslash before each line that is a timeline sentinel, a bare `## Timeline` / `## History` heading, a dated
 *   timeline row or heading, a transcript message anchor or a date heading, using the parsers' own predicates.
 */
import { isBareTimelineHeading, timelineSentinelKind } from './markdown.ts';
import { isDatedTimelineLine } from './timeline-citations.ts';
import { BUILTIN_PATTERNS } from './conversation-parser/builtins.ts';
import { sanitizeForJsonb } from './batch-rows.ts';

const IMESSAGE_SLACK = BUILTIN_PATTERNS.find((p) => p.id === 'imessage-slack');
if (!IMESSAGE_SLACK) {
  throw new Error('conversation-parser builtin imessage-slack is missing — render format broken');
}
/** The one transcript anchor regex — imported from the parser, never re-declared. */
export const MESSAGE_ANCHOR_RE: RegExp = IMESSAGE_SLACK.regex;

/** Date-heading shapes some builtins treat as day boundaries. */
const DATE_HEADING_RE = /^#{1,6}\s*\d{4}-\d{2}-\d{2}\b/;
/** The Format 1 bullet and Format 2 heading extractTimelineFromContent reads (timeline-extract.ts). */
const TIMELINE_BULLET_RE = /^-\s+\*\*\d{4}-\d{2}-\d{2}\*\*\s*\|/;
const TIMELINE_HEADING_RE = /^###\s+\d{4}-\d{2}-\d{2}\s*[—–-]/;
const MARKER_TOKEN_RE = /(gbrain)(\s*):(?=\s*[a-z])/gi;

/**
 * Escape any line that would parse as a transcript message anchor or a date heading: a leading backslash breaks
 * both `^\*\*` and `^#` while staying readable in raw markdown. Without this, a pasted anchor-shaped line forges
 * speakers and timestamps on round-trip (P0).
 */
export function escapeAnchorLines(text: string): string {
  return text
    .split('\n')
    .map((line) => (isAnchorLine(line) ? `\\${line}` : line))
    .join('\n');
}

function isAnchorLine(line: string): boolean {
  return MESSAGE_ANCHOR_RE.test(line) || DATE_HEADING_RE.test(line);
}

function isStructuralLine(line: string): boolean {
  const trimmed = line.trim();
  return timelineSentinelKind(trimmed) === 'marker' || isBareTimelineHeading(trimmed) || isDatedTimelineLine(line)
    || TIMELINE_BULLET_RE.test(line) || TIMELINE_HEADING_RE.test(line) || isAnchorLine(line);
}

/** Outside-authored text with no live gbrain marker, citation, timeline split or row, or transcript anchor. */
export function neutralizeOutsideText(text: string): string {
  return sanitizeForJsonb(text)
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(MARKER_TOKEN_RE, (_m, word: string, ws: string) => `${word}${ws}\\:`)
    .replace(/\[Source:/g, '[Source\\:')
    .split('\n')
    .map((line) => (isStructuralLine(line) ? `\\${line}` : line))
    .join('\n');
}
