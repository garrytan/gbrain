import { inlineCodeSpans } from './fence-scan.ts';
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
  /** Code masked: where citations are found. */
  text: string;
  /** The same lines with each inline code span as a placeholder for its text in `codes` (#8893). */
  withCode: string;
  codes: string[];
}

const CODE_PLACEHOLDER_RE = /\uE000(\d+)\uE001/g;

/**
 * #8893: `masked` (stripCodeBlocks of `raw`, same length) with each same-line
 * inline span it blanked replaced by a placeholder for the span's text, so
 * summary rewriting never touches code and fenced text never comes back. A
 * span holding citation or comment markup stays blank: that is markup quoted
 * as an example, never summary text. Placeholder characters already in the
 * text become spaces, so only ours are restored. Linear in the line.
 */
function placeInlineCode(raw: string, masked: string, codes: string[]): string {
  const plain = (text: string) => text.replace(/[\uE000\uE001]/g, ' ');
  let out = '';
  let at = 0;
  for (const [start, end] of inlineCodeSpans(raw)) {
    if (masked.slice(start, end).trim()) continue;
    const run = /^`+/.exec(raw.slice(start, end))![0].length;
    const inner = raw.slice(start + run, end - run);
    if (/\[Source:|<!--|-->/.test(inner)) continue;
    const padded = inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '';
    out += `${plain(masked.slice(at, start))}\uE000${codes.push(plain(padded ? inner.slice(1, -1) : inner)) - 1}\uE001`;
    at = end;
  }
  return out + plain(masked.slice(at));
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
  keepCode = false,
): CitationParagraph[] {
  const paragraphs: CitationParagraph[] = [];
  let lines: string[] = [];
  let codeLines: string[] = [];
  let codes: string[] = [];
  let skippedBlock = false;

  const flush = () => {
    if (lines.length === 0) return;
    paragraphs.push({ text: lines.map((line) => line.trim()).join(' '), withCode: codeLines.map((line) => line.trim()).join(' '), codes });
    lines = [];
    codeLines = [];
    codes = [];
  };

  const rawLines = keepCode ? content.split(/\r?\n/) : [];
  for (const [index, line] of stripCodeBlocks(content).split(/\r?\n/).entries()) {
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
    if (keepCode) codeLines.push(placeInlineCode(rawLines[index] ?? line, line, codes));
  }
  flush();

  return paragraphs;
}

type CitationOpts = { skipLine?: (line: string) => boolean };

/**
 * `current` keeps inline code text (#8893); `code_masked` is the reading before
 * it (inline code blanked); `legacy` the one before #6226 (code blanked, the
 * whole citation body one source, emphasis kept).
 */
type CitationReading = 'current' | 'code_masked' | 'legacy';

function readCitations(content: string, opts: CitationOpts, reading: CitationReading): InlineCitationTimelineCandidate[] {
  const legacy = reading === 'legacy';
  const result: InlineCitationTimelineCandidate[] = [];
  if (!content.includes('[Source:')) return result;
  const summaryOf = (text: string, codes?: string[]) => {
    const stripped = stripHtmlComments(text).replace(/\[Source:[^\]]*\](?:\((?:[^()]|\([^()]*\))*\))?/g, '');
    const lead = (legacy ? stripped : unwrapEmphasis(stripped)).replace(/^[-*>#\s]+/, '');
    return (codes ? lead.replace(CODE_PLACEHOLDER_RE, (_, i: string) => codes[Number(i)]!) : lead).replace(/\s+/g, ' ').trim().slice(0, 300);
  };
  for (const paragraph of citationParagraphs(content, opts, reading === 'current')) {
    const matches = [...paragraph.text.matchAll(CITATION_TIMELINE_RE)];
    if (matches.length === 0) continue;
    const withCode = reading === 'current' ? summaryOf(paragraph.withCode, paragraph.codes) : '';
    // Restored code that completes citation or comment markup running outside its span reads as the masked text did.
    const summary = withCode && !/\[Source:|<!--|-->/.test(withCode) ? withCode : summaryOf(paragraph.text);
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
 * HTML comments (#6184), paired emphasis and inline-code backticks removed.
 */
export function parseInlineCitationTimelineEntries(content: string, opts: CitationOpts = {}): InlineCitationTimelineCandidate[] {
  return readCitations(content, opts, 'current');
}

/**
 * The entries the older readings filed for `content` (before #8893 inline
 * code blanked; before #6226 also a multi-source citation as one source with
 * its final date, emphasis kept) that the current reading no longer produces. Stored rows equal to one of them are
 * that older reading's output, so projection and retraction can retire them
 * instead of writing them back into the page.
 */
export function supersededInlineCitationEntries(content: string, opts: CitationOpts = {}): InlineCitationTimelineCandidate[] {
  const seen = new Set(readCitations(content, opts, 'current').map(e => JSON.stringify([e.date, e.source, e.summary])));
  return [...readCitations(content, opts, 'code_masked'), ...readCitations(content, opts, 'legacy')].filter((e) => {
    const key = JSON.stringify([e.date, e.source, e.summary]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, mo, d] = s.split('-').map(Number);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(new Date(0).setUTCFullYear(y, mo - 1, d)); // not Date.UTC: it maps years 0-99 to 1900-1999
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
