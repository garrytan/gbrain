/**
 * #7180: get_page `section` and `grep`, one part of a page instead of the whole.
 *
 *   section: "<heading>"   the section under the first ATX heading whose text
 *                          equals it (case-insensitive, whitespace folded): the
 *                          heading line down to the next heading of the same or
 *                          a higher level (or the timeline separator), with the
 *                          ancestor headings in heading_path. A miss is
 *                          invalid_params naming up to SECTION_HEADINGS_LISTED
 *                          of the page's headings.
 *   grep: "<term>"         the paragraphs (blank-line-separated blocks) holding
 *   context: N             a line that contains the term (plain substring,
 *                          case-insensitive, never a regex), each with N
 *                          paragraphs either side (default 1, at most 5);
 *                          windows that overlap or touch merge into one block.
 *                          Capped at GREP_MAX_MATCHES matching paragraphs and
 *                          the character budget; total_matches counts them all.
 *
 * Both read the read projection (page-window/document.ts), the text every
 * window and outline is cut from, after get_page authorized and loaded the
 * page: a slice shows nothing a window could not, and its line numbers are
 * the ones body: 'window' lines takes. The document arrives as a stream of
 * buffers (one for an inline page, one per segment for a segmented page) and
 * is scanned line by line, so a segmented page is never held whole: memory is
 * the returned text plus one segment and at most context paragraphs.
 */
import type { OperationContext, ParamDef } from './contract.ts';
import { opError } from './contract.ts';
import { invalidParam, readFix } from './op-fix.ts';
import { resultByteCap } from '../egress-budget.ts';
import { FENCE, HEADING, HEADING_MAX_CHARS, clip } from '../page-window/window.ts';

export const GET_PAGE_SLICE_PARAMS: Record<string, ParamDef> = {
  section: { type: 'string', description: 'Only the section under this heading (case-insensitive, first match), with its heading_path.', fullSurfaceOnly: true },
  grep: { type: 'string', description: 'Only the paragraphs containing this text (case-insensitive substring, not a regex), with line numbers and total_matches.', fullSurfaceOnly: true },
  context: { type: 'number', appliesWith: 'grep', description: 'Applies only with grep (ignored without it): paragraphs of context either side (default 1, max 5).', fullSurfaceOnly: true },
};

export const DEFAULT_GREP_CONTEXT = 1;
export const MAX_GREP_CONTEXT = 5;
/** Matching paragraphs one grep returns; the rest are counted in total_matches. */
export const GREP_MAX_MATCHES = 50;
/** Characters of page text one section or grep returns (fewer when the connection's egress cap is smaller). */
export const SLICE_MAX_CHARS = 100_000;
/** Headings a section miss lists. */
export const SECTION_HEADINGS_LISTED = 20;
const MAX_QUERY_CHARS = 500;
/** A line longer than this is scanned in pieces that share its line number. */
const LINE_PIECE_BYTES = 1024 * 1024;
/** Room a sliced response keeps for its metadata inside the egress cap. */
const RESERVE_BYTES = 64 * 1024;
const TIMELINE_LINE = '<!-- timeline -->';
const NL = 0x0a;

export type SliceRequest = { kind: 'section'; heading: string } | { kind: 'grep'; term: string; context: number };

const SECTION_EXAMPLE = { slug: 'notes/acme-example-log', section: 'Next steps' };
const GREP_EXAMPLE = { slug: 'notes/acme-example-log', grep: 'widget', context: 2 };

/** The slice a get_page call asks for, or undefined; throws invalid_params on a malformed value or a conflicting param. */
export function parseSliceRequest(ctx: Pick<OperationContext, 'remote' | 'transport'>, p: Record<string, unknown>): SliceRequest | undefined {
  const bad = (param: string, message: string, example: unknown) => invalidParam(ctx, 'get_page', param, message, { example });
  if (p.section === undefined && p.grep === undefined) {
    if (p.context !== undefined) throw bad('context', 'get_page: context applies to grep; pass grep with it.', GREP_EXAMPLE);
    return undefined;
  }
  if (p.section !== undefined && p.grep !== undefined) throw bad('grep', 'get_page: pass section or grep, not both.', GREP_EXAMPLE);
  const param = p.section !== undefined ? 'section' : 'grep';
  const example = param === 'section' ? SECTION_EXAMPLE : GREP_EXAMPLE;
  const value = p[param];
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_QUERY_CHARS) {
    throw bad(param, `get_page: ${param} must be a non-empty string of at most ${MAX_QUERY_CHARS} characters.`, example);
  }
  for (const other of ['lines', 'bytes', 'around_chunk_id', 'cursor', 'include_content', 'content_only']) {
    if (p[other] !== undefined && p[other] !== false) throw bad(param, `get_page: ${param} returns part of the read view; it does not combine with ${other}.`, example);
  }
  if (p.body !== undefined && p.body !== 'auto' && p.body !== 'window') throw bad('body', `get_page: ${param} does not combine with body: '${String(p.body)}'.`, example);
  if (p.view !== undefined && p.view !== 'read') throw bad('view', `get_page: ${param} reads view 'read' only.`, example);
  if (param === 'section') {
    if (p.context !== undefined) throw bad('context', 'get_page: context applies to grep, not section.', GREP_EXAMPLE);
    return { kind: 'section', heading: value };
  }
  let context = DEFAULT_GREP_CONTEXT;
  if (p.context !== undefined) {
    if (typeof p.context !== 'number' || !Number.isSafeInteger(p.context) || p.context < 0) {
      throw bad('context', 'get_page: context must be a non-negative integer (paragraphs either side of a match).', GREP_EXAMPLE);
    }
    context = Math.min(MAX_GREP_CONTEXT, p.context);
  }
  return { kind: 'grep', term: value, context };
}

