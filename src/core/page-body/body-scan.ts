/**
 * Pass 1 of streaming ingest (Wave B, spec 3.1): one read of a raw markdown
 * file that decides what parseMarkdown decides, without ever holding the
 * file as one string. Memory is O(SCAN_LINE_BUFFER_BYTES) beyond a bounded
 * head, whatever the line lengths, except that the line giving the title (a
 * body H1, or an embedded fence `title:`) is held whole: its text is the result.
 *
 * Head. The frontmatter readers run on a prefix `P` of the file (at most
 * FRONTMATTER_HEAD_MAX_BYTES) through the same code parseMarkdown uses
 * (`parseMarkdownHead`, `parsedMarkdownFields`), so frontmatter, title, type,
 * tags, slug and validation findings equal `parseMarkdown(content)`. `P` is the
 * whole file when it fits; otherwise the head up to its last newline (or any
 * prefix when the first non-blank character is not `-`, which no reader can
 * take for a fence). When a reader's fence would close beyond `P`, the result
 * is `frontmatter_head_unbounded` and the caller holds the file as
 * `invalid_frontmatter`. The readers that must close inside `P`: the data
 * fence (`scanDataFrontmatter`), the pre-quote pass's fence (unless no later
 * line closes it, or closing it would change no line), and with `validate`
 * the validator's `---` line. A NUL beyond `P` is added to the findings as
 * parseMarkdown's whole-file NULL_BYTES check would report it.
 *
 * Body. One line iterator runs, in body order, splitBody's state machine
 * (sentinel lines with the quoted-sentinel fallback of
 * findLineOutsideFencedCode, the pending `---` before a Timeline/History H2,
 * the bare timeline section), the body title readers, and fence walks over
 * each candidate region. At EOF the split is final and is reported as byte
 * ranges of the file: concatenating `truth` reproduces exactly
 * `parseMarkdown(content).compiled_truth`, and `timeline` its `.timeline`.
 * splitBody's `.trim()` becomes range endpoints (the first and last
 * non-whitespace code point of each region). The bare section's truth is two
 * ranges (before the section, and from the next H2 on). One rewrite is not a
 * range: when the pre-quote pass rewrites body lines inside `P` (a fence that
 * closes on a later bare `---` line), that part of the body is a `{ text }`
 * piece holding the rewritten text, exactly as parseMarkdown sees it.
 *
 * Long lines. A line longer than the line buffer is decoded in slices into a
 * `LongLine`: its compressed head (every line classifier is anchored at the
 * line start and reads a bounded structure there; see `LongLine.head`), its
 * content endpoints, one fence token per CR sub-line (fed to the region walks
 * as the slices arrive), the pre-quote rewrite test, and its text only while
 * it can still be the title line.
 *
 * `body_flags.fence_trust` / `timeline_fence_trust` are scanMarkdownCode's
 * trust of each region's text as stored: no unclosed and no mispaired fence.
 *
 * Not applied here: `sanitizeText` (batch-rows.ts) strips NUL from the stored
 * regions after the split on today's path; the caller applies it per segment
 * in pass 2 (`body_flags.has_nul` says whether it changes anything). Lone
 * surrogates cannot occur: the file must be valid UTF-8 (`invalid_utf8`).
 */
import { scanDataFrontmatter } from '../data-frontmatter.ts';
import {
  bareTimelineSectionLine, coerceFrontmatterString, comparableFrontmatter, embeddedTitleLineValue, FENCE_TOGGLE_RE,
  frontmatterQuoteFence, h1TitleLineValue, isBareTimelineHeading, isTimelineHeadingAfterDash, nullBytesError,
  parsedMarkdownFields, parseMarkdownHead, quoteAmbiguousFrontmatterLine, timelineSentinelKind, validatorFrontmatterFence,
  type ParsedMarkdown, type ParsedMarkdownHead, type ParseOpts,
} from '../markdown.ts';
import { FRONTMATTER_HEAD_MAX_BYTES, SCAN_LINE_BUFFER_BYTES } from './limits.ts';

/** A file byte range `[start, end)`, or rewritten text the pre-quote pass produced inside the head. */
export type BodyPiece = { start: number; end: number } | { text: string };
export type FenceTrust = 'trusted' | 'void';

export interface BodyFlags {
  /** scanMarkdownCode trust of compiled_truth: 'void' when a fence is unclosed or mispaired. */
  fence_trust: FenceTrust;
  timeline_fence_trust: FenceTrust;
  /** How splitBody split: at a sentinel line, by moving a bare Timeline/History section, or not at all. */
  timeline_split: 'none' | 'sentinel' | 'bare_section';
  has_nul: boolean;
}

export interface BodyScan {
  kind: 'ok';
  /** parseMarkdown(content) without the body regions. */
  parsed: Omit<ParsedMarkdown, 'compiled_truth' | 'timeline'>;
  truth: BodyPiece[];
  timeline: BodyPiece[];
  truthBytes: number;
  timelineBytes: number;
  /** Lines of the stored stream (truth then timeline, no separator): newlines + 1, or 0 when empty. */
  bodyLines: number;
  totalBytes: number;
  bodyFlags: BodyFlags;
}

export type HeadReader = 'first_line' | 'data_fence' | 'quote_fence' | 'validator_fence';

export type BodyScanResult =
  | BodyScan
  | { kind: 'frontmatter_head_unbounded'; reader: HeadReader; message: string }
  | { kind: 'invalid_utf8'; offset: number };

type BodyScanRefusal = Exclude<BodyScanResult, BodyScan>;

/** A position in the virtual body (literal piece, then file bytes) and the 0-based line holding it. */
interface Pos { byte: number; line: number }

interface Line {
  index: number;
  start: number;
  /** The line, or for a long line its compressed head (`LongLine.head`). */
  text: string;
  hasNewline: boolean;
  /** First non-whitespace code point, or null for a blank line. */
  contentStart: Pos | null;
  /** End of the last non-whitespace code point. */
  contentEnd: Pos | null;
}

/**
 * A fence line as fence-scan.ts judges it: a run of at least three of one
 * fence char (code `c`) after up to three spaces, followed by text the opener
 * grammar accepts; `blank` when only spaces and tabs follow, so it can close.
 * A line whose tail the opener grammar rejects can neither open, close nor
 * mispair, so it has no token.
 */
