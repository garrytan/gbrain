/**
 * Segmented page storage (Wave B): cut one region of a page's stored stream
 * (`compiled_truth`, then `timeline`, each already sanitized) into segments
 * of at most SEGMENT_MAX_BYTES, spec section 2.
 *
 * A cut goes before a line and looks only backward (bytes since the last cut,
 * the line itself, carried parser state), so segmentation is append-stable:
 * appending text changes only the last segment, and segmenting from a
 * segment's entry state over its bytes plus appended bytes reproduces a full
 * run's cuts. Candidates, best first: a level 1-2 ATX heading or a day header,
 * a message anchor of the page's conversation pattern, then a level 3+
 * heading or the first line after a blank line. No structural cut before
 * SEGMENT_MIN_BYTES; between min and target only a rank 1-3 candidate whose
 * gear hash has its top GEAR_TOP_BITS bits clear; from target the first rank
 * 1-3 candidate; from SEGMENT_RANK4_BYTES any candidate. A line that would not
 * fit forces a cut before it, and a line longer than a segment is cut at the
 * last code point that fits (never between `\r` and `\n`), with the open
 * state carried in the next entry state.
 *
 * Never cut: inside a code fence, a protected region under either fence
 * trust, a withdrawal fence block, a timeline entry's detail run, between a
 * materialized marker and its bullet, or within PEM_CONTEXT_CHARS after a
 * `PRIVATE KEY-----` in either trust's projection; and never before a line
 * holding a marker token, a key fence, or text a key's body could continue
 * through. Under those rules no private-key claim, protected region or fence
 * block crosses a non-forced cut.
 *
 * Each segment carries what its manifest row stores: protected regions,
 * facts slots and private-key spans in segment-relative raw bytes (full
 * extent in stored-stream bytes as `open_start`/`open_end` when one crosses
 * the segment's bounds), and its static projection's size, lines, outline and
 * dates: the projection whole-body sanitization would give (takes, facts,
 * materialized markers and a truncated tail out, private keys as a token),
 * with facts regions as zero-length slots rendered at read time.
 */
import { createHash } from 'node:crypto';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import { PRIVATE_KEY_PROJECTION_TOKEN } from '../credential-projection.ts';
import { isMaterializedMarkerLine, materializedMarkerSpans } from '../timeline-marker.ts';
import { TIMELINE_LINE_RE, TIMELINE_LINE_RE_CN } from '../timeline-citations.ts';
import { TIMELINE_HEADING_RE } from '../link-extraction.ts';
import { DAY_HEADER_RE, matchAnchorLine } from '../conversation-parser/parse.ts';
import { clip, DATE, FENCE, HEADING, HEADING_MAX_CHARS } from '../page-window/window.ts';
import { SEGMENT_MAX_BYTES, SEGMENT_MIN_BYTES, SEGMENT_RANK4_BYTES, SEGMENT_TARGET_BYTES } from './limits.ts';
import type { BodyRegion, JsonObject, SegmentCutKind } from './types.ts';
import { cloneEntryState, type EntryState } from './entry-state.ts';
import {
  feedPemScan, findTokens, forcePemCut, initialPemScan, markPemCut, pemExposedFrom, newLineSplit, pemBodyLike, pemResolvedTo, PEM_CONTEXT_CHARS,
  PROTECTED_MARKERS, scanRegionLine, scanRegionPiece, splitLines, takePemCut, utf8Len,
  type Cover, type LineSplit, type PemScanState, type RegionTrack, type ScanOut, type SplitEvent,
} from './region-scan.ts';

/** Bump when a cut rule, a bound or the stored per-segment metadata changes. */
export const SEGMENTER_VERSION = 1;

/** Between min and target, a candidate cuts when the top bits of its line's gear hash are zero (1 in 1024 candidates). */
const GEAR_TOP_BITS = 10;
const OUTLINE_MAX_HEADINGS = 64;
/** Projection text is handed to the PEM scan in batches of this many chars (its buffer is re-read per feed). */
const PEM_FEED_CHARS = 64 * 1024;
/** Closed segments waiting on the PEM lookahead are held up to this many bytes, then released fail closed. */
const HOLD_MAX_BYTES = 2 * SEGMENT_MAX_BYTES;
const PEM_FENCE_TAIL = 'PRIVATE KEY-----';
const ATX_TOP = /^#{1,2}\s/;
const ATX_DEEP = /^#{3,6}\s/;
const ATX_ANY = /^#{1,6}\s/;
const PEM_HEADER_LINE = /^(?:Proc-Type:|DEK-Info:)/;
const MATERIALIZED_DETAIL = /^[ \t]+\S/;
const BULLET = /^[ \t]*[-*+] /;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const GEAR: Uint32Array = (() => {
  const table = new Uint32Array(256);
  let x = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    table[i] = x;
  }
  return table;
})();

