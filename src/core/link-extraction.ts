import { dirname, join } from 'path';
import type { BrainEngine } from './engine.ts';
import type { PageType } from './types.ts';

export interface EntityRef {
  name: string;
  slug: string;
  dir: string;
}

export interface LinkCandidate {
  targetSlug: string;
  linkType: string;
  context: string;
}

export interface TimelineCandidate {
  date: string;
  summary: string;
  detail: string;
}

const ENTITY_REF_RE = /\[([^\]]+)\]\((?:\.\.\/)*((?:people|companies|meetings|concepts|deal|civic|project|source|media|yc)\/([^)\s]+?))(?:\.md)?\)/g;
const TIMELINE_LINE_RE = /^\s*-?\s*\*\*(\d{4}-\d{2}-\d{2})\*\*\s*[|\-–—]+\s*(.+?)\s*$/;
const WORKS_AT_RE = /\b(?:CEO of|CTO of|COO of|CFO of|CMO of|CRO of|VP at|VP of|VPs? Engineering|VPs? Product|works at|worked at|working at|employed by|employed at|joined as|joined the team|engineer at|engineer for|director at|director of|head of|leads engineering|leads product|currently at|previously at|previously worked at|spent .* (?:years|months) at|stint at|tenure at)\b/i;
const INVESTED_RE = /\b(?:invested in|invests in|investing in|invest in|investment in|investments in|backed by|funding from|funded by|raised from|led the (?:seed|Series|round|investment|round)|led .{0,30}(?:Series [A-Z]|seed|round|investment)|participated in (?:the )?(?:seed|Series|round)|wrote (?:a |the )?check|first check|early investor|portfolio (?:company|includes)|board seat (?:at|in|on)|term sheet for)\b/i;
const FOUNDED_RE = /\b(?:founded|co-?founded|started the company|incorporated|founder of|founders? (?:include|are)|the founder|is a co-?founder|is one of the founders)\b/i;
const ADVISES_RE = /\b(?:advises|advised|advisor (?:to|at|for|of)|advisory (?:board|role|position)|board advisor|on .{0,20} advisory board|joined .{0,20} advisory board)\b/i;
const PARTNER_ROLE_RE = /\b(?:partner at|partner of|venture partner|VC partner|invested early|investor at|investor in|portfolio|venture capital|early-stage investor|seed investor|fund [A-Z]|invests across|backs companies)\b/i;
const ADVISOR_ROLE_RE = /\b(?:full-time advisor|professional advisor|advises (?:multiple|several|various))\b/i;

function stripCodeBlocks(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    if (content.startsWith('```', i)) {
      const end = content.indexOf('```', i + 3);
      if (end === -1) {
        out += ' '.repeat(content.length - i);
        break;
      }
      out += ' '.repeat(end + 3 - i);
      i = end + 3;
      continue;
    }
    if (content[i] === '`') {
      const end = content.indexOf('`', i + 1);
      if (end === -1 || content.slice(i + 1, end).includes('\n')) {
        out += content[i];
        i++;
        continue;
      }
      out += ' '.repeat(end + 1 - i);
      i = end + 1;
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}

export function extractEntityRefs(content: string): EntityRef[] {
  const stripped = stripCodeBlocks(content);
  const refs: EntityRef[] = [];
  const re = new RegExp(ENTITY_REF_RE.source, ENTITY_REF_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const slug = match[2];
    refs.push({
      name: match[1],
      slug,
      dir: slug.split('/')[0],
    });
  }
  return refs;
}

function extractObsidianRefs(content: string, currentSlug?: string): EntityRef[] {
  const refs: EntityRef[] = [];
  const stripped = stripCodeBlocks(content);
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const raw = match[1].replace(/\\\|/g, '|').trim();
    const pipeIdx = raw.indexOf('|');
    const label = pipeIdx >= 0 ? raw.slice(pipeIdx + 1).trim() : raw;
    const targetRaw = (pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw)
      .split('#')[0]
      .split('^')[0]
      .trim()
      .replace(/\.md$/i, '');
    if (!targetRaw) continue;
    const resolved = targetRaw.includes('/')
      ? targetRaw
      : currentSlug
        ? join(dirname(currentSlug), targetRaw).replace(/\\/g, '/')
        : targetRaw;
    refs.push({
      name: label || resolved,
      slug: resolved,
      dir: resolved.split('/')[0],
    });
  }
  return refs;
}

