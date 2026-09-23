/**
 * Linear (O(lines)) fenced-code-block scanner — the #2862 replacement for the
 * `marked.lexer` full-body walk in import-file.ts. marked's lexer is
 * quadratic on autolink/inline-dense text under bun (a single fence in a
 * 418KB autolink body cost ~50s of lexing; bigger bodies are an OOM class),
 * and fence extraction only ever consumed its top-level `code` tokens. The
 * scanner implements just the CommonMark fence grammar those tokens covered:
 *   - opener: up to 3 spaces of indent, then ``` or ~~~ (3+ chars) + info
 *     string. A backtick opener whose info string contains a backtick is
 *     inline code, not a fence (CommonMark).
 *   - closer: same fence char, at least as long as the opener, nothing but
 *     trailing whitespace. The OTHER fence char never closes it.
 *   - unclosed fence runs to EOF.
 *   - lang = first whitespace-delimited info-string word (```ts title=x → ts).
 *   - opener indentation is stripped from body lines (up to opener depth),
 *     matching CommonMark/marked.
 * Lines are split on /\r\n|\r|\n/ mirroring marked's CR/CRLF normalization.
 */

/**
 * Maximum code fences extracted from a single markdown page. Fence-bomb DOS
 * defense — a malicious markdown file with 10K ```ts blocks could generate
 * 10K chunks × embedding API calls. Override per-page via the
 * `GBRAIN_MAX_FENCES_PER_PAGE` env var if docs-heavy brains legitimately
 * exceed 100 fences on a single page.
 */
export const MAX_FENCES_PER_PAGE = Number.parseInt(
  process.env.GBRAIN_MAX_FENCES_PER_PAGE || '100',
  10,
);

/** A code fence found by the linear scanner: first info-string word + body. */
export interface ScannedFence {
  lang: string | undefined;
  text: string;
}

/** Scan `markdown` for fenced code blocks. Empty-bodied fences are dropped;
 *  collection stops (capped: true) once `maxFences` non-empty fences exist. */
export function scanFencedBlocks(
  markdown: string,
  maxFences: number = MAX_FENCES_PER_PAGE,
): { fences: ScannedFence[]; capped: boolean } {
  const lines = markdown.split(/\r\n|\r|\n/);
  const fences: ScannedFence[] = [];
  const OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
  let i = 0;
  while (i < lines.length) {
    const m = OPEN_RE.exec(lines[i]!);
    if (!m) {
      i++;
      continue;
    }
    const indent = m[1]!.length;
    const marker = m[2]!;
    const fenceChar = marker[0]!;
    const info = m[3]!.trim();
    if (fenceChar === '`' && info.includes('`')) {
      i++; // ```foo`bar``` is inline code, not a fence opener
      continue;
    }
    const bodyLines: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (cm && cm[1]![0] === fenceChar && cm[1]!.length >= marker.length) {
        closed = true;
        break;
      }
      // Strip up to the opener's indentation from body lines (CommonMark).
      if (indent > 0) {
        // CommonMark: strip up to the opener's indentation. `indent` is a
        // bounded number (0-3), so a plain count-and-slice replaces the
        // dynamic RegExp this used to build.
        let strip = 0;
        while (strip < indent && strip < line.length && line[strip] === ' ') strip++;
        bodyLines.push(line.slice(strip));
      } else {
        bodyLines.push(line);
      }
    }
    const text = bodyLines.join('\n');
    if (text.trim()) {
      if (fences.length >= maxFences) {
        return { fences, capped: true };
      }
      fences.push({ lang: info ? info.split(/\s+/)[0] : undefined, text });
    }
    i = closed ? j + 1 : j; // unclosed → j === lines.length → loop exits
  }
  return { fences, capped: false };
}