interface FenceToken { c: number; n: number; blank: boolean }
type Token = FenceToken | null;

/** stepFenceWalk's state with the opener as its run, so a run longer than the line buffer needs no string. */
interface RunWalk { open: FenceToken | null; mispaired: boolean }

/**
 * @internal Work pass 1 does, for the linearity test: bytes the line split
 * searches and the head readers read (`bytes`); bytes copied to join or keep
 * a line's carry, a long line's code-point tail or the head (`carry`); lines
 * read (`lines`); UTF-16 units the per-line passes read (`chars`: decode, NUL
 * and content endpoints, the line-head classifiers, fence tokens, the region
 * walks' held text, the long-line readers, the title readers); and region-walk
 * steps and copies (`walks`). Counts, not time, so a busy machine cannot move
 * them.
 */
export const bodyScanWork = { bytes: 0, carry: 0, lines: 0, chars: 0, walks: 0 };

/** The token stepFenceWalk reads in `s` (a trailing CR is its line ending). */
function fenceToken(s: string): Token {
  bodyScanWork.chars += s.length;
  const c0 = s.charCodeAt(0);
  if (c0 !== 32 && c0 !== 96 && c0 !== 126) return null;
  const end = s.charCodeAt(s.length - 1) === 13 ? s.length - 1 : s.length;
  let p = 0;
  while (p < end && p < 3 && s.charCodeAt(p) === 32) p++;
  const c = s.charCodeAt(p);
  if (p >= end || (c !== 96 && c !== 126)) return null;
  let q = p;
  while (q < end && s.charCodeAt(q) === c) q++;
  if (q - p < 3) return null;
  let blank = true;
  for (let k = q; k < end; k++) {
    const ch = s.charCodeAt(k);
    if ((c === 96 && ch === 96) || ch === 13 || ch === 0x2028 || ch === 0x2029) return null;
    if (ch !== 32 && ch !== 9) blank = false;
  }
  return { c, n: q - p, blank };
}

/** stepFenceWalk over a token: open, close on a blank run at least as long, or mispair on a longer opener. */
function stepToken(walk: RunWalk, token: Token): void {
  if (!token) return;
  if (!walk.open) {
    walk.open = token;
  } else if (token.c === walk.open.c && token.n >= walk.open.n) {
    if (token.blank) walk.open = null;
    else walk.mispaired = true;
  }
}

/** One nonblank CR sub-line of a long line, as each trim of the region text could leave it. */
interface SubLine { raw: Token; start: Token; end: Token; both: Token }

/**
 * scanMarkdownCode's fence pairing over a region's text, fed line by line
 * (or a long line's sub-lines) with the region's trim applied. The region's
 * last content is held unstepped, since the trailing trim may still shorten
 * it: a short line's text, or a long line's last nonblank sub-line.
 */
class RegionFenceWalk {
  private walk: RunWalk = { open: null, mispaired: false };
  private started = false;
  private text: string | null = null;
  private sub: SubLine | null = null;
  /** `sub` is the region's first content, so the leading trim applies to it. */
  private subFirst = false;

  push(line: Line): void {
    bodyScanWork.walks++;
    if (!line.contentStart) return;
    const text = this.started ? line.text : line.text.trimStart();
    this.stepHeld(this.walk, false);
    this.text = text;
    this.sub = null;
    this.started = true;
  }

  pushSub(sub: SubLine): void {
    bodyScanWork.walks++;
    this.stepHeld(this.walk, false);
    this.subFirst = !this.started;
    this.sub = sub;
    this.text = null;
    this.started = true;
  }

  clone(): RegionFenceWalk {
    bodyScanWork.walks++;
    const copy = new RegionFenceWalk();
    copy.walk = { ...this.walk };
    copy.started = this.started;
    copy.text = this.text;
    copy.sub = this.sub;
    copy.subFirst = this.subFirst;
    return copy;
  }

  trust(): FenceTrust {
    const walk = { ...this.walk };
    this.stepHeld(walk, true);
    return walk.open || walk.mispaired ? 'void' : 'trusted';
  }

  /** scanMarkdownCode ends lines at CR too; `last` applies the region's trailing trim. */
  private stepHeld(walk: RunWalk, last: boolean): void {
    if (this.text !== null) {
      bodyScanWork.chars += this.text.length;
      for (const sub of (last ? this.text.trimEnd() : this.text).split('\r')) stepToken(walk, fenceToken(sub));
    } else if (this.sub) {
      const sub = this.sub;
      stepToken(walk, this.subFirst ? (last ? sub.both : sub.start) : (last ? sub.end : sub.raw));
    }
  }
}

/** The JS `\s` and `String.prototype.trim` whitespace units. */
const WS_UNITS = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
/** 1 + the unit's index in WS_UNITS, 0 for any other unit. */
const WS_INDEX = new Uint8Array(0x10000);
for (let k = 0; k < WS_UNITS.length; k++) WS_INDEX[WS_UNITS.charCodeAt(k)] = k + 1;

const isWs = (c: number) => WS_INDEX[c]! > 0;

/** Characters the regex `.` does not match inside a line. */
const isTerminator = (c: number) => c === 13 || c === 0x2028 || c === 0x2029;

/** Longest compressed head kept: well past every anchored structure a classifier reads (at most 72 units). */
const LONG_HEAD_CHARS = 256;

const SUB_LEAD = 0, SUB_RUN = 1, SUB_REST = 2, SUB_NONE = 3;
const QUOTE_KEY0 = 0, QUOTE_KEY = 1, QUOTE_GAP = 2, QUOTE_VALUE = 3, QUOTE_NO = 4;

/**
 * What pass 1 keeps of a line longer than the line buffer, fed one decoded
 * slice at a time (slices end on code points). All of it is bounded except
 * `value`, the text of a line that may be the title.
 */