/**
 * @internal Work the segmenter does, for the linearity tests: line and piece
 * events handled (`lines`); UTF-16 units the per-line passes read (`chars`:
 * cut-candidate classifiers and gear hash, cut blockers, line state, the
 * projection, a long piece's fit and remainder); bookkeeping entries visited
 * (`entries`: held segments, removals re-sorted, projection pieces copied,
 * PEM spans and region ends scanned at each emit, kept ranges); and units of
 * each emitted segment's raw and projected text read by its join, byte copy,
 * hash, projection parts, outline, dates and line count (`emitted`). The line
 * split, token search and PEM scan count in `regionScanWork`. Counts, not
 * time, so a busy machine cannot move them.
 */
export const segmenterWork = { lines: 0, chars: 0, entries: 0, emitted: 0 };

function gearHit(line: string): boolean {
  segmenterWork.chars += line.length;
  let h = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    h = ((h << 1) + GEAR[(c ^ (c >>> 8)) & 255]!) >>> 0;
  }
  return h >>> (32 - GEAR_TOP_BITS) === 0;
}

export interface SegmentOptions {
  /** Stored-stream byte offset and 0-based raw line of the entry point. */
  byteStart: number;
  lineStart: number;
  /** This region's whole-body fence trust (pass 1, or body_flags.fence_trust). */
  fenceTrust: 'trusted' | 'void';
  /** How the input ends: `region_end` for the truth when a timeline follows, else `eof`. */
  end: 'region_end' | 'eof';
}

/**
 * `pem_guard`: the end of a segment released before a private-key claim could
 * be ruled out over it (a protected region longer than the hold bound stalled
 * the projection), projected as nothing: never more visible than whole-body
 * sanitization, possibly less.
 */
export type StoredRegionKind = 'facts' | 'takes' | 'tail' | 'marker' | 'pem' | 'pem_guard';

/**
 * A protected run of a segment: segment-relative raw bytes; `open_*` give the
 * full extent in stored-stream bytes when it crosses the segment's bounds.
 * `open_end` is set only when the run ends by the segment's end; a run still
 * open there has none, and the segment holding its end carries both.
 */
export interface StoredRegion { kind: StoredRegionKind; start: number; end: number; open_start?: number; open_end?: number }

/** A facts region of a segment, rendered at read time where its zero-length slot sits in the static projection. */
export interface FactsSlot { proj_byte: number; start: number; end: number; open_start?: number; open_end?: number }

export interface OutlineHeading { proj_byte: number; level: number; text: string }

/** One segment as its manifest row and text row need it (see ManifestRowInput, SegmentTextInput). */
export interface SegmentOut {
  region: BodyRegion;
  bytes: Uint8Array;
  sha256: Uint8Array;
  byteStart: number;
  /** 0-based raw line of the first line; `lineCount` counts `\n` bytes. */
  lineStart: number;
  lineCount: number;
  /** Why the segment ends. */
  cutKind: SegmentCutKind;
  entryState: EntryState;
  exitState: EntryState;
  /** The fence trust `protectedRegions` were computed under (body_flags.fence_trust at segmentation). */
  fenceTrust: 'trusted' | 'void';
  protectedRegions: StoredRegion[];
  factsSlots: FactsSlot[];
  staticProjBytes: number;
  /** `\n` bytes in the static projection. */
  staticProjLines: number;
  outline: OutlineHeading[];
  dateMin: string | null;
  dateMax: string | null;
}

/** Page flags only the region's end decides (body_flags). */
export interface RegionFlags {
  /** Stored byte where a truncated protected tail starts, under the page's trust. */
  protectedTailFrom: number | null;
  /** The trust the region's fence walk observed: differs from the trust used when an append flipped it (rescan). */
  observedFenceTrust: 'trusted' | 'void';
}

/** The whole-region fence trust a region's stored regions are computed under (body_flags). */
export function regionTrust(flags: JsonObject | null | undefined, region: BodyRegion): 'trusted' | 'void' {
  return (region === 'truth' ? flags?.fence_trust : flags?.timeline_fence_trust) === 'void' ? 'void' : 'trusted';
}

export function regionFlags(exit: EntryState, fenceTrust: 'trusted' | 'void'): RegionFlags {
  const track = fenceTrust === 'trusted' ? exit.trusted : exit.untrusted;
  const walk = exit.trusted.walk;
  return { protectedTailFrom: track.truncatedAt, observedFenceTrust: !walk.fence && !walk.mispaired ? 'trusted' : 'void' };
}

interface Removal { start: number; end: number; kind: Exclude<StoredRegionKind, 'pem'>; regionStart: number }