function excerpt(content: string, idx: number, width: number): string {
  const half = Math.floor(width / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(content.length, idx + half);
  return content.slice(start, end).replace(/\s+/g, ' ').trim();
}

export function inferLinkType(pageType: PageType, context: string, globalContext?: string, targetSlug?: string): string {
  if (pageType === 'media') return 'mentions';
  if (pageType === 'meeting') return 'attended';
  if (FOUNDED_RE.test(context)) return 'founded';
  if (INVESTED_RE.test(context)) return 'invested_in';
  if (ADVISES_RE.test(context)) return 'advises';
  if (WORKS_AT_RE.test(context)) return 'works_at';
  if (pageType === 'person' && globalContext && targetSlug?.startsWith('companies/')) {
    if (PARTNER_ROLE_RE.test(globalContext)) return 'invested_in';
    if (ADVISOR_ROLE_RE.test(globalContext)) return 'advises';
  }
  return 'mentions';
}

export function extractPageLinks(
  content: string,
  frontmatter: Record<string, unknown>,
  pageType: PageType,
  currentSlug?: string,
): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];

  for (const ref of extractEntityRefs(content)) {
    const idx = content.indexOf(ref.name);
    const context = idx >= 0 ? excerpt(content, idx, 240) : ref.name;
    candidates.push({
      targetSlug: ref.slug,
      linkType: inferLinkType(pageType, context, content, ref.slug),
      context,
    });
  }

  for (const ref of extractObsidianRefs(content, currentSlug)) {
    const idx = content.indexOf(ref.name);
    const context = idx >= 0 ? excerpt(content, idx, 240) : ref.name;
    candidates.push({
      targetSlug: ref.slug,
      linkType: inferLinkType(pageType, context, content, ref.slug),
      context,
    });
  }

  const stripped = stripCodeBlocks(content);
  const bareRe = /\b((?:people|companies|meetings|concepts|deal|civic|project|source|media|yc)\/[a-z0-9][a-z0-9-]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = bareRe.exec(stripped)) !== null) {
    const charBefore = match.index > 0 ? stripped[match.index - 1] : '';
    if (charBefore === '/' || charBefore === '(') continue;
    const context = excerpt(stripped, match.index, 240);
    candidates.push({
      targetSlug: match[1],
      linkType: inferLinkType(pageType, context, content, match[1]),
      context,
    });
  }

  const source = frontmatter.source;
  if (typeof source === 'string' && source.length > 0 && /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(source)) {
    candidates.push({
      targetSlug: source,
      linkType: 'source',
      context: `frontmatter source: ${source}`,
    });
  }

  const seen = new Set<string>();
  const result: LinkCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.targetSlug}\u0000${candidate.linkType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export function parseTimelineEntries(content: string): TimelineCandidate[] {
  const result: TimelineCandidate[] = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    const match = TIMELINE_LINE_RE.exec(lines[i]);
    if (!match) {
      i++;
      continue;
    }

    const date = match[1];
    const summary = match[2].trim();
    if (!isValidDate(date) || summary.length === 0) {
      i++;
      continue;
    }

    const detailLines: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (TIMELINE_LINE_RE.test(next)) break;
      if (/^#{1,6}\s/.test(next)) break;
      if (next.trim().length === 0 && detailLines.length === 0) {
        j++;
        continue;
      }
      if (next.trim().length === 0 && detailLines.length > 0) break;
      if (/^\s+/.test(next) || (!next.startsWith('-') && !next.startsWith('*') && !next.startsWith('#'))) {
        detailLines.push(next.trim());
        j++;
        continue;
      }
      break;
    }

    result.push({ date, summary, detail: detailLines.join(' ').trim() });
    i = j;
  }

  return result;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export async function isAutoLinkEnabled(engine: BrainEngine): Promise<boolean> {
  const value = await engine.getConfig('auto_link');
  if (value == null) return true;
  return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
}
