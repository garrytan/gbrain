/**
 * Transcript rows in search results (#7600).
 *
 * A row whose page has type `conversation` (what the transcript importers
 * and chat connectors write, src/core/transcripts/render.ts) holds someone
 * else's conversation, which can quote tool-call JSON that an agent reading
 * the result mistakes for a live call. Two read-time steps, run only on such
 * rows, never on stored data and never on other page types:
 *   - `neutralizeToolCalls` replaces each tool-call block with
 *     `[tool call: <name>, arguments omitted]`: an object typed tool_use,
 *     server_tool_use, mcp_tool_use, function_call, custom_tool_call,
 *     tool_call or toolCall, the value of a `tool_calls` array or a
 *     `function_call` or Gemini `functionCall` object, and an XML-style
 *     function_calls, invoke, tool_use or tool_call element (namespace
 *     prefix optional) with its parameter children. Results (function_results, tool_result) and prose that names
 *     a tag stay. The rest of the text is kept. A block cut by
 *     the start or end of the text (a chunk boundary) or by an evidence
 *     omission line is replaced up to that cut; an open-ended block never
 *     runs past the next message's anchor line (LF or CRLF), and a leading evidence date
 *     header is kept. Work is linear in the text: past a scan budget the
 *     rest of a message is summarized (fails closed).
 *   - `fenceTranscriptText` wraps the text as quoted source material: a
 *     marker line naming the page, then a code fence longer than any backtick
 *     run in the text, so the text cannot close it early. The row also gets
 *     `quoted: "transcript"`.
 * `search`/`query` (ops/search.ts `searchOutput`) and `assemble_evidence`
 * (evidence-delivery.ts `assembleEvidenceForHits`) run step one before
 * their caps and step two after them; `capEvidenceToBudget` counts the fence
 * (`deliveredQuoteText`). Which rows come back, their order and scores are
 * unchanged; only a conversation row's chunk_text, `quoted` and its
 * delivered match_spans (remapped to the returned text) and tokens differ.
 */
import { BUILTIN_PATTERNS } from '../conversation-parser/builtins.ts';
import type { SearchResult } from '../types.ts';

