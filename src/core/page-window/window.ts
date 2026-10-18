/**
 * Large pages (Wave A read contract): windows, outlines and cursors over one
 * PageDocument (document.ts). Every offset is a UTF-8 byte offset into the
 * document's bytes; every cut lands on a code point, and on a line start
 * whenever the selected range holds one ("forced" cuts are reported). A
 * window is bounded by bytes whatever the selector, so a page that is one
 * long line still pages.
 */
import { createHash } from 'node:crypto';

/**
 * Default window size: about 10k tokens of English (four bytes a token), which
 * leaves room under Claude Code's 25k-token tool-result cap for the metadata,
 * notices and JSON escaping around it.
 */
export const DEFAULT_WINDOW_BYTES = 40_000;
/** Largest window one call may ask for; the connection's egress cap may lower it. */
export const MAX_WINDOW_BYTES = 1024 * 1024;
export const DEFAULT_CONTEXT_LINES = 20;
export const MAX_CONTEXT_LINES = 2000;
export const DEFAULT_OUTLINE_LIMIT = 100;
export const MAX_OUTLINE_LIMIT = 500;
/** Outline block size for pages without headings (conversation logs). */
export const OUTLINE_BLOCK_BYTES = 64 * 1024;
export const HEADING_MAX_CHARS = 200;
const FIRST_LINE_MAX_CHARS = 120;

const NL = 0x0a;

export interface WindowSlice {
  text: string;
  byte_start: number;
  byte_end: number;
  /** 1-based line of byte_start, and of the window's last byte (equal to line_start for an empty window). */
  line_start: number;
  line_end: number;
  /** The window ends mid-line because the line alone is longer than the window. */
  forced_cut?: true;
}

function snapCodePoint(buf: Buffer, b: number): number {
  let i = Math.max(0, Math.min(b, buf.length));
  while (i > 0 && i < buf.length && (buf[i] & 0xc0) === 0x80) i--;
  return i;
}

function nextCodePoint(buf: Buffer, b: number): number {
  let i = Math.min(buf.length, b + 1);
  while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
  return i;
}

/** Start of the line holding byte `b` (0 for the first line). */
export function lineStartOf(buf: Buffer, b: number): number {
  if (b <= 0) return 0;
  const nl = buf.lastIndexOf(NL, Math.min(b, buf.length) - 1);
  return nl + 1;
}

/** 1-based line number of byte `b`. */
export function lineNumberAt(buf: Buffer, b: number): number {
  let n = 1;
  let i = buf.indexOf(NL, 0);
  while (i !== -1 && i < b) { n++; i = buf.indexOf(NL, i + 1); }
  return n;
}

export function totalLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  let i = buf.indexOf(NL, 0);
  while (i !== -1) { n++; i = buf.indexOf(NL, i + 1); }
  return buf[buf.length - 1] === NL ? n : n + 1;
}

/** Byte offset where 1-based line `line` starts; buf.length past the last line. */
export function lineOffset(buf: Buffer, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const nl = buf.indexOf(NL, at);
    if (nl === -1) return buf.length;
    at = nl + 1;
  }
  return at;
}

/**
 * Where a window starting at `start` ends when it may grow to `maxEnd`: the
 * last line start inside (start, maxEnd], else a code point boundary (a forced
 * cut), never before `minEnd`.
 */
function windowEnd(buf: Buffer, start: number, maxEnd: number, minEnd = start + 1): { end: number; forced: boolean } {
  if (maxEnd >= buf.length) return { end: buf.length, forced: false };
  const floor = Math.min(buf.length, Math.max(minEnd, start + 1));
  const atLine = lineStartOf(buf, maxEnd);
  if (atLine >= floor && atLine > start) return { end: atLine, forced: false };
  let end = snapCodePoint(buf, maxEnd);
  if (end < floor) end = snapCodePoint(buf, floor) < floor ? nextCodePoint(buf, snapCodePoint(buf, floor)) : floor;
  return { end: Math.min(end, buf.length), forced: true };
}

export function sliceWindow(buf: Buffer, start: number, end: number, forced = false): WindowSlice {
  const lineStart = lineNumberAt(buf, start);
  let lineEnd = lineStart;
  if (end > start) {
    let i = buf.indexOf(NL, start);
    while (i !== -1 && i < end - 1) { lineEnd++; i = buf.indexOf(NL, i + 1); }
  }
  return {
    text: buf.subarray(start, end).toString('utf8'),
    byte_start: start, byte_end: end, line_start: lineStart, line_end: lineEnd,
    ...(forced ? { forced_cut: true as const } : {}),
  };
}

/** A stretch of a document too large to hold (a segmented page): its bytes from document byte `start`, and the newlines before it. */
export interface DocumentSlab { bytes: Buffer; start: number; linesBefore: number }