/**
 * Where markdown code sits in a body, for deciding whether facts/takes fence
 * marker text is live: closed fenced code blocks (same opener/closer grammar as
 * scanFencedBlocks above) and inline code spans that open and close on the
 * same line. A page that documents the marker syntax in a ```markdown example
 * or a `backtick` mention is quoting the marker, not writing a fence.
 *
 * Fenced blocks are found up front in one line walk. Inline spans are only
 * needed on the few lines that hold a marker, so codeEndAt computes them for
 * that line on demand (spans never cross lines, so the answer is the same as
 * computing every line) and keeps the last line's spans for the next query.
 *
 * The two kinds of code are not equally reliable. An inline span is decided
 * within its own line. Whether a fenced block is closed depends on pairing
 * fence lines across the whole body, so one stray ``` far away shifts every
 * pairing after it: a stray opener pairs with the NEXT block's opener, and a
 * real fence between them reads as "inside a closed block". So:
 *   - fenced blocks are trusted only when the pairing shows no sign of a
 *     stray: every opener closes, and no block holds a line that could open a
 *     block as long as its own (correct nesting uses a longer outer fence).
 *     Otherwise `fenced` is empty and every marker outside an inline span
 *     stays live, exactly as before;
 *   - the privacy boundary (protectedRegions) never trusts fenced blocks at
 *     all: a real fence wrapped in a balanced code block must still be hidden;
 *   - inline spans are same-line only (a multi-line span stays live);
 *   - indented code blocks are not recognised (a fence line is never indented
 *     by four spaces in writer output, and the lazy-continuation rules would
 *     make a guess here fail open).
 * Offsets index the string as given (CRLF / CR line endings are preserved).
 */
export interface MarkdownCodeMap {
  readonly body: string;
  /** Closed fenced code blocks, sorted and disjoint; empty when fence pairing is untrustworthy. */
  readonly fenced: Array<[number, number]>;
  /** Start of the first fenced code block that never closes (runs to EOF), or -1. */
  readonly unclosedAt: number;
  readonly hasCR: boolean;
  /** Inline spans of the line last queried by inlineCodeEndAt. */
  line: { start: number; end: number; spans: Array<[number, number]> } | null;
}

export function scanMarkdownCode(markdown: string): MarkdownCodeMap {
  const fenced: Array<[number, number]> = [];
  const len = markdown.length;
  const hasCR = markdown.includes('\r');
  // Line ends are found with a cursor that only moves forward: a per-line
  // indexOf that runs to EOF on every line lacking the character is quadratic
  // on ordinary prose. CR handling is skipped when the body has none.
  const eol: EolCursor = { s: markdown, cr: hasCR ? -1 : Infinity };
  let mispaired = false;
  let start = 0;
  while (start <= len) {
    const end = lineEnd(eol, start);
    const next = lineNext(markdown, end);
    const open = fenceOpenerAt(markdown, start, end);
    if (open) {
      let s = next;
      let closedAt = -1;
      while (s <= len) {
        const e = lineEnd(eol, s);
        if (closesFence(markdown, s, e, open)) { closedAt = lineNext(markdown, e); break; }
        // A correctly nested example uses a longer outer fence, so an inner
        // line that could open a block as long as this one means the opener
        // is a stray that paired with the wrong line.
        if (!mispaired && opensFenceAsLong(markdown, s, e, open)) mispaired = true;
        s = lineNext(markdown, e);
      }
      if (closedAt !== -1) {
        fenced.push([start, Math.min(closedAt, len)]);
        start = closedAt;
        continue;
      }
      // Unclosed: this is the block every fence writer must stay above. No
      // block is trusted any more, so there is nothing left to pair.
      return { body: markdown, fenced: [], unclosedAt: start, hasCR, line: null };
    }
    start = next;
  }
  return { body: markdown, fenced: mispaired ? [] : fenced, unclosedAt: -1, hasCR, line: null };
}

/**
 * End of the markdown code that contains offset `at` (a closed fenced block or
 * an inline span on at's line), or -1 when `at` is not inside code.
 */
export function codeEndAt(map: MarkdownCodeMap, at: number): number {
  const fencedEnd = insideRange(map.fenced, at);
  if (fencedEnd !== -1) return fencedEnd;
  return inlineCodeEndAt(map, at);
}

