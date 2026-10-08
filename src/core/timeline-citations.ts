import { stripCodeBlocks } from './markdown-code.ts';

const CITATION_TIMELINE_RE = /\[Source:\s*([^\]]+?,\s*\d{4}-\d{2}-\d{2})\s*\]/g;
/**
 * #6226: one `source, YYYY-MM-DD` of a citation body. A `;` separates two
 * sources only right after a date, so `[Source: call; follow-up email,
 * 2026-05-10]` keeps the one source `call; follow-up email`.
 */
const CITATION_SEGMENT_RE = /[\s;]*(.*?),\s*(\d{4}-\d{2}-\d{2})\s*(?:;|$)/gs;
/** The reading before #6226: the whole body is one source, dated by its final date. */
const LEGACY_CITATION_RE = /^(.+?),\s*(\d{4}-\d{2}-\d{2})$/s;

/**
 * Dated timeline bullets (`- **YYYY-MM-DD** | …`, and the `YYYY年M月D日` form)
 * the database-side bullet parser reads; its inline-citation pass skips them.
 */
export const TIMELINE_LINE_RE = /^\s*(?:-\s*)?\*\*(\d{4}-\d{2}-\d{2})\*\*\s*([|\-–—]+)\s*(.+?)\s*$/;
export const TIMELINE_LINE_RE_CN = /^\s*(?:-\s*)?(?:\*\*)?(\d{4})年(\d{1,2})月(\d{1,2})日?(?:\*\*)?\s*([|\-–—]+)\s*(.+?)\s*$/;
export const isDatedTimelineLine = (line: string): boolean => TIMELINE_LINE_RE.test(line) || TIMELINE_LINE_RE_CN.test(line);

/**
 * #6226: paired Markdown emphasis (`**x**`, `__x__`, `*x*`, `_x_`) unwraps to
 * its text. A marker needs a non-space next to it on the inside and no letter
 * or digit on the outside, so `snake_case`, `a*b*c` and `2 * 3` stay as they
 * are. A pair never spans a marker of its own kind, which keeps each pass
 * linear; nested emphasis unwraps over up to three passes.
 */
const EMPHASIS_RES = [
  /\*\*(?=\S)([^*]*?\S)\*\*/g,
  /(?<![\p{L}\p{N}_])__(?=\S)([^_]*?\S)__(?![\p{L}\p{N}_])/gu,
  /(?<![\p{L}\p{N}*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\p{L}\p{N}*])/gu,
  /(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/gu,
];

function unwrapEmphasis(text: string): string {
  for (let pass = 0; pass < 3; pass++) {
    const next = EMPHASIS_RES.reduce((acc, re) => acc.replace(re, '$1'), text);
    if (next === text) break;
    text = next;
  }
  return text;
}

export interface InlineCitationTimelineCandidate {
  date: string;
  source: string;
  summary: string;
}

interface CitationParagraph {
  text: string;
}

/** #6184: HTML comments (section markers, materialized-row markers) are markup, never summary text. */
/**
 * A line made only of comments: once trimmed it opens with `<!--` and closes
 * with a later `-->`. String checks, not a nested lazy regex, so a run of
 * empty comments ending in text cannot backtrack catastrophically.
 */
function isCommentOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 7 && trimmed.startsWith('<!--') && trimmed.endsWith('-->');
}

/**
 * Each `<!-- … -->` becomes a space (the first `-->` after the opener closes
 * it), then any stray `<!--` / `-->` does. One forward scan: an opener with no
 * later `-->` ends the scan, so unclosed openers cost linear time.
 */
export function stripHtmlComments(text: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = text.indexOf('<!--', at);
    const close = open < 0 ? -1 : text.indexOf('-->', open + 4);
    if (close < 0) break;
    out += `${text.slice(at, open)} `;
    at = close + 3;
  }
  return (out + text.slice(at)).replace(/<!--|-->/g, ' ');
}