/** A window `cut` from the slab's bytes, in document offsets and line numbers. */
export function slabWindow(slab: DocumentSlab, cut: (buf: Buffer) => WindowSlice): WindowSlice {
  const w = cut(slab.bytes);
  return { ...w, byte_start: w.byte_start + slab.start, byte_end: w.byte_end + slab.start, line_start: w.line_start + slab.linesBefore, line_end: w.line_end + slab.linesBefore };
}

/** A window from a clean boundary (a cursor position or the document start). */
export function windowFrom(buf: Buffer, offset: number, maxBytes: number): WindowSlice {
  const start = snapCodePoint(buf, offset);
  if (start >= buf.length) return sliceWindow(buf, buf.length, buf.length);
  const { end, forced } = windowEnd(buf, start, start + maxBytes);
  return sliceWindow(buf, start, end, forced);
}

/** `lines: { from, count }` (1-based), bounded by maxBytes. */
export function windowForLines(buf: Buffer, from: number, count: number, maxBytes: number): WindowSlice {
  const start = lineOffset(buf, from);
  if (start >= buf.length) return sliceWindow(buf, buf.length, buf.length);
  const target = lineOffset(buf, from + count);
  if (target - start <= maxBytes) return sliceWindow(buf, start, target);
  const { end, forced } = windowEnd(buf, start, start + maxBytes);
  return sliceWindow(buf, start, end, forced);
}

/**
 * `bytes: { offset, length }`: the start moves back to its line start when
 * that is within `length` bytes (else to a code point), the end to the last
 * line start in range (else a code point).
 */
export function windowForBytes(buf: Buffer, offset: number, length: number): WindowSlice {
  const at = Math.max(0, Math.min(offset, buf.length));
  if (at >= buf.length) return sliceWindow(buf, buf.length, buf.length);
  const ls = lineStartOf(buf, at);
  const start = at - ls <= length ? ls : snapCodePoint(buf, at);
  const { end, forced } = windowEnd(buf, start, start + length);
  return sliceWindow(buf, start, end, forced);
}

/**
 * A window around `span` (a chunk's position): the span's lines plus
 * `contextLines` lines on each side, cut to maxBytes around the span. A span
 * longer than maxBytes yields its first maxBytes.
 */
