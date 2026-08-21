import { stripCodeBlocks } from './markdown-code.ts';

const CITATION_TIMELINE_RE = /\[Source:\s*([^\]]+?),\s*(\d{4}-\d{2}-\d{2})\s*\]/g;

export interface InlineCitationTimelineCandidate {
  date: string;
  source: string;
  summary: string;
}

interface CitationParagraph {
  text: string;
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

  const flush = () => {
    if (lines.length === 0) return;
    paragraphs.push({ text: lines.map((line) => line.trim()).join(' ') });
    lines = [];
  };

  for (const line of stripCodeBlocks(content).split(/\r?\n/)) {
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    if (opts.skipLine?.(line)) {
      flush();
      continue;
    }
    if (lines.length > 0 && startsMarkdownBlock(line)) flush();
    lines.push(line);
  }
  flush();

  return paragraphs;
}

export function parseInlineCitationTimelineEntries(
  content: string,
  opts: { skipLine?: (line: string) => boolean } = {},
): InlineCitationTimelineCandidate[] {
  const result: InlineCitationTimelineCandidate[] = [];
  for (const paragraph of citationParagraphs(content, opts)) {
    const matches = [...paragraph.text.matchAll(CITATION_TIMELINE_RE)];
    if (matches.length === 0) continue;
    const summary = paragraph.text
      .replace(/\[Source:[^\]]*\]/g, '')
      .replace(/^[-*>#\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    if (!summary) continue;
    for (const m of matches) {
      if (!isValidDate(m[2])) continue;
      result.push({
        date: m[2],
        source: m[1].trim().slice(0, 200),
        summary,
      });
    }
  }
  return result;
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, mo, d] = s.split('-').map(Number);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