interface OpenSegment {
  entry: EntryState;
  byteStart: number;
  lineStart: number;
  bytes: number;
  lines: number;
  parts: string[];
  removals: Removal[];
  projStart: number;
}

interface ClosedSegment extends OpenSegment {
  cutKind: SegmentCutKind;
  exit: EntryState;
  projEnd: number;
  /** The truncated tail as known at the cut, so stored kinds never depend on when a segment is released. */
  tailFrom: number | null;
}

/**
 * Incremental segmenter for one region: push text, take the segments that are
 * final. A closed segment waits until no private-key claim can still start
 * before its end; at a cut, segments held past HOLD_MAX_BYTES are released
 * with a `pem_guard` over what a later claim could still cover. Memory is
 * O(HOLD_MAX_BYTES + segment + PEM_CONTEXT_CHARS). Release decisions are made
 * at cuts, where the PEM scan has read exactly the projection before the cut,
 * so the output does not depend on how the input is pushed.
 */
export class Segmenter {
  private readonly st: EntryState;
  private readonly split: LineSplit;
  private readonly pem: PemScanState;
  private proj = 0;
  private projPieces: Array<{ proj: number; raw: number; text: string }> = [];
  private pemPending = '';
  private pemSpans: Array<{ start: number; end: number }> = [];
  private regionEnds = new Map<number, number>();
  private cur: OpenSegment;
  private closed: ClosedSegment[] = [];
  private ready: SegmentOut[] = [];
  private outline: { fence: boolean; midLine: boolean };
  private done = false;

  constructor(entry: EntryState, private readonly opts: SegmentOptions) {
    this.st = cloneEntryState(entry);
    this.split = newLineSplit(opts.byteStart, entry.at);
    this.pem = initialPemScan(entry.pem.start);
    this.outline = { ...entry.outline };
    this.cur = this.openSegment(cloneEntryState(entry), opts.byteStart, opts.lineStart);
  }

  push(text: string): SegmentOut[] {
    splitLines(this.split, text, false, e => this.onEvent(e));
    return this.drain();
  }

  finish(): SegmentOut[] {
    splitLines(this.split, '', true, e => this.onEvent(e));
    for (const track of [this.st.trusted, this.st.untrusted]) {
      if (track.open) { track.truncatedAt = track.open.start; track.open = null; }
    }
    if (this.cur.bytes > 0) markPemCut(this.pem, this.proj);
    this.feedPem(true);
    this.done = true;
    if (this.cur.bytes > 0) this.close(this.opts.end);
    return this.drain();
  }

  private actual(): RegionTrack {
    return this.opts.fenceTrust === 'trusted' ? this.st.trusted : this.st.untrusted;
  }

  private openSegment(entry: EntryState, byteStart: number, lineStart: number): OpenSegment {
    return { entry, byteStart, lineStart, bytes: 0, lines: 0, parts: [], removals: [], projStart: this.proj };
  }

  private close(cutKind: SegmentCutKind): void {
    const exit = cloneEntryState(this.st);
    this.closed.push({ ...this.cur, cutKind, exit, projEnd: this.proj, tailFrom: this.actual().truncatedAt });
    this.cur = this.openSegment(exit, this.cur.byteStart + this.cur.bytes, this.cur.lineStart + this.cur.lines);
    if (this.done) return;
    markPemCut(this.pem, this.proj);
    this.feedPem(false);
    this.release();
    segmenterWork.entries += this.closed.length;
    let held = this.closed.reduce((n, seg) => n + seg.bytes, 0);
    while (held > HOLD_MAX_BYTES) {
      segmenterWork.entries += this.closed.length;
      const seg = this.closed.shift()!;
      held -= seg.bytes;
      seg.exit.pem = forcePemCut(this.pem, seg.projEnd);
      const exposed = pemExposedFrom(this.pem);
      const guardFrom = exposed >= seg.projEnd ? null : exposed <= seg.projStart || this.projPieces.length === 0 ? seg.byteStart : this.rawAt(exposed, false);
      this.ready.push(this.emit(seg, guardFrom));
    }
  }

  private onEvent(e: SplitEvent): void {
    segmenterWork.lines++;
    if (e.kind === 'line') {
      const bytes = utf8Len(e.text) + e.term.length;
      const kind = this.candidate(e.text, e.at);
      if (kind) this.close(kind);
      else if (this.cur.bytes > 0 && this.cur.bytes + bytes > SEGMENT_MAX_BYTES) this.close('forced');
      this.st.at = e.at;
      this.line(e.text, e.term, e.byteStart);
      return;
    }
    if (e.first && this.cur.bytes > 0) this.close('forced');
    let { text, byteStart } = e;
    for (;;) {
      const fit = fitChars(text, SEGMENT_MAX_BYTES - this.cur.bytes);
      if (fit.chars === text.length && this.cur.bytes + fit.bytes + (e.term ?? '').length <= SEGMENT_MAX_BYTES) {
        this.piece(text, byteStart, e.first && byteStart === e.byteStart, e.term);
        return;
      }
      if (fit.chars > 0) this.piece(text.slice(0, fit.chars), byteStart, e.first && byteStart === e.byteStart, null);
      byteStart += fit.bytes;
      text = text.slice(fit.chars);
      segmenterWork.chars += text.length;
      this.st.at = 'mid';
      this.close('forced');
    }
  }