export function windowAround(buf: Buffer, span: { start: number; end: number }, contextLines: number, maxBytes: number): WindowSlice {
  const cs = Math.max(0, Math.min(span.start, buf.length));
  const ce = Math.max(cs, Math.min(span.end, buf.length));
  let ws = lineStartOf(buf, cs);
  for (let k = 0; k < contextLines && ws > 0; k++) ws = lineStartOf(buf, ws - 1);
  let we = ce;
  if (we < buf.length && (we === cs || buf[we - 1] !== NL)) {
    const nl = buf.indexOf(NL, Math.max(cs, ce - 1));
    we = nl === -1 ? buf.length : nl + 1;
  }
  for (let k = 0; k < contextLines && we < buf.length; k++) {
    const nl = buf.indexOf(NL, we);
    we = nl === -1 ? buf.length : nl + 1;
  }
  if (we - ws <= maxBytes) return sliceWindow(buf, ws, we);
  if (ce - cs >= maxBytes) {
    const ls = lineStartOf(buf, cs);
    const start = cs - ls <= maxBytes / 4 ? ls : snapCodePoint(buf, cs);
    const { end, forced } = windowEnd(buf, start, start + maxBytes);
    return sliceWindow(buf, start, end, forced);
  }
  const before = Math.floor((maxBytes - (ce - cs)) / 2);
  let start = Math.max(ws, snapCodePoint(buf, cs - before));
  if (start > 0) {
    const nl = buf.indexOf(NL, start - 1);
    if (nl !== -1 && nl + 1 <= cs) start = nl + 1;
  }
  const { end, forced } = windowEnd(buf, start, Math.min(we, start + maxBytes), ce);
  return sliceWindow(buf, start, end, forced);
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

export interface OutlineEntry {
  /** ATX heading text (headings outline), null for the text before the first heading. */
  heading?: string | null;
  level?: number;
  /** First non-empty line of a block (blocks outline: pages with fewer than two headings). */
  first_line?: string;
  line_start: number;
  line_end: number;
  byte_start: number;
  byte_end: number;
  /** Earliest and latest YYYY-MM-DD date written in the entry's text. */
  date_min?: string;
  date_max?: string;
}

export interface PageOutline {
  kind: 'headings' | 'blocks';
  entries: OutlineEntry[];
  total_entries: number;
  from_index: number;
  /** Pass as outline_from to read the next entries; absent on the last page. */
  next_from_index?: number;
}

export const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
export const FENCE = /^ {0,3}(```|~~~)/;
export const DATE = /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;

/** `text` cut to `max` UTF-16 units on a code point, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…`;
}

/**
 * The page outline, paged by entry index. Headings (outside code fences) when
 * the page has at least two; otherwise line-aligned blocks of about
 * OUTLINE_BLOCK_BYTES, each with its first line. Entries carry the line and
 * byte range to pass to a window read, and the date range written inside.
 * Built from the projected document only, so it can name nothing a window
 * could not show.
 */
export function pageOutline(buf: Buffer, from = 0, limit = DEFAULT_OUTLINE_LIMIT): PageOutline {
  const headings: Array<{ start: number; n: number; level: number; text: string }> = [];
  let inFence = false;
  let at = 0;
  let n = 1;
  while (at < buf.length) {
    const nl = buf.indexOf(NL, at);
    const end = nl === -1 ? buf.length : nl + 1;
    // Only a line whose first non-space byte is '#', '`' or '~' can open a heading or a fence.
    let k = at;
    while (k < end && k - at < 3 && buf[k] === 0x20) k++;
    const lead = buf[k];
    if (lead === 0x23 || lead === 0x60 || lead === 0x7e) {
      const text = buf.subarray(at, nl === -1 ? end : nl).toString('utf8');
      if (FENCE.test(text)) inFence = !inFence;
      else if (!inFence) {
        const h = HEADING.exec(text);
        if (h) headings.push({ start: at, n, level: h[1].length, text: clip(h[2], HEADING_MAX_CHARS) });
      }
    }
    at = end;
    n++;
  }
  const lines = totalLines(buf);
  const bounds: Array<{ start: number; end: number; heading?: string | null; level?: number }> = [];
  let kind: PageOutline['kind'] = 'headings';
  if (headings.length >= 2) {
    if (headings[0].start > 0 && buf.subarray(0, headings[0].start).toString('utf8').trim()) {
      bounds.push({ start: 0, end: headings[0].start, heading: null });
    }
    headings.forEach((h, i) => bounds.push({ start: h.start, end: headings[i + 1]?.start ?? buf.length, heading: h.text, level: h.level }));
  } else {
    kind = 'blocks';
    let pos = 0;
    while (pos < buf.length) {
      const { end } = windowEnd(buf, pos, pos + OUTLINE_BLOCK_BYTES);
      bounds.push({ start: pos, end });
      pos = end;
    }
  }
  const total = bounds.length;
  const entries: OutlineEntry[] = [];
  // Line numbers accumulate across bounds in one pass over the newlines.
  let line = 1;
  let counted = 0;
  const lineAt = (b: number) => {
    let i = buf.indexOf(NL, counted);
    while (i !== -1 && i < b) { line++; i = buf.indexOf(NL, i + 1); }
    counted = b;
    return line;
  };
  for (let i = 0; i < Math.min(total, from + limit); i++) {
    const bound = bounds[i];
    const lineStart = lineAt(bound.start);
    if (i < from) continue;
    const text = buf.subarray(bound.start, bound.end).toString('utf8');
    let min: string | undefined;
    let max: string | undefined;
    for (const m of text.matchAll(DATE)) {
      if (!min || m[0] < min) min = m[0];
      if (!max || m[0] > max) max = m[0];
    }
    let lineEnd = lineStart;
    for (let j = text.indexOf('\n'); j !== -1 && j < text.length - 1; j = text.indexOf('\n', j + 1)) lineEnd++;
    entries.push({
      ...(kind === 'headings' ? { heading: bound.heading ?? null, ...(bound.level ? { level: bound.level } : {}) } : {}),
      ...(kind === 'blocks' ? { first_line: clip(firstLine(text), FIRST_LINE_MAX_CHARS) } : {}),
      line_start: lineStart, line_end: Math.min(lineEnd, lines), byte_start: bound.start, byte_end: bound.end,
      ...(min ? { date_min: min, date_max: max } : {}),
    });
  }
  return { kind, entries, total_entries: total, from_index: from, ...(from + entries.length < total ? { next_from_index: from + entries.length } : {}) };
}

function firstLine(text: string): string {
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const line = text.slice(at, nl === -1 ? text.length : nl).trim();
    if (line) return line;
    if (nl === -1) break;
    at = nl + 1;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/** Which text a window slices: the read projection, or the canonical round-trip markdown (`content`). */
export type WindowView = 'read' | 'markdown';

export interface WindowCursor {
  /** Page id and revision the position belongs to. */
  page_id: number;
  revision: string;
  view: WindowView;
  offset: number;
  max_bytes: number;
}

const CURSOR_PREFIX = 'gpw1.';

/** Opaque, revision-bound continuation token. Not a credential: it names a position and grants nothing. */
export function encodeCursor(c: WindowCursor): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify([c.page_id, c.revision, c.view, c.offset, c.max_bytes]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): WindowCursor | null {
  if (typeof raw !== 'string' || !raw.startsWith(CURSOR_PREFIX)) return null;
  const payload = raw.slice(CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 5) return null;
    const [page_id, revision, view, offset, max_bytes] = v;
    if (!Number.isSafeInteger(page_id) || typeof revision !== 'string' || (view !== 'read' && view !== 'markdown')
      || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max_bytes) || max_bytes <= 0) return null;
    return { page_id, revision, view, offset, max_bytes };
  } catch {
    return null;
  }
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