class LongLine {
  bytes = 0;
  /** An incomplete UTF-8 sequence at the end of the last slice. */
  tail: Uint8Array = new Uint8Array(0);
  hasNul = false;
  /**
   * The line with every whitespace run longer than four units cut to its
   * first two units, each other unit once, and its last two, and every `*`
   * run cut to four, truncated to LONG_HEAD_CHARS. Each classifier gives the
   * same answer on it as on the line: they test run kinds and lengths up to
   * four, and anchored structures that end within the kept head; once
   * truncated, the head is longer than any whole-line match.
   */
  head = '';
  truncated = false;
  private runKind = 0;
  private runLength = 0;
  private wsFirst = '';
  /** Bit k: WS_UNITS[k] occurs in the run between its first two and last two units. */
  private wsMiddle = 0;
  private wsLastA = -1;
  private wsLastB = -1;
  /** Line byte offset past the last non-whitespace code point. */
  contentEnd = -1;
  /** Completed nonblank sub-lines not yet given to the region walks. */
  readonly subs: SubLine[] = [];
  targets: RegionFenceWalk[] | null = null;
  /** Token of the first sub-line (null when blank), once it ends. */
  firstRaw: Token | undefined = undefined;
  /** A CR followed by more text: stepFenceWalk then rejects the line. */
  innerCr = false;
  lastUnit = -1;
  private readonly sub = { phase: SUB_LEAD, spaces: 0, onlySpaces: true, c: 0, n: 0, restBad: false, restSpTab: true, restNonWs: false, wsBad: false, endBad: false };
  private quote: { phase: number; gap: number; colonSpace: boolean; last: number } | null;
  /** 'pending' until seven units decide whether the line may be the title. */
  private valueKind: 'pending' | 'h1' | 'embedded' | null;
  private valueParts: string[] = [];
  private valuePrefix = '';
  private valueSeen = false;
  private valueBreak = false;

  constructor(readonly line: Line, quote: boolean, private readonly h1: boolean, private readonly embedded: boolean) {
    this.quote = quote ? { phase: QUOTE_KEY0, gap: 0, colonSpace: false, last: -1 } : null;
    this.valueKind = h1 || embedded ? 'pending' : null;
  }

  consume(text: string, pieceBytes: number): void {
    const before = this.bytes;
    this.bytes += pieceBytes;
    if (text.length === 0) return;
    if (this.valueKind !== null) this.keepValue(text);
    if (!this.truncated) this.compress(text);
    let last = text.length - 1;
    while (last >= 0 && isWs(text.charCodeAt(last))) last--;
    bodyScanWork.chars += 2 * (text.length - last);
    if (last >= 0) {
      const line = this.line;
      if (!line.contentStart) {
        let first = 0;
        while (isWs(text.charCodeAt(first))) first++;
        bodyScanWork.chars += 2 * first;
        line.contentStart = { byte: line.start + before + utf8(text.slice(0, first)), line: line.index };
      }
      this.contentEnd = this.bytes - utf8(text.slice(last + 1));
    }
    if (this.quote && this.quote.phase !== QUOTE_NO) this.stepQuote(text);
    if (this.lastUnit === 13) this.innerCr = true;
    bodyScanWork.chars += 2 * text.length;
    const cr = text.indexOf('\r');
    if (cr !== -1 && cr < text.length - 1) this.innerCr = true;
    this.lastUnit = text.charCodeAt(text.length - 1);
    for (let from = 0; ;) {
      const at = text.indexOf('\r', from);
      this.subUnits(text, from, at === -1 ? text.length : at);
      if (at === -1) return;
      this.endSub();
      from = at + 1;
    }
  }

  finish(): void {
    this.endRun();
    this.endSub();
  }

  /** The line's text for the title readers, or null when this line cannot give a title. */
  value(): string | null {
    return this.valueKind === null ? null : this.valueParts.join('');
  }

  /** pre-quote rewrite test (`quoteAmbiguousFrontmatterLine` non-null), once the line has ended. */
  quoteRewrites(): boolean {
    const q = this.quote!;
    return q.phase === QUOTE_VALUE && (q.colonSpace || q.last === 58);
  }

  private emit(units: string): void {
    this.head += units;
    if (this.head.length <= LONG_HEAD_CHARS) return;
    this.head = this.head.slice(0, LONG_HEAD_CHARS);
    this.truncated = true;
  }

  private compress(text: string): void {
    let i = 0;
    for (; i < text.length && !this.truncated; i++) {
      const c = text.charCodeAt(i);
      const kind = isWs(c) ? 1 : c === 42 ? 2 : 0;
      if (kind !== this.runKind) this.endRun();
      if (kind === 0) {
        this.emit(text[i]!);
        continue;
      }
      this.runKind = kind;
      this.runLength++;
      if (kind === 2) continue;
      if (this.runLength <= 2) {
        this.wsFirst += text[i];
      } else if (this.runLength <= 4) {
        this.wsLastA = this.wsLastB;
        this.wsLastB = c;
      } else {
        this.wsMiddle |= 1 << (WS_INDEX[this.wsLastA]! - 1);
        this.wsLastA = this.wsLastB;
        this.wsLastB = c;
      }
    }
    bodyScanWork.chars += i;
  }

  private endRun(): void {
    if (this.runKind === 1) {
      let middle = '';
      for (let k = 0; k < WS_UNITS.length; k++) if (this.wsMiddle & (1 << k)) middle += WS_UNITS[k];
      const last = [this.wsLastA, this.wsLastB].filter(c => c !== -1);
      this.emit(this.wsFirst + middle + String.fromCharCode(...last));
    } else if (this.runKind === 2) {
      this.emit('*'.repeat(Math.min(this.runLength, 4)));
    }
    this.runKind = 0;
    this.runLength = 0;
    this.wsFirst = '';
    this.wsMiddle = 0;
    this.wsLastA = this.wsLastB = -1;
  }