  /** The cut kind when a structural cut goes before this whole line. */
  private candidate(text: string, at: SplitEvent['at']): SegmentCutKind | null {
    const size = this.cur.bytes;
    if (at !== 'lf' || size < SEGMENT_MIN_BYTES) return null;
    segmenterWork.chars += text.length;
    const st = this.st;
    let kind: SegmentCutKind | null = null;
    let rank = 4;
    if (DAY_HEADER_RE.test(text.trim())) { kind = 'day'; rank = 2; }
    else if (ATX_TOP.test(text)) { kind = 'heading'; rank = 2; }
    else if (st.conversation.pattern && matchAnchorLine(st.conversation.pattern, text)) { kind = 'message'; rank = 3; }
    else if (ATX_DEEP.test(text)) kind = 'heading';
    else if (st.prevBlank && text.trim() !== '') kind = 'blank';
    if (!kind || this.blocked(text)) return null;
    if (size < SEGMENT_TARGET_BYTES) return rank <= 3 && gearHit(text) ? kind : null;
    return rank <= 3 || size >= SEGMENT_RANK4_BYTES ? kind : null;
  }

  private blocked(text: string): boolean {
    segmenterWork.chars += text.length;
    return cutBlocked(this.st, text);
  }

  private line(text: string, term: string, byteStart: number): void {
    const st = this.st;
    const outT: ScanOut = { regions: [], covers: [], coverTerm: false };
    const outU: ScanOut = { regions: [], covers: [], coverTerm: false };
    scanRegionLine(st.trusted, true, text, byteStart, term, outT);
    scanRegionLine(st.untrusted, false, text, byteStart, term, outU);
    const whole = text + term;
    segmenterWork.chars += whole.length;
    const markers = whole.includes('gbrain:materialized') ? materializedMarkerSpans(whole) : [];
    this.project(whole, text.length, byteStart, outT, outU, markers);
    const b = text.lastIndexOf(FACTS_FENCE_BEGIN);
    const e = text.lastIndexOf(FACTS_FENCE_END);
    if (b !== -1 || e !== -1) st.withdrawal.open = b > e;
    st.timeline = timelineNext(st.timeline, text);
    st.marker = isMaterializedMarkerLine(text) ? 'after_marker'
      : st.marker === 'after_marker' || (st.marker === 'details' && MATERIALIZED_DETAIL.test(text) && !BULLET.test(text)) ? 'details' : 'none';
    st.prevBlank = text.trim() === '';
    const day = DAY_HEADER_RE.exec(text.trim());
    if (day) st.conversation.fallbackDate = day[1]!;
    else if (st.conversation.pattern) {
      const anchor = matchAnchorLine(st.conversation.pattern, text);
      if (anchor) {
        st.conversation.open = true;
        st.conversation.lastDate = anchor.date && ISO_DATE.test(anchor.date) ? anchor.date : st.conversation.fallbackDate;
      }
    }
    this.append(whole, term.includes('\n') ? 1 : 0);
  }

  private piece(text: string, byteStart: number, first: boolean, term: string | null): void {
    const st = this.st;
    const outT: ScanOut = { regions: [], covers: [], coverTerm: false };
    const outU: ScanOut = { regions: [], covers: [], coverTerm: false };
    scanRegionPiece(st.trusted, true, text, byteStart, first, term, outT);
    scanRegionPiece(st.untrusted, false, text, byteStart, first, term, outU);
    const whole = text + (term ?? '');
    segmenterWork.chars += whole.length;
    this.project(whole, text.length, byteStart, outT, outU, []);
    let last = -1;
    st.withdrawal.carry = findTokens(st.withdrawal.carry, text, [FACTS_FENCE_BEGIN, FACTS_FENCE_END], t => { last = t; });
    if (last !== -1) st.withdrawal.open = last === 0;
    if (term !== null) {
      st.withdrawal.carry = '';
      st.timeline = { entry: 'none', heading: false };
      st.marker = 'none';
      st.prevBlank = false;
    }
    this.append(whole, term?.includes('\n') ? 1 : 0);
  }

  private append(whole: string, lines: number): void {
    this.cur.parts.push(whole);
    this.cur.bytes += utf8Len(whole);
    this.cur.lines += lines;
  }