function startsMarkdownBlock(line: string): boolean {
  return /^#{1,6}\s/.test(line) || /^\s*(?:[-*+]|\d+\.)\s+/.test(line);
}

function citationParagraphs(
  content: string,
  opts: { skipLine?: (line: string) => boolean } = {},
): CitationParagraph[] {
  const paragraphs: CitationParagraph[] = [];
  let lines: string[] = [];
  let skippedBlock = false;

  const flush = () => {
    if (lines.length === 0) return;
    paragraphs.push({ text: lines.map((line) => line.trim()).join(' ') });
    lines = [];
  };

  for (const line of stripCodeBlocks(content).split(/\r?\n/)) {
    if (line.trim().length === 0 || isCommentOnlyLine(line)) {
      flush();
      continue;
    }
    if (opts.skipLine?.(line)) {
      flush();
      skippedBlock = true;
      continue;
    }
    // Continuations belong to the already-indexed bullet, including citations.
    if (skippedBlock && /^\s/.test(line)) { flush(); continue; }
    skippedBlock = false;
    if (lines.length > 0 && startsMarkdownBlock(line)) flush();
    lines.push(line);
  }
  flush();

  return paragraphs;
}

type CitationOpts = { skipLine?: (line: string) => boolean };

function readCitations(content: string, opts: CitationOpts, legacy: boolean): InlineCitationTimelineCandidate[] {
  const result: InlineCitationTimelineCandidate[] = [];
  for (const paragraph of citationParagraphs(content, opts)) {
    const matches = [...paragraph.text.matchAll(CITATION_TIMELINE_RE)];
    if (matches.length === 0) continue;
    const text = stripHtmlComments(paragraph.text)
      .replace(/\[Source:[^\]]*\](?:\((?:[^()]|\([^()]*\))*\))?/g, '');
    const summary = (legacy ? text : unwrapEmphasis(text))
      .replace(/^[-*>#\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    if (!summary) continue;
    const seen = new Set<string>();
    for (const m of matches) {
      const segments = legacy ? [LEGACY_CITATION_RE.exec(m[1])].filter(x => x !== null) : [...m[1].matchAll(CITATION_SEGMENT_RE)];
      for (const segment of segments) {
        const source = segment[1].trim().slice(0, 200);
        const date = segment[2];
        if (!isValidDate(date) || (!legacy && !source) || seen.has(`${date}\0${source}`)) continue;
        seen.add(`${date}\0${source}`);
        result.push({ date, source, summary });
      }
    }
  }
  return result;
}

/**
 * One entry per dated source of each `[Source: …, YYYY-MM-DD]` citation
 * (#6226: `[Source: A, 2026-10-06; B, 2026-09-28]` files A on 2026-10-06 and
 * B on 2026-09-28), summarized by the paragraph it annotates with citations,
 * HTML comments (#6184) and paired emphasis removed.
 */
export function parseInlineCitationTimelineEntries(content: string, opts: CitationOpts = {}): InlineCitationTimelineCandidate[] {
  return readCitations(content, opts, false);
}

/**
 * The entries the reading before #6226 filed for `content` (a multi-source
 * citation as one source with its final date, emphasis kept) that the
 * current reading no longer produces. Stored rows equal to one of them are
 * that older reading's output, so projection and retraction can retire them
 * instead of writing them back into the page.
 */
export function supersededInlineCitationEntries(content: string, opts: CitationOpts = {}): InlineCitationTimelineCandidate[] {
  const current = new Set(readCitations(content, opts, false).map(e => JSON.stringify([e.date, e.source, e.summary])));
  return readCitations(content, opts, true).filter(e => !current.has(JSON.stringify([e.date, e.source, e.summary])));
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, mo, d] = s.split('-').map(Number);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(new Date(0).setUTCFullYear(y, mo - 1, d)); // not Date.UTC: it maps years 0-99 to 1900-1999
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