  /** Tokenize one CR sub-line's units in [from, to). */
  private subUnits(text: string, from: number, to: number): void {
    const s = this.sub;
    for (let i = from; i < to; i++) {
      if (s.phase === SUB_NONE || (s.restBad && s.endBad)) return;
      bodyScanWork.chars++;
      const c = text.charCodeAt(i);
      if (s.phase === SUB_LEAD) {
        if (isWs(c)) {
          if (c === 32) s.spaces++;
          else s.onlySpaces = false;
          continue;
        }
        if (c === 96 || c === 126) {
          s.phase = SUB_RUN;
          s.c = c;
          s.n = 1;
        } else {
          s.phase = SUB_NONE;
        }
        continue;
      }
      if (s.phase === SUB_RUN) {
        if (c === s.c) {
          s.n++;
          continue;
        }
        s.phase = SUB_REST;
      }
      const bad = c === 0x2028 || c === 0x2029 || (s.c === 96 && c === 96);
      if (bad) s.restBad = true;
      if (c !== 32 && c !== 9) s.restSpTab = false;
      if (!isWs(c)) {
        s.restNonWs = true;
        if (s.wsBad || bad) s.endBad = true;
      } else if (bad) {
        s.wsBad = true;
      }
    }
  }

  private endSub(): void {
    const s = this.sub;
    let raw: Token = null;
    if (s.phase !== SUB_LEAD) {
      const fence = (s.phase === SUB_RUN || s.phase === SUB_REST) && s.n >= 3;
      const open = fence && !s.restBad ? { c: s.c, n: s.n, blank: s.restSpTab } : null;
      const close = !fence || s.endBad ? null : open && open.blank === !s.restNonWs ? open : { c: s.c, n: s.n, blank: !s.restNonWs };
      const indented = !s.onlySpaces || s.spaces > 3;
      raw = indented ? null : open;
      this.subs.push({ raw, start: open, end: indented ? null : close, both: close });
    }
    if (this.firstRaw === undefined) this.firstRaw = raw;
    s.phase = SUB_LEAD;
    s.spaces = s.c = s.n = 0;
    s.onlySpaces = s.restSpTab = true;
    s.restBad = s.restNonWs = s.wsBad = s.endBad = false;
  }

  private stepQuote(text: string): void {
    const q = this.quote!;
    for (let i = 0; i < text.length; i++) {
      bodyScanWork.chars++;
      const c = text.charCodeAt(i);
      const word = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
      if (q.phase === QUOTE_KEY0) {
        q.phase = word ? QUOTE_KEY : QUOTE_NO;
      } else if (q.phase === QUOTE_KEY) {
        if (c === 58) q.phase = QUOTE_GAP;
        else if (!word && !(c >= 48 && c <= 57)) q.phase = QUOTE_NO;
      } else if (q.phase === QUOTE_GAP) {
        if (c === 32 || c === 9) {
          q.gap++;
          continue;
        }
        q.phase = q.gap === 0 || `'"[{|>`.includes(text[i]!) ? QUOTE_NO : QUOTE_VALUE;
        if (q.phase === QUOTE_VALUE) this.quoteValue(text.slice(i));
        return;
      } else {
        return this.quoteValue(text);
      }
      if (q.phase === QUOTE_NO) return;
    }
  }

  private quoteValue(value: string): void {
    bodyScanWork.chars += 2 * value.length;
    const q = this.quote!;
    if (/[\r\u2028\u2029]/.test(value)) {
      q.phase = QUOTE_NO;
      return;
    }
    q.colonSpace ||= value.includes(': ') || (q.last === 58 && value.charCodeAt(0) === 32);
    q.last = value.charCodeAt(value.length - 1);
  }

  /**
   * Keep the text while the line can still be the title: an H1 (`#`, then
   * whitespace) or an embedded `title:` line. Dropped once the reader's regex
   * cannot match: a line terminator inside the heading text, or inside or
   * before non-blank text of the `title:` value.
   */
  private keepValue(text: string): void {
    let from = 0;
    if (this.valueKind === 'pending') {
      from = Math.min(text.length, 7 - this.valuePrefix.length);
      this.valuePrefix += text.slice(0, from);
      this.valueParts.push(text.slice(0, from));
      if (this.valuePrefix.length < 7) return;
      const p = this.valuePrefix;
      this.valueKind = this.h1 && p[0] === '#' && isWs(p.charCodeAt(1)) ? 'h1'
        : this.embedded && p.startsWith('title:') && (p[6] === ' ' || p[6] === '\t') ? 'embedded' : null;
      if (this.valueKind === null) {
        this.valueParts = [];
        return;
      }
      this.scanValue(p, 1);
      if (this.valueKind === null) return;
    }
    if (from === text.length) return;
    const rest = from === 0 ? text : text.slice(from);
    this.valueParts.push(rest);
    this.scanValue(rest, 0);
  }

  private scanValue(text: string, from: number): void {
    bodyScanWork.chars += text.length - from;
    for (let i = from; i < text.length && this.valueKind !== null; i++) {
      const c = text.charCodeAt(i);
      if (this.valueKind === 'h1') {
        if (isTerminator(c)) this.valueBreak ||= this.valueSeen;
        else if (!isWs(c)) {
          if (this.valueBreak) this.valueKind = null;
          this.valueSeen = true;
        }
      } else if (c === 0x2028 || c === 0x2029 || (this.valueBreak && c !== 32 && c !== 9 && c !== 13)) {
        this.valueKind = null;
      } else if (c === 13) {
        this.valueBreak = true;
      }
    }
    if (this.valueKind === null) this.valueParts = [];
  }
}

const utf8 = (text: string) => Buffer.byteLength(text, 'utf8');

function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  bodyScanWork.carry += total;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Length of the longest prefix of `bytes` that ends on a code point (an invalid tail is kept whole). */
function codePointCut(bytes: Uint8Array): number {
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const b = bytes[bytes.length - back]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return back >= need ? bytes.length : bytes.length - back;
  }
  return bytes.length;
}

/** Offset of the first byte that is not valid UTF-8 (an incomplete tail counts only when `final`), or -1. */
export function firstInvalidUtf8(bytes: Uint8Array, final = true): number {
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    const need = b < 0x80 ? 0 : b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
    if (need < 0) return i;
    const lo = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80;
    const hi = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;
    for (let k = 1; k <= need; k++) {
      if (i + k >= bytes.length) return final ? i : -1;
      const c = bytes[i + k]!;
      if (k === 1 ? c < lo || c > hi : (c & 0xc0) !== 0x80) return i;
    }
    i += need + 1;
  }
  return -1;
}