  /**
   * The projection of one line or piece under each trust: PEM margins for
   * both, and for the page's trust the removals, the PEM scan feed and the
   * offsets that map PEM spans back to stored bytes.
   */
  private project(whole: string, textLen: number, byteStart: number, outT: ScanOut, outU: ScanOut,
    markers: Array<[number, number]>): void {
    const st = this.st;
    const trusted = this.opts.fenceTrust === 'trusted';
    for (const [out, track, isTrusted] of [[outT, st.trusted, true], [outU, st.untrusted, false]] as const) {
      const plain = out.covers.length === 0 && markers.length === 0;
      const keep = plain ? (whole.length ? [[0, whole.length] as [number, number]] : []) : keptRanges(whole, textLen, out, markers);
      const projected = plain ? whole : keep.map(([a, b]) => whole.slice(a, b)).join('');
      segmenterWork.chars += projected.length;
      segmenterWork.entries += keep.length;
      const carryKey = isTrusted ? 'carryTrusted' : 'carryUntrusted';
      const marginKey = isTrusted ? 'trusted' : 'untrusted';
      let found = -1;
      const lead = st.pemMargin[carryKey].length;
      st.pemMargin[carryKey] = findTokens(st.pemMargin[carryKey], projected, [PEM_FENCE_TAIL], (_t, at) => { found = at + PEM_FENCE_TAIL.length - lead; });
      let margin = found !== -1 ? projected.length - found : st.pemMargin[marginKey] === null ? null : st.pemMargin[marginKey]! + projected.length;
      if (track.truncatedAt !== null || (margin !== null && margin > PEM_CONTEXT_CHARS)) margin = null;
      st.pemMargin[marginKey] = margin;
      if (isTrusted !== trusted) continue;
      for (const r of out.regions) this.regionEnds.set(r.start, r.end);
      if (!plain) this.recordRemovals(whole, textLen, byteStart, out, markers);
      let byte = byteStart;
      let char = 0;
      for (const [a, b] of keep) {
        byte += utf8Len(whole, char, a);
        this.projPieces.push({ proj: this.proj, raw: byte, text: plain ? whole : whole.slice(a, b) });
        this.proj += b - a;
        if (!plain) byte += utf8Len(whole, a, b);
        char = b;
      }
      this.pemPending += projected;
      if (track.truncatedAt !== null) this.feedPem(true);
      else if (this.pemPending.length >= PEM_FEED_CHARS) this.feedPem(false);
    }
  }

  private recordRemovals(whole: string, textLen: number, byteStart: number, out: ScanOut, markers: Array<[number, number]>): void {
    const at = (i: number) => byteStart + utf8Len(whole, 0, i);
    const add = (r: Removal) => {
      const prev = this.cur.removals[this.cur.removals.length - 1];
      if (prev && prev.end === r.start && prev.kind === r.kind && prev.regionStart === r.regionStart) prev.end = r.end;
      else this.cur.removals.push(r);
    };
    const covers: Cover[] = out.covers.map(c => ({ ...c, to: c.to === textLen && out.coverTerm ? whole.length : c.to }));
    segmenterWork.entries += covers.length + markers.length * (covers.length + 1);
    for (const [a, b] of markers) if (!covers.some(c => a < c.to && c.from < b)) add({ start: at(a), end: at(b), kind: 'marker', regionStart: at(a) });
    for (const c of covers) add({ start: at(c.from), end: at(c.to), kind: c.pair === 0 ? 'facts' : c.pair === 1 ? 'takes' : 'tail', regionStart: c.start });
    segmenterWork.entries += this.cur.removals.length;
    this.cur.removals.sort((x, y) => x.start - y.start);
  }