/** End of the same-line inline code span that contains `at`, or -1. */
export function inlineCodeEndAt(map: MarkdownCodeMap, at: number): number {
  const s = map.body;
  let line = map.line;
  if (!line || at < line.start || at > line.end) {
    // Bounds of at's line, scanning only that line (never toward EOF/BOF).
    let start = s.lastIndexOf('\n', at - 1) + 1;
    let end = s.indexOf('\n', at);
    if (end === -1) end = s.length;
    if (map.hasCR) {
      for (let k = start; k < at; k++) if (s[k] === '\r') start = k + 1;
      for (let k = at; k < end; k++) if (s[k] === '\r') { end = k; break; }
    }
    // Search inside the line only: an indexOf over the whole body would run to
    // the next backtick anywhere (EOF on backtick-free pages) for every query.
    const text = s.slice(start, end);
    const spans: Array<[number, number]> = [];
    if (text.includes('`')) {
      pushInlineCodeRanges(text, 0, text.length, spans);
      for (const span of spans) { span[0] += start; span[1] += start; }
    }
    line = map.line = { start, end, spans };
  }
  return insideRange(line.spans, at);
}

interface EolCursor { s: string; cr: number }

/** Offset of the line terminator (\n, \r\n or \r) of the line at `start`, or length. */
function lineEnd(c: EolCursor, start: number): number {
  const nlAt = c.s.indexOf('\n', start);
  const nl = nlAt === -1 ? c.s.length : nlAt;
  if (c.cr === Infinity) return nl;
  if (c.cr < start) {
    const at = c.s.indexOf('\r', start);
    c.cr = at === -1 ? Infinity : at;
  }
  return c.cr < nl ? c.cr : nl;
}

/** Start of the line after the terminator at `end` (length + 1 past the last line). */
function lineNext(s: string, end: number): number {
  if (end >= s.length) return s.length + 1;
  return s[end] === '\r' && s[end + 1] === '\n' ? end + 2 : end + 1;
}

// Fence lines are judged by comparing characters in place: slicing the line
// and running a regex costs more than the rest of the scan on code-heavy
// pages. The grammar is CommonMark's, as in scanFencedBlocks:
//   opener  ^ {0,3}(`{3,}|~{3,})(.*)$   a backtick info string holds no backtick
//   closer  ^ {0,3}(`{3,}|~{3,})[ \t]*$ same char, at least as long as the opener
// `(.*)$` rejects the line terminators `.` does not match (CR, U+2028, U+2029).

/** Offset of the fence char run after up to three spaces of indent, or -1. */
function fenceRunStart(s: string, start: number, end: number): number {
  let p = start;
  while (p < end && p - start < 3 && s[p] === ' ') p++;
  return p < end && (s[p] === '`' || s[p] === '~') ? p : -1;
}

/** The opener run (e.g. "```") when the line opens a fenced code block. */
function fenceOpenerAt(s: string, start: number, end: number): string | null {
  const p = fenceRunStart(s, start, end);
  if (p === -1) return null;
  const c = s[p]!;
  let q = p;
  while (q < end && s[q] === c) q++;
  if (q - p < 3) return null;
  for (let k = q; k < end; k++) {
    const ch = s[k];
    if ((c === '`' && ch === '`') || ch === '\r' || ch === '\u2028' || ch === '\u2029') return null;
  }
  return s.slice(p, q);
}

function opensFenceAsLong(s: string, start: number, end: number, opener: string): boolean {
  const inner = fenceOpenerAt(s, start, end);
  return !!inner && inner[0] === opener[0] && inner.length >= opener.length;
}

function closesFence(s: string, start: number, end: number, opener: string): boolean {
  const p = fenceRunStart(s, start, end);
  if (p === -1 || s[p] !== opener[0]) return false;
  let q = p;
  while (q < end && s[q] === opener[0]) q++;
  if (q - p < opener.length) return false;
  for (let k = q; k < end; k++) if (s[k] !== ' ' && s[k] !== '\t') return false;
  return true;
}