interface SentinelCandidate {
  line: Line;
  /** Last content before the sentinel line (truth end), null when nothing precedes it. */
  truthEnd: Pos | null;
  truthWalk: RegionFenceWalk;
  timelineFirst: Pos | null;
  timelineWalk: RegionFenceWalk;
}

interface BareCandidate {
  line: Line;
  bullets: number;
  truthEnd: Pos | null;
  truthWalk: RegionFenceWalk;
  timelineWalk: RegionFenceWalk;
}

interface BareSection extends BareCandidate {
  /** Start of the next H2 (null when the section runs to EOF) and the last content before it. */
  end: Pos | null;
  timelineEnd: Pos;
}

interface QuoteWatch { anyBefore: boolean; prev: boolean; prevChanged: boolean }

/**
 * Push-based pass 1. `push` the raw file bytes in order (any chunking), then
 * `finish`. Throws FrontmatterLanguageError exactly where parseMarkdown would.
 * `lineBufferBytes` only exists so tests can send short lines down the long-line path.
 */
export class BodyScanner {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private refusal: BodyScanRefusal | null = null;
  private headParts: Uint8Array[] = [];
  private totalBytes = 0;
  private started = false;

  private head!: ParsedMarkdownHead;
  /** File bytes the head prefix `P` covers; later lines are checked by the quote watch. */
  private headEnd = 0;
  private literalBytes = 0;
  private literalNewlines = 0;
  private bodyFileStart = 0;
  private fileNewlinesBeforeBody = 0;
  private firstNulLine: number | null = null;
  private hasNul = false;
  private quoteWatch: QuoteWatch | null = null;
  /** A frontmatter `title:` wins, so no body line is read for a title. */
  private frontmatterTitle = false;

  private carry: Uint8Array[] = [];
  private carryBytes = 0;
  private long: LongLine | null = null;
  private pos = 0;
  private lineIndex = 0;

  private firstContent: Line | null = null;
  private lastContentEnd: Pos | null = null;
  private readonly allWalk = new RegionFenceWalk();

  private readonly sentinelWalk: RunWalk = { open: null, mispaired: false };
  private decided: SentinelCandidate | null = null;
  private firstQuoted: SentinelCandidate | null = null;
  private firstOutside: SentinelCandidate | null = null;
  private pendingDash: { candidate: SentinelCandidate; opener: boolean; mispaired: boolean } | null = null;

  private inFence = false;
  private bareCandidate: BareCandidate | null = null;
  private bare: BareSection | null = null;

  private bodyTitle: string | null = null;
  /** The current line is read for the body H1 title. */
  private titleLine = false;
  private readonly embedded = { state: 'start' as 'start' | 'block' | 'done', opener: -1, first: null as string | null, title: '' };

  constructor(private readonly filePath?: string, private readonly opts?: ParseOpts, private readonly lineBufferBytes = SCAN_LINE_BUFFER_BYTES) {}

  push(chunk: Uint8Array): void {
    if (this.refusal || chunk.length === 0) return;
    this.totalBytes += chunk.length;
    if (this.started) return this.feed(chunk);
    this.headParts.push(chunk);
    if (this.totalBytes > FRONTMATTER_HEAD_MAX_BYTES) this.startBody(false);
  }

  finish(): BodyScanResult {
    if (!this.refusal && !this.started) this.startBody(true);
    if (!this.refusal) {
      if (this.long) this.endLong(false);
      else this.onLine(concatBytes(this.carry, this.carryBytes), false);
    }
    return this.refusal ?? this.compose();
  }