  private feedPem(final: boolean): void {
    if (this.pem.final) return;
    const text = this.pemPending;
    this.pemPending = '';
    feedPemScan(this.pem, text, final, (s, e) => this.pemSpans.push({ start: this.rawAt(s, false), end: this.rawAt(e, true) }));
    const pieces = this.projPieces;
    const resolved = pemResolvedTo(this.pem);
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pieces[mid]!.proj + pieces[mid]!.text.length < resolved) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) {
      segmenterWork.entries += pieces.length - lo;
      this.projPieces = pieces.slice(lo);
    }
  }

  /** Stored byte of projection offset `pos` (`end`: the offset just past a char). */
  private rawAt(pos: number, end: boolean): number {
    const pieces = this.projPieces;
    let lo = 0;
    let hi = pieces.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const p = pieces[mid]!;
      if (end ? p.proj < pos : p.proj <= pos) lo = mid; else hi = mid - 1;
    }
    const p = pieces[lo]!;
    return p.raw + utf8Len(p.text, 0, pos - p.proj);
  }

  private drain(): SegmentOut[] {
    this.release();
    return this.ready.splice(0);
  }

  /** Emit the held segments no private-key claim can still reach, in order. */
  private release(): void {
    while (this.closed.length) {
      const seg = this.closed[0]!;
      let pem = takePemCut(this.pem, seg.projEnd);
      if (!pem && this.done) pem = { clean: false, start: seg.exit.pem.start };
      if (!pem || (!this.done && pemResolvedTo(this.pem) < seg.projEnd)) break;
      this.closed.shift();
      seg.exit.pem = pem;
      this.ready.push(this.emit(seg, null));
    }
  }

  private emit(seg: ClosedSegment, guardFrom: number | null): SegmentOut {
    const raw = seg.parts.join('');
    const bytes = Buffer.from(raw, 'utf8');
    segmenterWork.emitted += raw.length + 2 * bytes.length;
    segmenterWork.entries += seg.removals.length + 2 * this.pemSpans.length + this.regionEnds.size;
    const segEnd = seg.byteStart + seg.bytes;
    const tailFrom = seg.tailFrom;
    const regions: StoredRegion[] = [];
    for (const r of seg.removals) {
      const kind = tailFrom !== null && r.kind !== 'marker' && r.regionStart >= tailFrom ? 'tail' : r.kind;
      const region: StoredRegion = { kind, start: r.start - seg.byteStart, end: r.end - seg.byteStart };
      if (kind !== 'marker') {
        const known = kind === 'tail' ? undefined : this.regionEnds.get(r.regionStart);
        const regionEnd = known !== undefined && known <= segEnd ? known : undefined;
        if (r.regionStart < seg.byteStart || regionEnd === undefined) {
          region.open_start = r.regionStart;
          if (regionEnd !== undefined) region.open_end = regionEnd;
          else if (kind === 'tail' && seg.cutKind === this.opts.end && this.done) region.open_end = segEnd;
        }
      }
      regions.push(region);
    }
    for (const s of this.pemSpans) {
      if (s.end <= seg.byteStart || s.start >= segEnd) continue;
      const region: StoredRegion = { kind: 'pem', start: Math.max(s.start, seg.byteStart) - seg.byteStart, end: Math.min(s.end, segEnd) - seg.byteStart };
      if (s.start < seg.byteStart || s.end > segEnd) { region.open_start = s.start; region.open_end = s.end; }
      regions.push(region);
    }
    if (guardFrom !== null && guardFrom < segEnd) regions.push({ kind: 'pem_guard', start: guardFrom - seg.byteStart, end: seg.bytes });
    this.pemSpans = this.pemSpans.filter(s => s.end > segEnd);
    for (const [start, end] of this.regionEnds) if (end <= segEnd) this.regionEnds.delete(start);
    regions.sort((a, b) => a.start - b.start || b.end - a.end);
    segmenterWork.entries += regions.length;
    const parts = segmentProjectionParts(raw, regions, seg.byteStart);
    let projected = '';
    let projBytes = 0;
    const factsSlots: FactsSlot[] = [];
    for (const p of parts) {
      if (p.kind === 'facts') factsSlots.push({ proj_byte: projBytes, start: p.region!.start, end: p.region!.end,
        ...(p.region!.open_start !== undefined ? { open_start: p.region!.open_start } : {}),
        ...(p.region!.open_end !== undefined ? { open_end: p.region!.open_end } : {}) });
      if (p.kind === 'text' || p.kind === 'pem') { projected += p.text; projBytes += utf8Len(p.text); }
    }
    segmenterWork.emitted += 2 * projected.length;
    const { outline, dateMin, dateMax } = this.outlineOf(projected);
    seg.exit.outline = { ...this.outline };
    let projLines = 0;
    for (let i = projected.indexOf('\n'); i !== -1; i = projected.indexOf('\n', i + 1)) projLines++;
    return {
      region: seg.entry.region,
      bytes,
      sha256: createHash('sha256').update(bytes).digest(),
      byteStart: seg.byteStart,
      lineStart: seg.lineStart,
      lineCount: seg.lines,
      cutKind: seg.cutKind,
      entryState: seg.entry,
      exitState: seg.exit,
      fenceTrust: this.opts.fenceTrust,
      protectedRegions: regions,
      factsSlots,
      staticProjBytes: projBytes,
      staticProjLines: projLines,
      outline,
      dateMin,
      dateMax,
    };
  }

  /** pageOutline's heading and date reading over one segment's static projection, carrying its fence toggle. */
  private outlineOf(text: string): { outline: OutlineHeading[]; dateMin: string | null; dateMax: string | null } {
    const outline: OutlineHeading[] = [];
    let at = 0;
    let byte = 0;
    let skip = this.outline.midLine;
    while (at < text.length) {
      const nl = text.indexOf('\n', at);
      const end = nl === -1 ? text.length : nl;
      if (!skip) {
        const line = text.slice(at, end);
        if (FENCE.test(line)) this.outline.fence = !this.outline.fence;
        else if (!this.outline.fence && outline.length < OUTLINE_MAX_HEADINGS) {
          const h = HEADING.exec(line);
          if (h) outline.push({ proj_byte: byte, level: h[1]!.length, text: detached(clip(h[2]!, HEADING_MAX_CHARS)) });
        }
      }
      skip = false;
      const next = nl === -1 ? text.length : nl + 1;
      segmenterWork.emitted += next - at;
      byte += utf8Len(text, at, next);
      at = next;
    }
    if (text.length) this.outline.midLine = !text.endsWith('\n');
    let dateMin: string | null = null;
    let dateMax: string | null = null;
    for (const m of text.matchAll(DATE)) {
      if (dateMin === null || m[0] < dateMin) dateMin = m[0];
      if (dateMax === null || m[0] > dateMax) dateMax = m[0];
    }
    return { outline, dateMin: dateMin && detached(dateMin), dateMax: dateMax && detached(dateMax) };
  }
}

