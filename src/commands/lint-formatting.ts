import { stripCodeBlocks } from '../core/markdown-code.ts';
import { parseMarkdown } from '../core/markdown.ts';

/** A format example exempts one YYYY-MM-DD token, never the whole line. */
function isDateFormat(line: string, at: number): boolean {
  const before = line.slice(0, at);
  const after = line.slice(at + 'YYYY-MM-DD'.length);
  // Filename/path templates, including extensionless naming conventions.
  if (/^(?:\.[a-zA-Z][\w-]*\b|-[a-zA-Z][\w-]*\b|\/[\w.-]+)/.test(after)) return true;
  const prefix = before.slice(-100).replace(/(?:\*{1,2}|_{1,2})$/, '');
  if (/(?:\b(?:date format|timestamp format|format|pattern|template)\s*(?:is\s*)?[:=(]?\s*|\b(?:formatted as|plain|ISO(?:[- ]8601)?|use)\s*\(?\s*)$/i.test(prefix)) return true;
  if (/\bdates? in $/i.test(prefix) && /^ format\b/i.test(after)) return true;
  if (/\bdates?\s*\($/i.test(prefix) && /^ for (?:chronological sorting|sorting|filenames|naming)\)/i.test(after)) return true;
  // Quoted timeline syntax, e.g. the '**YYYY-MM-DD** |' prefix. An
  // unquoted timeline row with that date remains an unfilled date.
  if (/["']\*\*$/.test(before) && /^\*\*\s*\|["']/.test(after)) return true;
  // A citation explicitly introduced as a template/example, not an actual
  // citation. Stop at its closing bracket to keep later dates visible.
  return /\b(?:citation template|citation example)\s*:\s*\[Source:[^\]]*$/i.test(prefix)
    && /^\]/.test(after);
}

export function hasPlaceholderDate(line: string, frontmatter: boolean): boolean {
  for (const hit of line.matchAll(/\b(?:YYYY-MM-DD|\d{4}-XX-XX|XX-XX)\b/g)) {
    if (frontmatter || hit[0] !== 'YYYY-MM-DD' || !isDateFormat(line, hit.index)) return true;
  }
  return false;
}

export interface ChatSummaryHeading {
  start: number;
  end: number;
  roleStart: number;
  line: number;
  replacement: string;
}

/** Legacy summaries collapsed a role heading and excerpt onto one line.
 * Only repair that empty section directly after Summary, outside code.
 * Real role sections with a body and full transcripts are left alone. */
export function findChatSummaryHeadings(content: string): ChatSummaryHeading[] {
  const found: ChatSummaryHeading[] = [];
  const page = parseMarkdown(content, '', { validate: true });
  if (page.type !== 'source' || !page.typeExplicit || page.errors?.length) return found;
  const masked = stripCodeBlocks(content, { onHtmlComment: () => {} });
  const bodyStart = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content)?.[0].length ?? 0;
  // This repair belongs to the legacy export-summary shape. In an ordinary
  // note, "User permissions" could be a legitimate (empty) section title.
  const exportHeader = /^\*\*Source:\*\* (?:ChatGPT|Claude) Export[ \t]*\r?$/m.exec(masked.slice(bodyStart));
  if (!exportHeader) return found;
  const headerStart = bodyStart + exportHeader.index;
  const pattern = /^## Summary[ \t]*(\r?\n)(?:[ \t]*\r?\n)*## (Assistant|Human|User|Tool|Conversation Memory) ([^\r\n]+)$/gm;
  for (const hit of content.matchAll(pattern)) {
    const start = hit.index;
    if (start < headerStart + exportHeader[0].length) continue;
    const end = start + hit[0].length;
    const roleAt = hit[0].lastIndexOf('\n## ') + 1;
    const prefixEnd = start + roleAt + 3 + hit[2].length + 1;
    // Check structure against masked bytes, not the payload: a historical
    // excerpt may end mid-code-span without turning its real role into code.
    if (masked.slice(start, prefixEnd) !== content.slice(start, prefixEnd)) continue;
    const next = content.indexOf('\n## ', end);
    if (content.slice(end, next === -1 ? undefined : next).trim()) continue;
    // Read the excerpt from original bytes: code masking is detection only.
    const original = content.slice(start, end);
    const excerpt = original.slice(roleAt + 3 + hit[2].length + 1);
    const nl = hit[1];
    found.push({ start, end, roleStart: start + roleAt, line: content.slice(0, start + roleAt).split('\n').length,
      replacement: `## Summary${nl}${nl}### ${hit[2]}${nl}${nl}${excerpt}` });
  }
  return found;
}