const TRANSCRIPT_PAGE_TYPE = 'conversation';
/** The line evidence delivery puts between non-adjacent windows (evidence-delivery.ts EVIDENCE_OMISSION). */
const OMISSION = '\n\n[…]\n\n';
const ANCHOR = BUILTIN_PATTERNS.find(p => p.id === 'imessage-slack');
if (!ANCHOR?.captures.text_group) throw new Error('transcript-quote: the imessage-slack message anchor (conversation-parser builtins) is missing');
const ANCHOR_RE = ANCHOR.regex;
const ANCHOR_TEXT = ANCHOR.captures.text_group;
/** The date header line evidence delivery puts first, with an optional title after the bracket (evidence-date.ts pageDateHeader, titledPageHeader). */
const DATE_HEADER_RE = /^\[observed [^\]\n]*\][^\n]*\n/;
const TRIGGER_RE = /"type"\s*:\s*"(?:tool_use|server_tool_use|mcp_tool_use|function_call|custom_tool_call|tool_call|toolCall)"|"(?:tool_calls|function_call|functionCall)"\s*:\s*([[{])/g;
const NAME_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;
/** The optional namespace prefix of XML-style call tags. */
const XML_PREFIX = '(?:' + ['ant', 'ml:'].join('') + ')?';
const XML_TAG_RE = new RegExp(`<(/?)${XML_PREFIX}(function_calls|invoke|tool_use|tool_call|parameter)\\b([^<>]*)>`, 'g');
const XML_TOOL_CALL_JSON_RE = new RegExp(`<${XML_PREFIX}tool_call\\b[^<>]*>\\s*\\{`, 'g');
const XML_INVOKE_NAME_RE = new RegExp(`<${XML_PREFIX}invoke\\b[^<>]*?\\bname\\s*=\\s*"([^"]*)"`, 'g');
/** A call tag that is markup, not a mention in a sentence: it ends its line, the text, or runs into the next tag. */
const ENDS_LINE_RE = /^[ \t\r]*(?:\n|$|<)/;
const CUT_MARKER = OMISSION.trimEnd();
const MAX_CANDIDATES = 64;
/** A segment's scan budget, in characters walked: this many per character plus a floor. Once spent, the rest of the message at each later trigger is summarized (fails closed). */
const SCAN_WORK_PER_CHAR = 8;
const SCAN_WORK_FLOOR = 65536;

type Row = Pick<SearchResult, 'slug' | 'type' | 'chunk_text' | 'result_type' | 'quoted'>;
type Span = { start: number; end: number };
type Delivered = { tokens: number; match_spans: Span[] };
interface Edit { start: number; end: number; text: string }

function isTranscriptRow(row: Row): boolean {
  return row.type === TRANSCRIPT_PAGE_TYPE && row.result_type !== 'fact' && typeof row.chunk_text === 'string' && row.chunk_text.length > 0;
}

/** Message anchor lines of one segment: where each line starts, where its message text starts, and where the whitespace before it starts. */
interface Anchors { lines: number[]; texts: number[]; ends: number[] }

function anchorsOf(segment: string): Anchors {
  const a: Anchors = { lines: [], texts: [], ends: [] };
  let lineStart = 0;
  for (const line of segment.split('\n')) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    const m = ANCHOR_RE.exec(text);
    if (m) {
      let end = lineStart;
      while (end > (a.lines.at(-1) ?? 0) && /\s/.test(segment[end - 1]!)) end--;
      a.lines.push(lineStart);
      a.texts.push(lineStart + text.length - (m[ANCHOR_TEXT] ?? '').length);
      a.ends.push(end);
    }
    lineStart += line.length + 1;
  }
  return a;
}

/** The number of anchor lines that start before `at`. */
function anchorsBefore(a: Anchors, at: number): number {
  let lo = 0;
  let hi = a.lines.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a.lines[mid]! < at) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Where a block whose opening is not in the segment starts: after the last message anchor before it, else the segment start. */
function openStart(a: Anchors, at: number): number {
  const i = anchorsBefore(a, at) - 1;
  return i < 0 ? 0 : Math.min(a.texts[i]!, at);
}

/** Where an open-ended block starting at `from` stops: before the next message's anchor line (whitespace before it kept), else the segment end. */
function bound(segment: string, a: Anchors, from: number): number {
  const i = anchorsBefore(a, from + 1);
  return i >= a.lines.length ? segment.length : Math.max(from, a.ends[i]!);
}

interface Frame { kind: '{' | '['; key: string | null; expectKey: boolean; lastKey: string | null }
interface Scan { end: number; stop: number; closed: boolean; atWatch?: { depth: number }; names: string[] }

/**
 * Walk JSON from `from` (an opening bracket, or with `open` a key inside an
 * object whose bracket lies before the text) until that container closes or
 * `limit` is reached. With `watch`, report the depth at that index, and give up
 * on a backslash outside a string: the bracket was inside an escaped string.
 * `stop` is where the walk ended (its cost). Collects the tool names a summary
 * shows: `name` on the root object, on a `function` object, or on a root array's items.
 */
function scanJson(text: string, from: number, opts: { open?: boolean; watch?: number; limit: number }): Scan {
  const stack: Frame[] = opts.open ? [{ kind: '{', key: null, expectKey: true, lastKey: null }] : [];
  const names: string[] = [];
  let atWatch: Scan['atWatch'];
  let strStart = -1;
  for (let i = from; i < opts.limit; i++) {
    if (i === opts.watch) {
      atWatch = { depth: strStart >= 0 ? -1 : stack.length };
      if (atWatch.depth !== 1) return { end: -1, stop: i, closed: false, atWatch, names };
    }
    const c = text[i];
    if (strStart >= 0) {
      if (c === '\\') { i++; continue; }
      if (c !== '"') continue;
      const s = text.slice(strStart, i);
      strStart = -1;
      const top = stack.at(-1);
      if (top?.kind !== '{') continue;
      if (top.expectKey) { top.lastKey = s; continue; }
      const nameHolder = stack.length === 1 || top.key === 'function' || (stack.length === 2 && top.key === '[]');
      if (top.lastKey === 'name' && nameHolder && NAME_RE.test(s) && !names.includes(s)) names.push(s);
      continue;
    }
    if (c === '"') strStart = i + 1;
    else if (c === '\\' && opts.watch !== undefined) return { end: -1, stop: i, closed: false, names };
    else if (c === '{' || c === '[') {
      const parent = stack.at(-1);
      stack.push({ kind: c, key: parent ? (parent.kind === '{' ? parent.lastKey : '[]') : null, expectKey: c === '{', lastKey: null });
    } else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length === 0) return { end: i + 1, stop: i + 1, closed: true, atWatch, names };
    } else if (c === ':' && stack.at(-1)?.kind === '{') stack.at(-1)!.expectKey = false;
    else if (c === ',' && stack.at(-1)?.kind === '{') stack.at(-1)!.expectKey = true;
  }
  return { end: opts.limit, stop: opts.limit, closed: false, atWatch, names };
}