/**
 * A copy of `slice` that does not share the string it was cut from. A substring (slice, regex match) keeps its whole
 * parent alive, and segment metadata outlives the segment: a write holds every manifest row until it publishes, so an
 * outline heading cut from a segment's projection would pin that projection, the whole body across all rows.
 */
function detached(slice: string): string {
  return Buffer.from(slice, 'utf8').toString('utf8');
}

/** The longest prefix of `text` whose UTF-8 bytes fit in `room` (chars and bytes), never splitting a surrogate pair. */
function fitChars(text: string, room: number): { chars: number; bytes: number } {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const d = c >= 0xd800 && c <= 0xdbff ? text.charCodeAt(i + 1) : 0;
    const pair = d >= 0xdc00 && d <= 0xdfff;
    const n = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + n > room) {
      segmenterWork.chars += i;
      return { chars: i, bytes };
    }
    bytes += n;
    if (pair) i++;
  }
  segmenterWork.chars += text.length;
  return { chars: text.length, bytes };
}

/** The kept (projected) ranges of `whole` (a line or piece plus its terminator): covers and marker spans out. */
function keptRanges(whole: string, textLen: number, out: ScanOut, markers: Array<[number, number]>): Array<[number, number]> {
  const cut: Array<[number, number]> = out.covers.map(c => [c.from, c.to === textLen && out.coverTerm ? whole.length : c.to]);
  for (const m of markers) cut.push(m);
  if (cut.length === 0) return whole.length ? [[0, whole.length]] : [];
  cut.sort((a, b) => a[0] - b[0]);
  const keep: Array<[number, number]> = [];
  let at = 0;
  for (const [a, b] of cut) {
    if (a > at) keep.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < whole.length) keep.push([at, whole.length]);
  return keep;
}

/** parseTimelineEntries' rule: would it read `line` as part of the open entry (a detail, or a blank before any)? */
/**
 * Whether no cut may go before the whole line `text` at parser state `st` (a segment's entry state is the state at its
 * cut): inside a code fence, a protected region, a withdrawal fence block, a timeline entry's detail run, after a
 * materialized marker, within a private key's context, or before a line holding a marker token or key text.
 */
export function cutBlocked(st: EntryState, text: string): boolean {
  if (st.trusted.walk.fence || st.trusted.open || st.untrusted.open || st.withdrawal.open) return true;
  if (st.pemMargin.trusted !== null || st.pemMargin.untrusted !== null) return true;
  if (timelineConsumes(st.timeline, text)) return true;
  if (st.marker === 'after_marker' || (st.marker === 'details' && MATERIALIZED_DETAIL.test(text) && !BULLET.test(text))) return true;
  return PROTECTED_MARKERS.some(m => text.includes(m)) || text.includes(PEM_FENCE_TAIL) || isMaterializedMarkerLine(text)
    || pemBodyLike(text) || PEM_HEADER_LINE.test(text);
}

function timelineConsumes(state: EntryState['timeline'], line: string): boolean {
  if (state.entry === 'none') return false;
  if (TIMELINE_LINE_RE.test(line) || TIMELINE_HEADING_RE.test(line)) return false;
  if (ATX_ANY.test(line) || isMaterializedMarkerLine(line)) return false;
  if (line.trim().length === 0) return state.entry === 'entry';
  return state.heading || /^\s+/.test(line) || (!line.startsWith('-') && !line.startsWith('*') && !line.startsWith('#'));
}