function pushInlineCodeRanges(s: string, start: number, end: number, out: Array<[number, number]>): void {
  let k = start;
  while (k < end) {
    k = s.indexOf('`', k);
    if (k === -1 || k >= end) return;
    let run = k;
    while (run < end && s[run] === '`') run++;
    const len = run - k;
    let escaped = 0;
    for (let b = k - 1; b >= start && s[b] === '\\'; b--) escaped++;
    if (escaped % 2 === 1) { k = run; continue; }
    let close = -1;
    for (let c = run; c < end;) {
      c = s.indexOf('`', c);
      if (c === -1 || c >= end) break;
      let r = c;
      while (r < end && s[r] === '`') r++;
      if (r - c === len) { close = c; break; }
      c = r;
    }
    if (close === -1) { k = run; continue; }
    out.push([k, close + len]);
    k = close + len;
  }
}

function insideRange(ranges: Array<[number, number]>, at: number): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid]!;
    if (at < s) hi = mid - 1;
    else if (at >= e) lo = mid + 1;
    else return e;
  }
  return -1;
}

/**
 * `body.indexOf(needle, fromIndex)`, skipping occurrences that start inside
 * markdown code (see scanMarkdownCode). The code scan only runs when the
 * needle is present at all, so marker-free pages pay one indexOf. Callers that
 * search one body repeatedly pass `code` (scanned once) to avoid rescans.
 */
export function indexOfOutsideCode(
  body: string,
  needle: string,
  fromIndex = 0,
  code?: MarkdownCodeMap,
): number {
  let at = body.indexOf(needle, fromIndex);
  if (at === -1) return -1;
  code ??= scanMarkdownCode(body);
  for (let skip = codeEndAt(code, at); skip !== -1; skip = codeEndAt(code, at)) {
    at = body.indexOf(needle, skip);
    if (at === -1) return -1;
  }
  return at;
}

/**
 * Offset where an unclosed fenced code block opens (it runs to EOF), or -1.
 * Fence writers insert a new fence above it so the fence is not rendered as
 * code — the same "place the fence where it is read" rule as the timeline
 * sentinel (#4756).
 */
export function unclosedCodeFenceStart(markdown: string): number {
  return scanMarkdownCode(markdown).unclosedAt;
}

/**
 * Index of the first of `lines` (a body split on '\n') for which `isSentinel`
 * holds and that does not start inside a closed fenced code block, or -1.
 * The line-based form of indexOfOutsideCode for whole-line markers (the
 * timeline sentinel): inline spans cannot hold a whole line, so only fenced
 * blocks matter, under the same fence grammar and trust rule as
 * MarkdownCodeMap (a trailing CR is a line ending; a bare CR mid-line is not).
 *
 * No joined body is built. Lines are first checked for a candidate alone, as
 * without code awareness; the fence walk starts only once one exists. When
 * the pairing turns out untrustworthy the answer is the first candidate
 * anywhere, so a first candidate outside every block is the answer either
 * way and ends the walk; only a candidate quoted in a block before it makes
 * the rest of the body worth reading.
 */
export function findLineOutsideFencedCode(
  lines: readonly string[],
  isSentinel: (i: number) => boolean,
): number {
  let first = 0;
  while (first < lines.length && !isSentinel(first)) first++;
  if (first === lines.length) return -1;
  const walk: FenceWalk = { opener: null, mispaired: false };
  for (let i = 0; i < first; i++) stepFenceWalk(walk, lines[i]!);
  let firstQuoted = -1;
  let firstOutside = -1;
  for (let i = first; i < lines.length; i++) {
    const candidate = i === first || isSentinel(i);
    if (candidate && !walk.opener) {
      if (firstQuoted === -1 || walk.mispaired) return firstQuoted === -1 ? i : firstQuoted;
      if (firstOutside === -1) firstOutside = i;
      continue;
    }
    if (candidate && firstQuoted === -1) firstQuoted = i;
    stepFenceWalk(walk, lines[i]!);
  }
  // An unclosed block or a mispairing: no block is trusted.
  return walk.opener || walk.mispaired ? firstQuoted : firstOutside;
}

interface FenceWalk { opener: string | null; mispaired: boolean }