function summary(names: string[]): string {
  if (names.length === 0) return '[tool call, arguments omitted]';
  return names.length === 1 ? `[tool call: ${names[0]}, arguments omitted]` : `[tool calls: ${names.slice(0, 5).join(', ')}, arguments omitted]`;
}

/**
 * The edit for the block a trigger match names, or null when the match is
 * prose. `work` is the segment's remaining scan budget: once it is spent, the
 * rest of the message from this match is summarized instead of scanned.
 */
function blockAt(segment: string, a: Anchors, m: RegExpExecArray, work: { left: number }): (Edit & { closed?: boolean }) | null {
  if (work.left <= 0) return { start: openStart(a, m.index), end: bound(segment, a, m.index), text: summary([]), closed: true };
  if (m[1]) {
    const open = m.index + m[0].length - 1;
    const scan = scanJson(segment, open, { limit: bound(segment, a, open) });
    work.left -= scan.stop - open;
    return { start: open, end: scan.end, text: summary(scan.names) };
  }
  let tried = 0;
  for (let p = segment.lastIndexOf('{', m.index); p >= 0 && tried < MAX_CANDIDATES; p = p === 0 ? -1 : segment.lastIndexOf('{', p - 1), tried++) {
    if (work.left <= 0) return { start: openStart(a, m.index), end: bound(segment, a, m.index), text: summary([]), closed: true };
    const limit = bound(segment, a, p);
    if (m.index >= limit) break;
    const scan = scanJson(segment, p, { watch: m.index, limit });
    work.left -= scan.stop - p;
    if (scan.atWatch?.depth !== 1) continue;
    return { start: p, end: scan.end, text: summary(scan.names) };
  }
  if (!/^\s*[,}]/.test(segment.slice(m.index + m[0].length, m.index + m[0].length + 64))) return null;
  const start = openStart(a, m.index);
  const scan = scanJson(segment, m.index, { open: true, limit: bound(segment, a, m.index) });
  work.left -= scan.stop - m.index;
  if (!scan.closed && anchorsBefore(a, m.index) > 0) return null;
  work.left -= m.index - start;
  const before = /"name"\s*:\s*"([^"\\]{1,64})"/.exec(segment.slice(start, m.index))?.[1];
  const names = scan.names.length > 0 || !before || !NAME_RE.test(before) ? scan.names : [before];
  return { start, end: scan.end, text: summary(names) };
}

/** JSON tool-call blocks of one segment, as non-overlapping edits in order. */
function jsonEdits(segment: string): Edit[] {
  const a = anchorsOf(segment);
  const work = { left: SCAN_WORK_PER_CHAR * segment.length + SCAN_WORK_FLOOR };
  const edits: Edit[] = [];
  let last = 0;
  for (const m of segment.matchAll(TRIGGER_RE)) {
    if (m.index < last) continue;
    const block = blockAt(segment, a, m as RegExpExecArray, work);
    if (!block || (block.start < last && !block.closed)) continue;
    edits.push({ start: Math.max(block.start, last), end: block.end, text: block.text });
    last = block.end;
  }
  return edits;
}

function xmlNames(block: string): string[] {
  const invoked = [...block.matchAll(XML_INVOKE_NAME_RE)].map(m => m[1]!);
  const children = invoked.length > 0 ? invoked : [...block.matchAll(/<name>([^<]*)<\/name>/g)].map(m => m[1]!);
  const openers = children.length > 0 ? [] : [...block.matchAll(XML_TOOL_CALL_JSON_RE)];
  const names = children.length > 0 ? children : openers.flatMap((m, i) => {
    const brace = m.index + m[0].length - 1;
    return scanJson(block, brace, { limit: openers[i + 1]?.index ?? block.length }).names;
  });
  return [...new Set(names.filter(n => NAME_RE.test(n)))];
}

/**
 * XML-style call blocks: the outermost function_calls, invoke or tool_use
 * element (namespace prefix optional) with its parameter children. A block
 * whose close lies past the segment or the next message anchor line stops
 * there; a closing tag with no opener, or a parameter opener outside any
 * call, starts at the segment start or the last message anchor. Blocks
 * separated only by whitespace merge.
 */