function timelineNext(state: EntryState['timeline'], line: string): EntryState['timeline'] {
  if (timelineConsumes(state, line)) return { entry: line.trim().length === 0 ? state.entry : 'detail', heading: state.heading };
  if (TIMELINE_HEADING_RE.test(line)) return { entry: 'entry', heading: true };
  if (TIMELINE_LINE_RE.test(line) || TIMELINE_LINE_RE_CN.test(line)) return { entry: 'entry', heading: false };
  return { entry: 'none', heading: false };
}

export interface ProjectionPart {
  kind: 'text' | 'pem' | 'facts' | 'removed';
  /** Segment-relative raw bytes. */
  start: number;
  end: number;
  /** Projected text (text and pem parts), or the raw region text (facts parts). */
  text: string;
  region?: StoredRegion;
}

/**
 * A segment's static projection in parts, from its raw text and stored
 * regions: text kept, takes / tail / marker / pem_guard runs removed (a
 * removal that overlaps an earlier part removes its remainder), facts runs as
 * slots (`text` holds the raw fence for read-time rendering), and each
 * private-key span as the projection token (in the segment where the span
 * starts) plus the newlines of its projected text. `byteStart` is the
 * segment's stored-stream offset.
 */
export function segmentProjectionParts(raw: string, regions: readonly StoredRegion[], byteStart: number): ProjectionPart[] {
  const sorted = [...regions].sort((a, b) => a.start - b.start || b.end - a.end);
  segmenterWork.entries += sorted.length;
  const charAt = byteToChar(raw, sorted.flatMap(r => [r.start, r.end]));
  const parts: ProjectionPart[] = [];
  let cursor = 0;
  const text = (to: number) => {
    if (to > cursor) {
      const part = raw.slice(charAt.get(cursor)!, charAt.get(to)!);
      segmenterWork.emitted += part.length;
      parts.push({ kind: 'text', start: cursor, end: to, text: part });
    }
  };
  charAt.set(0, 0);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (r.end <= cursor) continue;
    if (r.start < cursor) {
      if (r.kind === 'facts' || r.kind === 'pem') continue;
      parts.push({ kind: 'removed', start: cursor, end: r.end, text: '', region: r });
      cursor = r.end;
      continue;
    }
    text(r.start);
    const from = charAt.get(r.start)!;
    const to = charAt.get(r.end)!;
    if (r.kind === 'pem') {
      let newlines = 0;
      let k = from;
      for (let j = i + 1; j < sorted.length && sorted[j]!.start < r.end; j++) {
        segmenterWork.entries++;
        const inner = sorted[j]!;
        newlines += countNewlines(raw, k, charAt.get(inner.start)!);
        k = Math.max(k, charAt.get(inner.end)!);
      }
      newlines += countNewlines(raw, k, to);
      const token = !(r.start === 0 && r.open_start !== undefined && r.open_start < byteStart);
      parts.push({ kind: 'pem', start: r.start, end: r.end, text: (token ? PRIVATE_KEY_PROJECTION_TOKEN : '') + '\n'.repeat(newlines), region: r });
    } else {
      parts.push({ kind: r.kind === 'facts' ? 'facts' : 'removed', start: r.start, end: r.end, text: r.kind === 'facts' ? raw.slice(from, to) : '', region: r });
    }
    cursor = r.end;
  }
  const rawBytes = utf8Len(raw);
  if (!charAt.has(rawBytes)) charAt.set(rawBytes, raw.length);
  text(rawBytes);
  return parts;
}

function countNewlines(s: string, from: number, to: number): number {
  segmenterWork.emitted += Math.max(0, to - from);
  let n = 0;
  for (let i = s.indexOf('\n', from); i !== -1 && i < to; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/** UTF-16 index of each UTF-8 byte offset of `s` (offsets fall on code points). */
function byteToChar(s: string, offsets: readonly number[]): Map<number, number> {
  const want = [...new Set([...offsets, utf8Len(s)])].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let bytes = 0;
  let i = 0;
  for (const target of want) {
    while (bytes < target && i < s.length) {
      const c = s.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { bytes += 4; i++; }
      else bytes += 3;
      i++;
    }
    out.set(target, i);
  }
  segmenterWork.emitted += i;
  return out;
}

/** Segment a stream of one region's stored bytes (valid UTF-8; invalid input throws). */
export async function* segmentStream(input: AsyncIterable<Uint8Array>, entry: EntryState, opts: SegmentOptions): AsyncIterable<SegmentOut> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const segmenter = new Segmenter(entry, opts);
  for await (const chunk of input) yield* segmenter.push(decoder.decode(chunk, { stream: true }));
  segmenter.push(decoder.decode());
  yield* segmenter.finish();
}

/** Segment one region held as a string (tests and the in-memory put path). */
export function segmentString(text: string, entry: EntryState, opts: SegmentOptions): SegmentOut[] {
  const segmenter = new Segmenter(entry, opts);
  return [...segmenter.push(text), ...segmenter.finish()];
}