/** The first n UTF-16 units of text, never splitting a surrogate pair. */
function head(text: string, n: number): string {
  if (text.length <= n) return text;
  const c = text.charCodeAt(n - 1);
  return text.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

interface Line { text: string; line: number; continued: boolean }

/** The document's lines (1-based) across buffer boundaries; a line over LINE_PIECE_BYTES arrives in pieces (continued). */
async function* documentLines(stream: AsyncIterable<Buffer>): AsyncGenerator<Line> {
  let carry: Buffer[] = [];
  let carryBytes = 0;
  let line = 1;
  let continued = false;
  const take = (tail: Buffer): string => {
    const text = (carry.length ? Buffer.concat([...carry, tail]) : tail).toString('utf8');
    carry = [];
    carryBytes = 0;
    return text;
  };
  for await (const buf of stream) {
    let at = 0;
    for (let nl = buf.indexOf(NL); nl !== -1; nl = buf.indexOf(NL, at)) {
      yield { text: take(buf.subarray(at, nl)), line, continued };
      line++;
      continued = false;
      at = nl + 1;
    }
    if (at < buf.length) {
      carry.push(buf.subarray(at));
      carryBytes += buf.length - at;
    }
    if (carryBytes <= LINE_PIECE_BYTES) continue;
    const joined = Buffer.concat(carry);
    let cut = joined.length;
    while (cut > 0 && (joined[cut - 1]! & 0xc0) === 0x80) cut--;
    if (cut > 0 && joined[cut - 1]! >= 0xc0) cut--;
    if (cut === 0) cut = joined.length;
    carry = cut < joined.length ? [joined.subarray(cut)] : [];
    carryBytes = joined.length - cut;
    yield { text: joined.subarray(0, cut).toString('utf8'), line, continued };
    continued = true;
  }
  if (carryBytes > 0) yield { text: take(Buffer.alloc(0)), line, continued };
}

const fold = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Characters this caller may receive in one slice. */
export async function sliceCharBudget(ctx: OperationContext): Promise<number> {
  const cap = await resultByteCap({ remote: ctx.remote, transport: ctx.transport, engine: ctx.engine, config: ctx.config });
  // A character is at most 3 UTF-8 bytes, and escaping through the frame's two JSON levels can double it.
  return Number.isFinite(cap) ? Math.max(4096, Math.min(SLICE_MAX_CHARS, Math.floor((cap - RESERVE_BYTES) / 6))) : SLICE_MAX_CHARS;
}

interface SliceTarget { slug: string; source_id: string }

/** The response fields of a section read, or the invalid_params miss naming the page's headings. */
export async function readSection(page: SliceTarget, stream: AsyncIterable<Buffer>, heading: string, budget: number,
  wrap: (text: string) => string): Promise<Record<string, unknown>> {
  const want = fold(heading.replace(/^\s*#{1,6}(?=\s)/, ''));
  const stack: Array<{ level: number; text: string }> = [];
  const listed: string[] = [];
  let headings = 0;
  let fence = false;
  let hit: { level: number; text: string; path: string[]; line_start: number } | null = null;
  const kept: string[] = [];
  let chars = 0, lastKept = 0, lastText = 0, omitted = 0, firstOmitted = 0;
  for await (const l of documentLines(stream)) {
    let h: RegExpExecArray | null = null;
    if (!l.continued) {
      if (FENCE.test(l.text)) fence = !fence;
      else if (!fence) h = HEADING.exec(l.text);
      if (!fence && l.text.trim() === TIMELINE_LINE) {
        if (hit) break;
        stack.length = 0;
        continue;
      }
    }
    if (h) {
      const level = h[1]!.length;
      const text = h[2]!;
      if (hit && level <= hit.level) break;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      if (!hit) {
        headings++;
        if (listed.length < SECTION_HEADINGS_LISTED) listed.push(clip(text, HEADING_MAX_CHARS));
        if (fold(text) === want) hit = { level, text, path: [...stack.map(s => s.text), text], line_start: l.line };
      }
      stack.push({ level, text });
    }
    if (!hit || !l.text.trim()) continue;
    lastText = l.line;
    const piece = (l.continued || !kept.length ? '' : '\n'.repeat(l.line - lastKept)) + l.text;
    if (omitted || chars + piece.length > budget) {
      if (!omitted) firstOmitted = l.line;
      omitted += piece.length;
      continue;
    }
    kept.push(piece);
    chars += piece.length;
    lastKept = l.line;
  }
  if (!hit) {
    const more = headings > listed.length ? ` (first ${listed.length} of ${headings})` : '';
    throw opError('invalid_params',
      `get_page: page ${page.slug} has no heading ${JSON.stringify(clip(heading, HEADING_MAX_CHARS))}. ${headings ? `Headings${more}: ${listed.map(t => JSON.stringify(t)).join(', ')}.` : 'It has no headings.'}`,
      headings ? 'Pass section as one of the listed headings (case-insensitive), or read the outline for every heading and its lines.' : 'Search it with grep, or read it in windows from its outline.',
      { detail: JSON.stringify({ headings: listed, total_headings: headings }),
        fix: readFix("Returns the page's outline: every heading with its line range.",
          { argv: ['gbrain', 'get', '--source', page.source_id, '--body', 'outline', '--', page.slug], mcp: { tool: 'get_page', arguments: { slug: page.slug, source_id: page.source_id, body: 'outline' } } }) });
  }
  const text = wrap(kept.join(''));
  const lineEnd = Math.max(lastText, hit.line_start);
  return {
    body: 'section',
    section: { heading: hit.text, level: hit.level, heading_path: hit.path, line_start: hit.line_start, line_end: lineEnd, text },
    chars: text.length,
    truncated: omitted > 0,
    ...(omitted ? { omitted_chars: omitted, next: { tool: 'get_page', arguments: { slug: page.slug, source_id: page.source_id, body: 'window', lines: { from: firstOmitted, count: lineEnd - firstOmitted + 1 } } } } : {}),
  };
}

interface Paragraph { line_start: number; line_end: number; text: string; match: boolean }
interface Block { line_start: number; line_end: number; match_starts: number[]; parts: string[] }

/** The response fields of a grep read: merged blocks of matching paragraphs and their context, capped, with total_matches. */
export async function readGrep(stream: AsyncIterable<Buffer>, term: string, context: number, budget: number,
  wrap: (text: string) => string): Promise<Record<string, unknown>> {
  const needle = term.toLowerCase();
  const blocks: Block[] = [];
  let current: Block | null = null;
  let afterLeft = 0;
  let pending: Paragraph[] = [];
  let gap = 0;
  let total = 0, returned = 0, chars = 0;
  let full = false, clipped = false;
  /** Append p to b within the character budget (cut at the budget once); false when nothing of it fit. */
  const add = (b: Block, p: Paragraph): boolean => {
    if (full) return false;
    const sep = b.parts.length ? '\n'.repeat(p.line_start - b.line_end) : '';
    let piece = sep + p.text;
    if (chars + piece.length > budget) {
      full = clipped = true;
      const room = budget - chars - sep.length;
      if (room <= 0) return false;
      piece = sep + head(p.text, room);
    }
    b.parts.push(piece);
    chars += piece.length;
    b.line_end = p.line_end;
    return true;
  };
  const close = (p: Paragraph) => {
    if (!p.match) {
      if (current && afterLeft > 0) {
        add(current, p);
        afterLeft--;
        return;
      }
      gap++;
      pending.push(p);
      if (pending.length > context) pending.shift();
      return;
    }
    total++;
    if (full || returned >= GREP_MAX_MATCHES) {
      full = true;
      current = null;
      return;
    }
    if (!current || (afterLeft === 0 && gap > context)) {
      const first = pending[0] ?? p;
      current = { line_start: first.line_start, line_end: first.line_start, match_starts: [], parts: [] };
      blocks.push(current);
    }
    for (const q of pending) add(current, q);
    pending = [];
    gap = 0;
    afterLeft = context;
    if (add(current, p)) {
      current.match_starts.push(p.line_start);
      returned++;
    }
  };
  let para: Paragraph | null = null;
  for await (const l of documentLines(stream)) {
    if (!l.continued && !l.text.trim()) {
      if (para) close(para);
      para = null;
      continue;
    }
    if (!para) para = { line_start: l.line, line_end: l.line, text: '', match: false };
    const sep = para.text && !l.continued ? '\n' : '';
    if (para.text.length <= budget) para.text += sep + head(l.text, budget + 1 - para.text.length);
    para.line_end = l.line;
    if (!para.match && l.text.toLowerCase().includes(needle)) para.match = true;
  }
  if (para) close(para);
  const out = blocks.filter(b => b.match_starts.length)
    .map(b => ({ line_start: b.line_start, line_end: b.line_end, match_starts: b.match_starts, text: wrap(b.parts.join('')) }));
  return {
    body: 'grep',
    grep: { term, context, total_matches: total, returned_matches: returned, omitted_matches: total - returned, blocks: out },
    chars: out.reduce((n, b) => n + b.text.length, 0),
    truncated: total > returned || clipped,
  };
}