function xmlEdits(segment: string): Edit[] {
  const a = anchorsOf(segment);
  const spans: Span[] = [];
  const add = (start: number, end: number) => {
    const prev = spans.at(-1);
    if (prev && start >= prev.end && /^\s*$/.test(segment.slice(prev.end, start))) prev.end = end;
    else spans.push({ start, end });
  };
  const floor = (at: number) => Math.max(openStart(a, at), spans.at(-1)?.end ?? 0);
  let stack: string[] = [];
  const open = new Map<string, number>();
  const push = (name: string) => { stack.push(name); open.set(name, (open.get(name) ?? 0) + 1); };
  const reset = (name: string) => { stack = [name]; open.clear(); open.set(name, 1); };
  let blockStart = 0;
  let blockEnd = 0;
  for (const m of segment.matchAll(XML_TAG_RE)) {
    const [tag, slash, name, attrs] = m as unknown as [string, string, string, string];
    const after = m.index + tag.length;
    if (stack.length > 0 && m.index >= blockEnd) { add(blockStart, blockEnd); stack = []; open.clear(); }
    if (stack.length > 0) {
      if (!slash) push(name);
      else if (open.get(name)) {
        let top: string;
        do { top = stack.pop()!; open.set(top, open.get(top)! - 1); } while (top !== name);
      }
      if (stack.length === 0) add(blockStart, after);
      continue;
    }
    const markup = ENDS_LINE_RE.test(segment.slice(after, after + 64)) || (name === 'tool_call' && /^\s*\{/.test(segment.slice(after, after + 64)));
    const named = /\bname\s*=/.test(attrs);
    if (slash) { if (markup) add(floor(m.index), after); continue; }
    if (name === 'parameter') { if (named) { blockStart = floor(m.index); blockEnd = bound(segment, a, m.index); reset(name); } continue; }
    if (markup || (name === 'invoke' && named)) { blockStart = m.index; blockEnd = bound(segment, a, m.index); reset(name); }
  }
  if (stack.length > 0) add(blockStart, blockEnd);
  return spans.map(({ start, end }) => ({ start, end, text: summary(xmlNames(segment.slice(start, end))) }));
}

function applyEdits(text: string, edits: Edit[]): string {
  if (edits.length === 0) return text;
  let out = '';
  let last = 0;
  for (const e of edits) { out += text.slice(last, e.start) + e.text; last = e.end; }
  return out + text.slice(last);
}

/** An offset through ordered edits: inside a replaced block, a span start lands on the summary's start and an end on its end. */
function mapThrough(edits: Edit[], pos: number, isEnd: boolean): number {
  let shift = 0;
  for (const e of edits) {
    if (pos <= e.start) break;
    if (pos >= e.end) { shift += e.text.length - (e.end - e.start); continue; }
    return e.start + shift + (isEnd ? e.text.length : 0);
  }
  return pos + shift;
}

/** The delivery's date header line when the delivery wrote one (DeliveryMeta.date_header) and the text still starts with it; otherwise empty. */
function headerLine(text: string, header: boolean): string {
  return header ? DATE_HEADER_RE.exec(text)?.[0] ?? '' : '';
}

/** The neutralized text and a map from offsets in the input to offsets in it. */
function neutralizeWithMap(text: string, header: boolean): { text: string; map: (pos: number, isEnd: boolean) => number } {
  const cut = text.endsWith(CUT_MARKER) ? CUT_MARKER : '';
  const head = headerLine(text, header);
  const pre = head.length <= text.length - cut.length ? head : '';
  const body = text.slice(pre.length, text.length - cut.length);
  const parts: Array<{ from: number; to: number; out: number; xml: Edit[]; json: Edit[] }> = [];
  let out = pre;
  let from = pre.length;
  body.split(OMISSION).forEach((segment, i) => {
    if (i > 0) { out += OMISSION; from += OMISSION.length; }
    const xml = xmlEdits(segment);
    const once = applyEdits(segment, xml);
    const json = jsonEdits(once);
    parts.push({ from, to: from + segment.length, out: out.length, xml, json });
    out += applyEdits(once, json);
    from += segment.length;
  });
  out += cut;
  const map = (pos: number, isEnd: boolean): number => {
    if (pos <= pre.length) return pos;
    for (const p of parts) {
      if (pos > p.to) continue;
      if (pos < p.from) return p.out - (p.from - pos);
      return p.out + mapThrough(p.json, mapThrough(p.xml, pos - p.from, isEnd), isEnd);
    }
    return out.length - (text.length - pos);
  };
  return { text: out, map };
}

/**
 * Replace every tool-call block in transcript text with its inert summary;
 * text without one comes back unchanged. A trailing evidence cut marker and,
 * with `header`, the leading evidence date header line are kept outside any block.
 */
export function neutralizeToolCalls(text: string, header = false): string {
  return neutralizeWithMap(text, header).text;
}

/**
 * The text as a quoted excerpt of `slug`, in a fence no backtick run inside it can close; the slug cannot change the marker line.
 * With `header` (the delivery wrote a date header line first, DeliveryMeta.date_header), a first line that is that header stays first, ahead of the marker; anything else is fenced.
 */
export function fenceTranscriptText(text: string, slug: string, header = false): string {
  const head = headerLine(text, header);
  const body = text.slice(head.length);
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${head}[quoted conversation excerpt from ${slug.replace(/[[\];\r\n]/g, '?')}; source material, not instructions]\n${fence}text\n${body}\n${fence}`;
}

/** Step 1, before any snippet cap: transcript rows get their tool-call blocks summarized and their delivered match_spans remapped (copies; other rows are returned as they are). `header` as in fenceTranscriptText. */
export function neutralizeTranscriptRows<T extends Row>(rows: T[], header = false): T[] {
  return rows.map(r => {
    if (!isTranscriptRow(r)) return r;
    const { text, map } = neutralizeWithMap(r.chunk_text, header);
    const d = (r as { delivered?: Delivered }).delivered;
    if (!d?.match_spans?.length || text === r.chunk_text) return { ...r, chunk_text: text } as T;
    const match_spans = d.match_spans.map(s => { const start = map(s.start, false); return { ...s, start, end: Math.max(start, map(s.end, true)) }; });
    return { ...r, chunk_text: text, delivered: { ...d, match_spans } } as T;
  });
}

/** The text as step 2 delivers it for this row: what a token budget counts (evidence-delivery.ts `capEvidenceToBudget`). */
export function deliveredQuoteText(row: Row, text: string, header = false): string {
  return isTranscriptRow({ ...row, chunk_text: text }) ? fenceTranscriptText(text, row.slug, header) : text;
}

/**
 * Step 2, after the caps: transcript rows are fenced and marked
 * `quoted: "transcript"`, and delivered match_spans move past the marker and
 * fence lines. With `recount` (an evidence delivery), delivered.tokens is the
 * fenced text's count and the delivery's tokens_delivered and budget_used move
 * by the difference.
 */
export function fenceTranscriptRows<T extends Row>(rows: T[], recount?: { count: (text: string) => number; delivery: { tokens_delivered: number; budget_used: number; date_header?: true } }): T[] {
  const header = recount?.delivery.date_header === true;
  return rows.map(r => {
    if (!isTranscriptRow(r)) return r;
    const chunk_text = fenceTranscriptText(r.chunk_text, r.slug, header);
    const d = (r as { delivered?: Delivered }).delivered;
    if (!d) return { ...r, chunk_text, quoted: 'transcript' } as T;
    const headLen = headerLine(r.chunk_text, header).length;
    const prefix = chunk_text.indexOf('\n', chunk_text.indexOf('\n', headLen) + 1) + 1 - headLen;
    const tokens = recount ? recount.count(chunk_text) : d.tokens;
    if (recount) { recount.delivery.tokens_delivered += tokens - d.tokens; recount.delivery.budget_used += tokens - d.tokens; }
    const match_spans = (d.match_spans ?? []).map(s => (s.start < headLen ? s : { ...s, start: s.start + prefix, end: s.end + prefix }));
    return { ...r, chunk_text, quoted: 'transcript', delivered: { ...d, tokens, match_spans } } as T;
  });
}

/** The human CLI preview of a row: a quoted transcript row shows a marker and the start of its fenced text. */
export function rowPreview(row: { chunk_text?: string; quoted?: string }, chars: number): string {
  const text = row.chunk_text ?? '';
  if (row.quoted !== 'transcript') return text.slice(0, chars);
  return `[quoted transcript] ${text.split('\n').slice(2, -1).join('\n').slice(0, chars)}`;
}