  private startBody(complete: boolean): void {
    this.started = true;
    const all = concatBytes(this.headParts, this.totalBytes);
    this.headParts = [];
    const headBytes = complete ? all : all.subarray(0, FRONTMATTER_HEAD_MAX_BYTES);
    bodyScanWork.bytes += headBytes.length;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(headBytes, { stream: !complete });
    } catch {
      this.refusal = { kind: 'invalid_utf8', offset: firstInvalidUtf8(headBytes, complete) };
      return;
    }
    const firstContent = text.search(/\S/);
    const bounded = !complete && (firstContent === -1 || text[firstContent] === '-');
    const prefix = bounded ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
    if (bounded && !/\S/.test(prefix)) return this.unbounded('first_line');
    bodyScanWork.bytes += 3 * prefix.length;
    const head = parseMarkdownHead(prefix, this.opts);
    this.head = head;
    this.headEnd = utf8(prefix);
    this.frontmatterTitle = coerceFrontmatterString(head.frontmatter.title).trim() !== '';
    if (bounded) {
      let data: ReturnType<typeof scanDataFrontmatter> | null;
      try { data = scanDataFrontmatter(head.safeContent); } catch { data = null; }
      if (data?.fenced && data.fenced.content === null) return this.unbounded('data_fence');
      if (this.opts?.validate) {
        const fence = validatorFrontmatterFence(prefix.split('\n'));
        if (fence.opens && fence.closeLine === -1) return this.unbounded('validator_fence');
      }
      if (frontmatterQuoteFence(head.lifted) === 'open') {
        const watch = { anyBefore: false, prev: false, prevChanged: false };
        const lines = head.lifted.split('\n');
        for (let k = 1; k < lines.length - 1; k++) watchQuoteLine(watch, quoteAmbiguousFrontmatterLine(lines[k]!) !== null, lines[k]!.endsWith('\r'));
        this.quoteWatch = watch;
      }
    }
    if (prefix.endsWith(head.body)) {
      this.bodyFileStart = this.headEnd - utf8(head.body);
    } else {
      const literal = Buffer.from(head.body, 'utf8');
      bodyScanWork.carry += literal.length;
      this.literalBytes = literal.length;
      for (let k = 0; k < literal.length; k++) if (literal[k] === 10) this.literalNewlines++;
      this.bodyFileStart = this.headEnd;
      this.feed(literal);
    }
    bodyScanWork.bytes += this.bodyFileStart;
    for (let k = 0; k < this.bodyFileStart; k++) if (all[k] === 10) this.fileNewlinesBeforeBody++;
    this.feed(all.subarray(this.bodyFileStart));
  }

  private unbounded(reader: HeadReader): void {
    const what = reader === 'first_line' ? 'the first line' : 'the frontmatter block';
    this.refusal = { kind: 'frontmatter_head_unbounded', reader,
      message: `Frontmatter not readable: ${what} does not end within the first ${FRONTMATTER_HEAD_MAX_BYTES} bytes.` };
  }

  /** Split virtual body bytes into '\n' lines (body.split('\n') semantics; the last line arrives in `finish`). */
  private feed(bytes: Uint8Array): void {
    let from = 0;
    while (!this.refusal) {
      const nl = bytes.indexOf(10, from);
      const end = nl === -1 ? bytes.length : nl;
      bodyScanWork.bytes += end - from + 1;
      if (this.long || this.carryBytes + end - from > this.lineBufferBytes) {
        this.feedLong(bytes.subarray(from, end));
        if (nl === -1 || this.refusal) return;
        this.endLong(true);
      } else if (nl === -1) {
        if (from < end) {
          bodyScanWork.carry += end - from;
          this.carry.push(bytes.slice(from));
          this.carryBytes += end - from;
        }
        return;
      } else if (this.carryBytes > 0) {
        this.carry.push(bytes.subarray(from, nl));
        const line = concatBytes(this.carry, this.carryBytes + nl - from);
        this.carry = [];
        this.carryBytes = 0;
        this.onLine(line, true);
      } else {
        this.onLine(bytes.subarray(from, nl), true);
      }
      from = nl + 1;
    }
  }

  /** File offset of virtual body byte `v` (the literal piece, when any, precedes the file bytes). */
  private fileOffset(v: number): number {
    return v - this.literalBytes + this.bodyFileStart;
  }

  /** Line number parseMarkdown's NULL_BYTES finding names for a NUL on body line `index`, when the line is in the file. */
  private noteNul(start: number, index: number): void {
    this.hasNul = true;
    if (start >= this.literalBytes && this.firstNulLine === null) this.firstNulLine = this.fileNewlinesBeforeBody + index - this.literalNewlines + 1;
  }

  /** The quote watch reads this line: the pre-quote fence is still open past the head. */
  private quoteWatched(start: number): boolean {
    return this.quoteWatch !== null && start >= this.literalBytes && this.fileOffset(start) >= this.headEnd;
  }

  /** The quote watch's step for one line; false when it refused. */
  private watchQuote(text: string, hasNewline: boolean, rewrites: boolean, endsCr: boolean): boolean {
    const watch = this.quoteWatch!;
    if (text === '---' || (text === '---\r' && hasNewline)) {
      if (watch.anyBefore || watch.prevChanged) {
        this.unbounded('quote_fence');
        return false;
      }
      this.quoteWatch = null;
    } else {
      watchQuoteLine(watch, rewrites, endsCr);
    }
    return true;
  }

  private onLine(bytes: Uint8Array, hasNewline: boolean): void {
    const start = this.pos;
    const index = this.lineIndex++;
    bodyScanWork.lines++;
    this.pos = start + bytes.length + (hasNewline ? 1 : 0);
    let text: string;
    try {
      text = this.decoder.decode(bytes);
    } catch {
      this.refusal = { kind: 'invalid_utf8', offset: this.fileOffset(start) + firstInvalidUtf8(bytes) };
      return;
    }
    bodyScanWork.chars += 2 * bytes.length + 2 * text.length;
    if (bytes.indexOf(0) !== -1) this.noteNul(start, index);
    if (this.quoteWatched(start)) bodyScanWork.chars += text.length;
    if (this.quoteWatched(start) && !this.watchQuote(text, hasNewline, quoteAmbiguousFrontmatterLine(text) !== null, text.endsWith('\r'))) return;
    const lead = text.search(/\S/);
    let contentStart: Pos | null = null;
    let contentEnd: Pos | null = null;
    if (lead !== -1) {
      const trailing = text.length - text.trimEnd().length;
      contentStart = { byte: start + utf8(text.slice(0, lead)), line: index };
      contentEnd = { byte: start + bytes.length - utf8(text.slice(text.length - trailing)), line: index };
    }
    const line = { index, start, text, hasNewline, contentStart, contentEnd };
    for (const walk of this.lineHead(line)) walk.push(line);
    this.lineEnd(line, fenceToken(text), text);
  }

  /** Bytes of a line longer than the line buffer, read in slices that end on code points. */
  private feedLong(bytes: Uint8Array): void {
    let long = this.long;
    if (!long) {
      bodyScanWork.lines++;
      const index = this.lineIndex++;
      const line: Line = { index, start: this.pos, text: '', hasNewline: false, contentStart: null, contentEnd: null };
      const e = this.embedded;
      long = this.long = new LongLine(line, this.quoteWatched(line.start),
        !this.frontmatterTitle && this.bodyTitle === null && !this.inFence,
        !this.frontmatterTitle && e.state === 'block' && e.first === null);
      const carry = this.carry;
      this.carry = [];
      this.carryBytes = 0;
      for (const part of carry) this.sliceLong(part);
    }
    this.sliceLong(bytes);
  }

  private sliceLong(bytes: Uint8Array): void {
    const long = this.long!;
    for (let at = 0; at < bytes.length && !this.refusal;) {
      const take = Math.min(bytes.length - at, this.lineBufferBytes);
      let slice = bytes.subarray(at, at + take);
      at += take;
      if (long.tail.length > 0) slice = concatBytes([long.tail, slice], long.tail.length + slice.length);
      const cut = codePointCut(slice);
      bodyScanWork.carry += slice.length - cut;
      long.tail = slice.slice(cut);
      this.decodeLong(slice.subarray(0, cut));
    }
  }

  private decodeLong(piece: Uint8Array): void {
    if (piece.length === 0) return;
    const long = this.long!;
    bodyScanWork.chars += 2 * piece.length;
    let text: string;
    try {
      text = this.decoder.decode(piece);
    } catch {
      this.refusal = { kind: 'invalid_utf8', offset: this.fileOffset(long.line.start + long.bytes) + firstInvalidUtf8(piece) };
      return;
    }
    if (!long.hasNul && piece.indexOf(0) !== -1) {
      long.hasNul = true;
      this.noteNul(long.line.start, long.line.index);
    }
    long.consume(text, piece.length);
    if (!long.targets && long.truncated) this.longHead(long);
    this.drainLong(long);
  }

  private longHead(long: LongLine): void {
    long.line.text = long.head;
    long.targets = this.lineHead(long.line);
  }

  private drainLong(long: LongLine): void {
    if (!long.targets) return;
    bodyScanWork.walks += long.targets.length;
    for (const sub of long.subs) for (const walk of long.targets) walk.pushSub(sub);
    long.subs.length = 0;
  }

  private endLong(hasNewline: boolean): void {
    const long = this.long!;
    if (long.tail.length > 0) {
      this.refusal = { kind: 'invalid_utf8', offset: this.fileOffset(long.line.start + long.bytes) + firstInvalidUtf8(long.tail) };
      return;
    }
    this.long = null;
    long.finish();
    const line = long.line;
    line.hasNewline = hasNewline;
    if (long.contentEnd !== -1) line.contentEnd = { byte: line.start + long.contentEnd, line: line.index };
    this.pos = line.start + long.bytes + (hasNewline ? 1 : 0);
    if (!long.targets) this.longHead(long);
    if (this.quoteWatched(line.start) && !this.watchQuote(line.text, hasNewline, long.quoteRewrites(), long.lastUnit === 13)) return;
    this.drainLong(long);
    this.lineEnd(line, long.innerCr ? null : long.firstRaw ?? null, long.value());
  }

  private newCandidate(line: Line): SentinelCandidate {
    return { line, truthEnd: this.lastContentEnd, truthWalk: this.allWalk.clone(), timelineFirst: null, timelineWalk: new RegionFenceWalk() };
  }

  /** findLineOutsideFencedCode's decision for one candidate line, given the fence walk before it. */
  private register(candidate: SentinelCandidate, opener: boolean, mispaired: boolean): void {
    if (this.decided) return;
    if (!opener) {
      if (!this.firstQuoted || mispaired) {
        this.decided = this.firstQuoted ?? candidate;
        this.firstOutside ??= candidate;
        return;
      }
      this.firstOutside ??= candidate;
    } else {
      this.firstQuoted ??= candidate;
    }
  }

  /**
   * The decisions a line's head settles (sentinels, the bare section, which
   * fence state it is read in), before the line feeds any walk; returns the
   * region walks its text feeds, in order.
   */
  private lineHead(line: Line): RegionFenceWalk[] {
    const { text, contentStart } = line;
    bodyScanWork.chars += 4 * text.length;
    const trimmed = contentStart ? text.trim() : '';
    const targets: RegionFenceWalk[] = [];

    if (this.pendingDash && contentStart) {
      const { candidate, opener, mispaired } = this.pendingDash;
      this.pendingDash = null;
      if (isTimelineHeadingAfterDash(trimmed)) this.register(candidate, opener, mispaired);
    }
    if (!this.decided && contentStart) {
      const kind = timelineSentinelKind(trimmed);
      const opener = this.sentinelWalk.open !== null;
      const mispaired = this.sentinelWalk.mispaired;
      if (kind === 'marker') this.register(this.newCandidate(line), opener, mispaired);
      else if (kind === 'dash' && this.firstContent) this.pendingDash = { candidate: this.newCandidate(line), opener, mispaired };
    }
    for (const candidate of new Set([this.firstQuoted, this.firstOutside])) {
      bodyScanWork.walks++;
      if (!candidate || candidate.line.index >= line.index) continue;
      if (!candidate.timelineFirst && contentStart) candidate.timelineFirst = contentStart;
      targets.push(candidate.timelineWalk);
    }

    const toggle = FENCE_TOGGLE_RE.test(text);
    const inFence = this.inFence;
    if (toggle) this.inFence = !inFence;
    this.stepBare(line, toggle || inFence, targets);
    this.titleLine = this.bodyTitle === null && !toggle && !inFence;
    targets.push(this.allWalk);
    return targets;
  }

  /** The rest of the line once it has ended: `fence` is its token for the sentinel walk, `value` its text for the title readers. */
  private lineEnd(line: Line, fence: Token, value: string | null): void {
    if (!this.decided) stepToken(this.sentinelWalk, fence);
    if (this.titleLine && value !== null) {
      bodyScanWork.chars += value.length;
      this.bodyTitle = h1TitleLineValue(value);
    }
    this.stepEmbeddedTitle(line, value);
    if (line.contentStart) {
      this.firstContent ??= line;
      this.lastContentEnd = line.contentEnd;
    }
  }

  /** findBareTimelineSection, one line at a time; `skip` is a fence toggle or a line inside the toggled fence. */
  private stepBare(line: Line, skip: boolean, targets: RegionFenceWalk[]): void {
    if (this.bare) {
      targets.push(this.bare.truthWalk);
      return;
    }
    const pending = this.bareCandidate;
    if (pending) {
      bodyScanWork.chars += line.text.length;
      const kind = bareTimelineSectionLine(line.text, pending.bullets);
      if (kind === 'end' || kind === 'other') {
        this.bareCandidate = null;
        if (kind === 'end' && pending.bullets > 0) {
          this.bare = { ...pending, end: { byte: line.start, line: line.index }, timelineEnd: this.lastContentEnd! };
          targets.push(this.bare.truthWalk);
          return;
        }
      } else {
        if (kind === 'bullet') pending.bullets++;
        targets.push(pending.timelineWalk);
      }
    }
    if (skip || !this.firstContent || !isBareTimelineHeading(line.text)) return;
    const timelineWalk = new RegionFenceWalk();
    targets.push(timelineWalk);
    this.bareCandidate = { line, bullets: 0, truthEnd: this.lastContentEnd, truthWalk: this.allWalk.clone(), timelineWalk };
  }

  /** inferTitleFromEmbeddedFrontmatter, one line at a time. */
  private stepEmbeddedTitle(line: Line, value: string | null): void {
    const e = this.embedded;
    if (e.state !== 'done') bodyScanWork.chars += line.text.length + (value?.length ?? 0);
    if (e.state === 'start') {
      if (!line.contentStart) return;
      e.state = line.hasNewline && /^---[ \t]*\r?$/.test(line.text.trimStart()) ? 'block' : 'done';
      e.opener = line.index;
    } else if (e.state === 'block') {
      const closes = /^---[ \t]*$/.test(line.text) || (line.hasNewline && /^---[ \t]*\r$/.test(line.text));
      if (line.index >= e.opener + 2 && closes) {
        e.title = e.first ?? '';
        e.state = 'done';
      } else if (e.first === null && value !== null) {
        e.first = embeddedTitleLineValue(value);
      }
    }
  }

  private compose(): BodyScan {
    const last = this.lastContentEnd;
    if (this.bareCandidate && this.bareCandidate.bullets > 0) this.bare = { ...this.bareCandidate, end: null, timelineEnd: last! };
    const sentinel = this.decided
      ?? (this.sentinelWalk.open !== null || this.sentinelWalk.mispaired ? this.firstQuoted : this.firstOutside);
    const first = this.firstContent?.contentStart ?? null;
    let truth: Array<[Pos, Pos]> = [];
    let timeline: Array<[Pos, Pos]> = [];
    let flags: Omit<BodyFlags, 'has_nul'>;
    if (sentinel) {
      if (first && sentinel.truthEnd) truth = [[first, sentinel.truthEnd]];
      if (sentinel.line.hasNewline && sentinel.timelineFirst && last) timeline = [[sentinel.timelineFirst, last]];
      flags = { fence_trust: sentinel.truthWalk.trust(), timeline_fence_trust: sentinel.timelineWalk.trust(), timeline_split: 'sentinel' };
    } else if (this.bare && first) {
      const bare = this.bare;
      truth = bare.end && last && last.line >= bare.end.line
        ? [[first, { byte: bare.line.start, line: bare.line.index }], [bare.end, last]]
        : [[first, bare.truthEnd!]];
      timeline = [[bare.line.contentStart!, bare.timelineEnd]];
      flags = { fence_trust: bare.truthWalk.trust(), timeline_fence_trust: bare.timelineWalk.trust(), timeline_split: 'bare_section' };
    } else {
      if (first && last) truth = [[first, last]];
      flags = { fence_trust: this.allWalk.trust(), timeline_fence_trust: 'trusted', timeline_split: 'none' };
    }
    const bytes = (ranges: Array<[Pos, Pos]>) => ranges.reduce((n, [a, b]) => n + b.byte - a.byte, 0);
    const newlines = (ranges: Array<[Pos, Pos]>) => ranges.reduce((n, [a, b]) => n + b.line - a.line, 0);
    const truthBytes = bytes(truth);
    const timelineBytes = bytes(timeline);
    const head = this.head;
    if (this.opts?.validate && this.firstNulLine !== null && !head.errors.some(error => error.code === 'NULL_BYTES')) {
      head.errors.unshift(nullBytesError(this.firstNulLine));
    }
    const bodyTitle = this.bodyTitle;
    const embeddedTitle = this.embedded.title;
    return {
      kind: 'ok',
      parsed: {
        frontmatter: comparableFrontmatter(head.frontmatter),
        ...parsedMarkdownFields(head, () => bodyTitle || embeddedTitle, this.filePath, this.opts),
      },
      truth: this.pieces(truth),
      timeline: this.pieces(timeline),
      truthBytes,
      timelineBytes,
      bodyLines: truthBytes + timelineBytes === 0 ? 0 : newlines(truth) + newlines(timeline) + 1,
      totalBytes: this.totalBytes,
      bodyFlags: { ...flags, has_nul: this.hasNul },
    };
  }

  /** Virtual ranges as file ranges, with any part inside the literal piece as text. */
  private pieces(ranges: Array<[Pos, Pos]>): BodyPiece[] {
    const out: BodyPiece[] = [];
    const literal = this.literalBytes > 0 ? Buffer.from(this.head.body, 'utf8') : null;
    for (const [a, b] of ranges) {
      if (literal && a.byte < this.literalBytes) {
        out.push({ text: literal.subarray(a.byte, Math.min(b.byte, this.literalBytes)).toString('utf8') });
        if (b.byte > this.literalBytes) out.push({ start: this.bodyFileStart, end: this.fileOffset(b.byte) });
      } else {
        out.push({ start: this.fileOffset(a.byte), end: this.fileOffset(b.byte) });
      }
    }
    return out;
  }
}