/** Advance the fence pairing by one line (a trailing CR is its line ending). */
function stepFenceWalk(walk: FenceWalk, line: string): void {
  // A fence line starts with indent, ` or ~; every other line is prose to it.
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 96 && c0 !== 126) return;
  const end = line.charCodeAt(line.length - 1) === 13 ? line.length - 1 : line.length;
  if (!walk.opener) {
    walk.opener = fenceOpenerAt(line, 0, end);
  } else if (closesFence(line, 0, end, walk.opener)) {
    walk.opener = null;
  } else if (!walk.mispaired && opensFenceAsLong(line, 0, end, walk.opener)) {
    walk.mispaired = true;
  }
}

/**
 * Locate a begin/end marker pair outside markdown code with ONE code scan —
 * the paired form of indexOfOutsideCode that every fence reader and writer
 * uses. Same offsets as the two-call form: `endIdx` is searched from
 * `beginIdx + begin.length` even when `beginIdx` is -1.
 */
export function locateOutsideCode(
  body: string,
  begin: string,
  end: string,
): { beginIdx: number; endIdx: number } {
  if (!body.includes(begin) && !body.includes(end)) return { beginIdx: -1, endIdx: -1 };
  const code = scanMarkdownCode(body);
  const beginIdx = indexOfOutsideCode(body, begin, 0, code);
  return { beginIdx, endIdx: indexOfOutsideCode(body, end, beginIdx + begin.length, code) };
}

/** A begin/end marker pair that delimits a protected fence. */
export interface FencePair {
  readonly begin: string;
  readonly end: string;
}

/** A protected fence found by protectedRegions: body.slice(start, end) spans begin..end markers. */
export interface ProtectedRegion {
  /** Index into the `pairs` argument. */
  readonly pair: number;
  readonly start: number;
  readonly end: number;
  /**
   * True when readers (parse, upsert) also see this fence. False when its begin
   * sits inside a closed fenced code block — readers treat it as an example,
   * only the privacy boundary hides it.
   */
  readonly read: boolean;
}

/**
 * The privacy boundary's view of protected fences: what must never leave the
 * page (remote reads, chunks, synopses) and what a remote write must keep.
 *
 * It trusts only inline code spans. Fenced code blocks are ignored, because a
 * stray ``` elsewhere in the body can make a real fence look like the inside
 * of a closed block (see MarkdownCodeMap). A fence that readers do see must be
 * hidden completely, so a begin that readers see opens a region that closes
 * only at the end marker readers pair with it — markers inside code blocks
 * between the two are part of the region, not its end. Otherwise every other
 * marker closes or breaks the open region as the unstructured scan always did.
 *
 * `truncatedAt` is where an ambiguous tail starts (an unpaired begin, a second
 * begin, the wrong end): everything from there to EOF is protected. -1 when
 * every begin paired.
 */
export function protectedRegions(
  body: string,
  pairs: readonly FencePair[],
): { regions: ProtectedRegion[]; truncatedAt: number } {
  const regions: ProtectedRegion[] = [];
  const markers = pairs.flatMap(p => [p.begin, p.end]);
  const pattern = new RegExp(markers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  // The code scan runs only once a marker exists at all.
  let code: MarkdownCodeMap | undefined;
  let open: { pair: number; start: number; read: boolean } | null = null;
  // Each token is visited once, in body order.
  for (const token of body.matchAll(pattern)) {
    const at = token.index;
    code ??= scanMarkdownCode(body);
    if (inlineCodeEndAt(code, at) !== -1) continue;
    const read = insideRange(code.fenced, at) === -1;
    if (!open) {
      const pair = pairs.findIndex(p => p.begin === token[0]);
      if (pair !== -1) open = { pair, start: at, read };
      continue;
    }
    // A reader-visible fence runs to its reader-visible end.
    if (open.read && !read) continue;
    if (token[0] !== pairs[open.pair]!.end) return { regions, truncatedAt: open.start };
    regions.push({ pair: open.pair, start: open.start, end: at + token[0].length, read: open.read });
    open = null;
  }
  return { regions, truncatedAt: open ? open.start : -1 };
}