/**
 * The pre-quote pass's view of fence lines when its fence did not close in the
 * head: whether closing it on the next line would change any line so far.
 * Every line keeps its CR except the one just before the closing `---`, which
 * the pass rebuilds without its CR (and then may rewrite). `rewrites` is
 * `quoteAmbiguousFrontmatterLine(line) !== null`.
 */
function watchQuoteLine(watch: QuoteWatch, rewrites: boolean, endsCr: boolean): void {
  watch.anyBefore ||= watch.prev;
  watch.prev = rewrites;
  watch.prevChanged = endsCr || rewrites;
}

/** Pass 1 over a streamed file. */
export async function scanMarkdownBody(source: AsyncIterable<Uint8Array>, filePath?: string, opts?: ParseOpts): Promise<BodyScanResult> {
  const scanner = new BodyScanner(filePath, opts);
  for await (const chunk of source) scanner.push(chunk);
  return scanner.finish();
}

/** The text of `pieces` read from the file bytes. */
export function readBodyPieces(pieces: readonly BodyPiece[], file: Uint8Array): string {
  return pieces.map(piece => 'text' in piece ? piece.text : Buffer.from(file.buffer, file.byteOffset + piece.start, piece.end - piece.start).toString('utf8')).join('');
}

/** String form: the scan plus both regions read back as text (tests and the in-memory `put_page` path). */
export function scanMarkdownString(content: string, filePath?: string, opts?: ParseOpts, lineBufferBytes?: number):
  (BodyScan & { text: { compiled_truth: string; timeline: string } }) | BodyScanRefusal {
  const bytes = Buffer.from(content, 'utf8');
  const scanner = new BodyScanner(filePath, opts, lineBufferBytes);
  scanner.push(bytes);
  const scan = scanner.finish();
  if (scan.kind !== 'ok') return scan;
  return { ...scan, text: { compiled_truth: readBodyPieces(scan.truth, bytes), timeline: readBodyPieces(scan.timeline, bytes) } };
}
