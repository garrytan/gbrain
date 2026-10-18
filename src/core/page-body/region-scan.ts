/**
 * Segmented page storage (Wave B): streaming forms of the two whole-body
 * privacy scans, so a page body is scanned once, in pieces, with every piece
 * of parser state small and JSON-safe.
 *
 * - `protectedRegionScan` is `protectedRegions` (fence-scan.ts) over a stream:
 *   the same marker tokens, the same pairing, the same truncated tail, the same
 *   `read` rule. `read` depends on whole-body fence trust, so trust is an input
 *   (pass 1 knows it at EOF) and the observed fence walk is part of the state:
 *   a caller that resumes with stale trust can see it flip and rescan.
 * - `feedPemScan` is `privateKeySpans` (secret-scan.ts) over a stream, with a
 *   bounded window: a BEGIN fence waits for PEM_CONTEXT_CHARS of lookahead,
 *   an END fence walks back at most that far, never below the floor.
 *
 * Lines end at `\n`, `\r\n` or a bare `\r` (scanMarkdownCode's grammar). A line
 * whose bytes with its terminator exceed SEGMENT_MAX_BYTES is the only line a
 * segment cut can split; it is scanned in pieces, its fence line judged by a
 * streaming probe, and its marker tokens read fail closed: inline code is not
 * computed on such a line, so a begin there counts as reader-visible and an end
 * there never closes a reader-visible region early (both hide more, never less).
 *
 * Coordinates: protected regions are UTF-8 byte offsets of the stored stream;
 * PEM spans are UTF-16 offsets of the projection stream the caller feeds.
 */
import { inlineCodeSpans } from '../fence-scan.ts';
import { PROTECTED_PAIRS } from '../remote-body.ts';
import { PEM_BEGIN_RE, PEM_BODY_MAX_CHARS, PEM_END_RE, pemBackwardStart, pemForwardEnd } from '../secret-scan.ts';
import { SEGMENT_MAX_BYTES } from './limits.ts';

/**
 * @internal Work the scans do, for the linearity tests: UTF-16 units the line
 * split, token search, fence probe, byte counting and inline-code scan read
 * (`chars`); projection units the PEM scan appends, searches, walks back over,
 * claims and copies when it trims its buffer (`pem`); and PEM bookkeeping
 * entries visited (`entries`: pending cuts, claims, fences, read-aheads).
 * Counts, not time, so a busy machine cannot move them.
 */
export const regionScanWork = { chars: 0, pem: 0, entries: 0 };

/** UTF-8 byte length of `s.slice(from, to)` without slicing. */
export function utf8Len(s: string, from = 0, to = s.length): number {
  regionScanWork.chars += to - from;
  if (from === 0 && to === s.length && to > 64) return Buffer.byteLength(s, 'utf8');
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < to) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Line splitting shared by the region scan and the segmenter.
// ---------------------------------------------------------------------------

/** Where the next input byte sits relative to lines: after a `\n`, after a bare `\r`, or inside a long line. */
export type LinePosition = 'lf' | 'cr' | 'mid';

export interface LineSplit {
  /** Stored-stream byte offset of the next unsplit byte. */
  pos: number;
  /** Text of the current line so far (lines that may still fit in a segment). */
  pending: string;
  pendingBytes: number;
  /** The input so far ends in a `\r` whose `\n` may follow. */
  cr: boolean;
  /** The current line is too long for one segment and is being emitted in pieces. */
  long: boolean;
  at: LinePosition;
}

export type SplitEvent =
  /** A whole line of at most SEGMENT_MAX_BYTES bytes, terminator included. `term` is '' at end of input. */
  | { kind: 'line'; text: string; byteStart: number; term: string; at: LinePosition }
  /** A piece of a longer line; `term` is null until the piece that ends it. */
  | { kind: 'piece'; text: string; byteStart: number; first: boolean; term: string | null; at: LinePosition };

export function newLineSplit(pos: number, at: LinePosition): LineSplit {
  return { pos, pending: '', pendingBytes: 0, cr: false, long: at === 'mid', at };
}

/** Split `chunk` into lines and long-line pieces, in order; `final` flushes the last line. */
export function splitLines(split: LineSplit, chunk: string, final: boolean, emit: (e: SplitEvent) => void): void {
  regionScanWork.chars += chunk.length;
  let i = 0;
  if (split.cr) {
    if (chunk.length === 0 && !final) return;
    split.cr = false;
    const term = chunk.charCodeAt(0) === 10 ? '\r\n' : '\r';
    endLine(split, '', term, emit);
    i = term.length - 1;
  }
  let nl = chunk.indexOf('\n', i);
  let cr = chunk.indexOf('\r', i);
  while (i < chunk.length) {
    if (nl !== -1 && nl < i) nl = chunk.indexOf('\n', i);
    if (cr !== -1 && cr < i) cr = chunk.indexOf('\r', i);
    const e = nl === -1 ? cr : cr === -1 ? nl : Math.min(nl, cr);
    if (e === -1) { addText(split, chunk.slice(i), emit); i = chunk.length; break; }
    const content = chunk.slice(i, e);
    if (chunk.charCodeAt(e) === 13 && e + 1 === chunk.length && !final) {
      addText(split, content, emit);
      split.cr = true;
      return;
    }
    const term = chunk.charCodeAt(e) === 13 && chunk.charCodeAt(e + 1) !== 10 ? '\r' : chunk.charCodeAt(e) === 13 ? '\r\n' : '\n';
    endLine(split, content, term, emit);
    i = e + term.length;
  }
  if (final && (split.pending || split.long || split.cr)) endLine(split, '', split.cr ? '\r' : '', emit);
}

function addText(split: LineSplit, text: string, emit: (e: SplitEvent) => void): void {
  if (!text) return;
  if (split.long) {
    emit({ kind: 'piece', text, byteStart: split.pos, first: false, term: null, at: split.at });
    split.pos += utf8Len(text);
    return;
  }
  split.pending += text;
  split.pendingBytes += utf8Len(text);
  if (split.pendingBytes < SEGMENT_MAX_BYTES) return;
  emit({ kind: 'piece', text: split.pending, byteStart: split.pos, first: true, term: null, at: split.at });
  split.pos += split.pendingBytes;
  split.pending = '';
  split.pendingBytes = 0;
  split.long = true;
}

function endLine(split: LineSplit, content: string, term: string, emit: (e: SplitEvent) => void): void {
  const termBytes = term.length;
  if (split.long) {
    emit({ kind: 'piece', text: content, byteStart: split.pos, first: false, term, at: split.at });
    split.pos += utf8Len(content) + termBytes;
  } else {
    regionScanWork.chars += split.pending.length;
    const text = split.pending + content;
    const bytes = split.pendingBytes + utf8Len(content);
    if (bytes + termBytes > SEGMENT_MAX_BYTES) emit({ kind: 'piece', text, byteStart: split.pos, first: true, term, at: split.at });
    else emit({ kind: 'line', text, byteStart: split.pos, term, at: split.at });
    split.pos += bytes + termBytes;
  }
  split.pending = '';
  split.pendingBytes = 0;
  split.long = false;
  split.at = term === '\r' ? 'cr' : 'lf';
}

// ---------------------------------------------------------------------------
// Literal tokens across piece boundaries.
// ---------------------------------------------------------------------------

/**
 * Find `tokens` in `carry + text`, earliest first and non-overlapping (ties go
 * to the longer token), as protectedRegions reads them. Returns the new carry:
 * the longest tail after the last token that is a proper prefix of a token,
 * so a token split across pieces is found exactly once. `onToken` gets offsets
 * into `carry + text`.
 */
export function findTokens(carry: string, text: string, tokens: readonly string[],
  onToken: (token: number, at: number) => boolean | void): string {
  const s = carry + text;
  regionScanWork.chars += s.length * tokens.length;
  let from = 0;
  const next = tokens.map(t => s.indexOf(t));
  for (;;) {
    let at = -1;
    let token = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (next[i] !== -1 && next[i]! < from) next[i] = s.indexOf(tokens[i]!, from);
      const hit = next[i]!;
      if (hit !== -1 && (at === -1 || hit < at || (hit === at && tokens[i]!.length > tokens[token]!.length))) { at = hit; token = i; }
    }
    if (at === -1) break;
    from = at + tokens[token]!.length;
    if (onToken(token, at) === false) return '';
  }
  const lastChar = s.charAt(s.length - 1);
  if (!lastChar || !tokens.some(t => t.includes(lastChar))) return '';
  const longest = Math.max(...tokens.map(t => t.length)) - 1;
  for (let k = Math.min(longest, s.length - from); k > 0; k--) {
    const tail = s.slice(s.length - k);
    if (tokens.some(t => t.startsWith(tail))) return tail;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Fence lines (scanMarkdownCode's grammar, judged one character at a time).
// ---------------------------------------------------------------------------

/** The open fenced code block: its fence character and run length, plus the mispairing flag. */
export interface FenceRun { fence: '`' | '~' | null; len: number; mispaired: boolean }

/** A fence-line judgement in progress: up to 3 spaces, a run of ` or ~, then the rest of the line. */
export interface FenceProbe {
  phase: 'indent' | 'run' | 'rest' | 'none';
  indent: number;
  ch: '`' | '~' | null;
  run: number;
  /** The rest holds a backtick, U+2028 or U+2029, or anything but spaces and tabs. */
  tick: boolean;
  sep: boolean;
  ws: boolean;
}

function newFenceRun(): FenceRun { return { fence: null, len: 0, mispaired: false }; }

function newFenceProbe(): FenceProbe {
  return { phase: 'indent', indent: 0, ch: null, run: 0, tick: false, sep: false, ws: true };
}

function feedFenceProbe(p: FenceProbe, s: string): void {
  let i = 0;
  for (; i < s.length && p.phase !== 'none'; i++) {
    const c = s.charCodeAt(i);
    if (p.phase === 'indent') {
      if (c === 32 && p.indent < 3) { p.indent++; continue; }
      if (c === 96 || c === 126) { p.phase = 'run'; p.ch = c === 96 ? '`' : '~'; p.run = 1; continue; }
      p.phase = 'none';
      continue;
    }
    if (p.phase === 'run') {
      if (c === p.ch!.charCodeAt(0)) { p.run++; continue; }
      p.phase = 'rest';
    }
    if (c === 96) p.tick = true;
    if (c === 0x2028 || c === 0x2029) p.sep = true;
    if (c !== 32 && c !== 9) p.ws = false;
    if (!p.ws && p.sep && (p.tick || p.ch === '~')) p.phase = 'none';
  }
  regionScanWork.chars += i;
}

function probeOpens(p: FenceProbe): boolean {
  return (p.phase === 'run' || p.phase === 'rest') && p.run >= 3 && !p.sep && !(p.ch === '`' && p.tick);
}

function probeCloses(p: FenceProbe, walk: FenceRun): boolean {
  return (p.phase === 'run' || p.phase === 'rest') && p.ch === walk.fence && p.run >= walk.len && p.ws;
}

/** Advance the walk past a judged line. */
function advanceFenceRun(walk: FenceRun, p: FenceProbe): void {
  if (!walk.fence) {
    if (probeOpens(p)) { walk.fence = p.ch; walk.len = p.run; }
  } else if (probeCloses(p, walk)) {
    walk.fence = null;
    walk.len = 0;
  } else if (!walk.mispaired && probeOpens(p) && p.ch === walk.fence && p.run >= walk.len) {
    walk.mispaired = true;
  }
}

/** The trust scanMarkdownCode would give the body scanned so far, were it to end here. */
export function walkTrusted(walk: FenceRun): boolean {
  return !walk.fence && !walk.mispaired;
}

// ---------------------------------------------------------------------------
// Protected regions.
// ---------------------------------------------------------------------------

const MARKERS = PROTECTED_PAIRS.flatMap((p, pair) => [{ text: p.begin, pair, begin: true }, { text: p.end, pair, begin: false }]);
/** The protected-fence marker tokens, in PROTECTED_PAIRS order (begin, end per pair). */
export const PROTECTED_MARKERS = MARKERS.map(m => m.text);
const MARKER_TEXTS = PROTECTED_MARKERS;
const MARKER_LEAD = MARKER_TEXTS.reduce((a, b) => { let k = 0; while (k < a.length && a[k] === b[k]) k++; return a.slice(0, k); });

/** The region scanner's parser state at a line start (or inside a long line). JSON-safe. */
export interface RegionTrack {
  walk: FenceRun;
  /** The open protected region: its pair index, stored-stream byte start and `read`. */
  open: { pair: number; start: number; read: boolean } | null;
  /** Byte where an ambiguous tail starts; everything from there to the end of the region is protected. */
  truncatedAt: number | null;
  /** Progress through the current long line. */
  long: { probe: FenceProbe; carry: string } | null;
}

/** A closed protected region, stored-stream bytes; same fields as fence-scan's ProtectedRegion. */
export interface ScannedRegion { pair: number; start: number; end: number; read: boolean }

/**
 * A protected run inside the text just scanned, in UTF-16 offsets of that text
 * (`to` may equal the text length when the run continues): the region's pair
 * (or -1 after truncation) and its stored-stream start.
 */
export interface Cover { from: number; to: number; pair: number; start: number }

export interface ScanOut {
  regions: ScannedRegion[];
  covers: Cover[];
  /** The line terminator is protected too. */
  coverTerm: boolean;
}

export function newRegionTrack(): RegionTrack {
  return { walk: newFenceRun(), open: null, truncatedAt: null, long: null };
}

/** Scan one whole line (no terminator in `text`) starting at stored byte `byteStart`. */
export function scanRegionLine(track: RegionTrack, trusted: boolean, text: string, byteStart: number, term: string, out: ScanOut): void {
  const probe = newFenceProbe();
  feedFenceProbe(probe, text);
  const inBlock = trusted && (track.walk.fence !== null || probeOpens(probe));
  let coverFrom = track.open || track.truncatedAt !== null ? 0 : -1;
  if (track.truncatedAt === null) regionScanWork.chars += text.length;
  if (track.truncatedAt === null && text.includes(MARKER_LEAD)) {
    let spans: Array<[number, number]> | null = null;
    let charAt = 0;
    let byteAt = byteStart;
    findTokens('', text, MARKER_TEXTS, (i, at) => {
      byteAt += utf8Len(text, charAt, at);
      charAt = at;
      if (!spans) regionScanWork.chars += text.length;
      const read = !inBlock && !insideSpan(spans ??= inlineCodeSpans(text), at);
      const step = regionToken(track, i, byteAt, read, out);
      if (step === 'open') coverFrom = at;
      else if (step === 'close') { out.covers.push({ from: coverFrom, to: at + MARKERS[i]!.text.length, pair: MARKERS[i]!.pair, start: out.regions[out.regions.length - 1]!.start }); coverFrom = -1; }
      return step !== 'truncate';
    });
  }
  if (coverFrom !== -1) out.covers.push({ from: coverFrom, to: text.length, pair: track.open?.pair ?? -1, start: track.open?.start ?? track.truncatedAt! });
  out.coverTerm = coverFrom !== -1 && term !== '';
  advanceFenceRun(track.walk, probe);
}

/**
 * Scan a piece of a long line. `first` starts the line; `term` (non-null) ends
 * it. Splitting a piece in two and scanning both gives the same result.
 */
export function scanRegionPiece(track: RegionTrack, trusted: boolean, text: string, byteStart: number,
  first: boolean, term: string | null, out: ScanOut): void {
  if (first || !track.long) track.long = { probe: newFenceProbe(), carry: '' };
  const long = track.long;
  feedFenceProbe(long.probe, text);
  const known = trusted && track.walk.fence !== null;
  let coverFrom = track.open || track.truncatedAt !== null ? 0 : -1;
  if (track.truncatedAt === null) {
    const lead = long.carry.length;
    let charAt = 0;
    let byteAt = byteStart;
    long.carry = findTokens(long.carry, text, MARKER_TEXTS, (i, at) => {
      const local = Math.max(0, at - lead);
      if (at >= lead) { byteAt += utf8Len(text, charAt, local); charAt = local; }
      const tokenByte = at >= lead ? byteAt : byteStart - (lead - at);
      const read = known ? false : track.open === null;
      const step = regionToken(track, i, tokenByte, read, out);
      if (step === 'open') coverFrom = local;
      else if (step === 'close') { out.covers.push({ from: coverFrom === -1 ? 0 : coverFrom, to: at + MARKERS[i]!.text.length - lead, pair: MARKERS[i]!.pair, start: out.regions[out.regions.length - 1]!.start }); coverFrom = -1; }
      return step !== 'truncate';
    });
    if (track.truncatedAt !== null) long.carry = '';
  }
  if (coverFrom !== -1) out.covers.push({ from: coverFrom, to: text.length, pair: track.open?.pair ?? -1, start: track.open?.start ?? track.truncatedAt! });
  out.coverTerm = coverFrom !== -1 && !!term;
  if (term !== null) {
    advanceFenceRun(track.walk, long.probe);
    track.long = null;
  }
}

/** protectedRegions' decision for one marker token; a closed region goes to `out.regions`. */
function regionToken(track: RegionTrack, i: number, byteAt: number, read: boolean, out: ScanOut): 'open' | 'close' | 'skip' | 'truncate' {
  const m = MARKERS[i]!;
  const open = track.open;
  if (!open) {
    if (!m.begin) return 'skip';
    track.open = { pair: m.pair, start: byteAt, read };
    return 'open';
  }
  const isEnd = !m.begin && m.pair === open.pair;
  if (open.read && !read && isEnd) return 'skip';
  if (!isEnd) {
    track.truncatedAt = open.start;
    track.open = null;
    return 'truncate';
  }
  out.regions.push({ pair: open.pair, start: open.start, end: byteAt + m.text.length, read: open.read });
  track.open = null;
  return 'close';
}

function insideSpan(spans: Array<[number, number]>, at: number): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = spans[mid]!;
    if (at < s) hi = mid - 1;
    else if (at >= e) lo = mid + 1;
    else return true;
  }
  return false;
}

/** State of the chunk-at-a-time region scan. */
export interface RegionScanState { trusted: boolean; track: RegionTrack; split: LineSplit }

export function initialRegionScan(trusted: boolean, pos = 0): RegionScanState {
  return { trusted, track: newRegionTrack(), split: newLineSplit(pos, 'lf') };
}

/**
 * Scan the next chunk of one body region. Regions are reported as they close;
 * with `final`, an unpaired begin becomes the truncated tail, as in
 * protectedRegions. Concatenating every call's regions over any chunking gives
 * protectedRegions(body) in stored bytes (for lines under SEGMENT_MAX_BYTES).
 */
export function protectedRegionScan(state: RegionScanState, chunk: string, final = false):
  { regions: ScannedRegion[]; truncatedAt: number | null; state: RegionScanState } {
  const out: ScanOut = { regions: [], covers: [], coverTerm: false };
  splitLines(state.split, chunk, final, e => {
    if (e.kind === 'line') scanRegionLine(state.track, state.trusted, e.text, e.byteStart, e.term, out);
    else scanRegionPiece(state.track, state.trusted, e.text, e.byteStart, e.first, e.term, out);
    out.covers.length = 0;
  });
  if (final && state.track.open) {
    state.track.truncatedAt = state.track.open.start;
    state.track.open = null;
  }
  return { regions: out.regions, truncatedAt: state.track.truncatedAt, state };
}

// ---------------------------------------------------------------------------
// Private-key spans over a stream.
// ---------------------------------------------------------------------------

/** How far a PEM claim reads past a BEGIN fence or back from an END fence (with slack). */
export const PEM_CONTEXT_CHARS = PEM_BODY_MAX_CHARS + 512;
/** A fence candidate whose `[A-Z ]` run grows past this many chars is given up (memory bound; an accepted miss). */
const PEM_FENCE_HOLD_MAX = 64 * 1024;
/** Lines this long are judged without reading them whole (a PEM body line is at most ~160 chars). */
const PEM_LINE_PROBE = 2048;

const BEGIN_RE = new RegExp(PEM_BEGIN_RE.source, 'g');
const END_RE = new RegExp(PEM_END_RE.source, 'g');
const FENCE_REST = /[A-Z ]*-{0,4}$/y;

interface PemFence { begin: boolean; start: number; end: number }

/** Where a resumed PEM scan starts: at the region start, at a line start, or inside a line. */
export type PemStart = 'region_start' | 'line_start' | 'mid_line';

export interface PemScanState {
  /** Projection offset of buf[0]; the projection before 0 is a sentinel on resume. */
  base: number;
  buf: string;
  floor: number;
  find: Record<'begin' | 'end', { from: number; safe: number }>;
  begins: PemFence[];
  ends: PemFence[];
  /** Recent fences and claims, and BEGIN fences whose claim read ahead, for cut checks. */
  fences: PemFence[];
  claims: Array<{ start: number; end: number }>;
  readAhead: Array<{ start: number; until: number }>;
  cuts: Array<{ at: number; done?: { clean: boolean; start: PemStart } }>;
  final: boolean;
}

export function initialPemScan(start: PemStart): PemScanState {
  const buf = start === 'line_start' ? '\u0001\n' : start === 'mid_line' ? '\u0001' : '';
  return {
    base: -buf.length, buf, floor: -buf.length,
    find: { begin: { from: 0, safe: 0 }, end: { from: 0, safe: 0 } },
    begins: [], ends: [], fences: [], claims: [], readAhead: [], cuts: [], final: false,
  };
}

/**
 * Feed the next projection text. Spans go to `onSpan` in order, each final:
 * the same spans privateKeySpans returns over the whole projection, except for
 * fences whose `[A-Z ]` run exceeds 64 KiB.
 */
export function feedPemScan(st: PemScanState, text: string, final: boolean, onSpan: (start: number, end: number) => void): void {
  st.buf += text;
  regionScanWork.pem += text.length;
  st.final = final;
  discoverPem(st, 'begin');
  discoverPem(st, 'end');
  processPem(st, onSpan);
  const resolved = pemResolvedTo(st);
  regionScanWork.entries += st.cuts.length;
  for (const cut of st.cuts) if (!cut.done && cut.at <= resolved) cut.done = pemCutCheck(st, cut.at);
  trimPem(st);
}

/** Every claim starting before this projection offset has been reported. */
export function pemResolvedTo(st: PemScanState): number {
  if (st.final) return Infinity;
  let h = Math.min(st.find.begin.safe, st.find.end.safe, st.base + st.buf.length);
  const f = headFence(st);
  if (f) h = Math.min(h, f.start);
  return h - PEM_CONTEXT_CHARS;
}

/** Ask whether a cut at projection offset `at` is a clean resume point; answered once `at` is resolved. */
export function markPemCut(st: PemScanState, at: number): void {
  st.cuts.push(st.final ? { at, done: pemCutCheck(st, at) } : { at });
}

/** The answer for a marked cut (removing it), or null while unresolved. */
export function takePemCut(st: PemScanState, at: number): { clean: boolean; start: PemStart } | null {
  regionScanWork.entries += st.cuts.length;
  const i = st.cuts.findIndex(c => c.at === at && c.done);
  if (i === -1) return null;
  return st.cuts.splice(i, 1)[0]!.done!;
}

/** The answer for a marked cut taken before it resolved: never clean; where a resumed scan restarts. */
export function forcePemCut(st: PemScanState, at: number): { clean: boolean; start: PemStart } {
  regionScanWork.entries += st.cuts.length;
  const i = st.cuts.findIndex(c => c.at === at);
  const done = i === -1 ? undefined : st.cuts.splice(i, 1)[0]!.done;
  if (done) return done;
  const rel = at - st.base;
  return { clean: false, start: rel <= 0 && st.base >= 0 ? 'region_start' : st.buf.charCodeAt(rel - 1) === 10 ? 'line_start' : 'mid_line' };
}

const PEM_LINE_DONE = /^[ \t]*[A-Za-z0-9+/=]+[ \t]*(?:\r|\\r)?$/;
const PEM_LINE_OPEN = /^[ \t]*[A-Za-z0-9+/=]*[ \t]*(?:\r|\\r?|\\)?$/;

/**
 * The earliest projection offset a span reported after this point could
 * start at, whatever text follows: a fence not yet decided or a BEGIN still
 * waiting for its lookahead, or the run of lines at the end of the text that
 * a later END fence's backward claim could cover (each line one base64 run
 * between indents, as pemBackwardStart reads them; a superset). Spans
 * starting before it have all been reported.
 */
export function pemExposedFrom(st: PemScanState): number {
  const buf = st.buf;
  const end = st.base + buf.length;
  const lo = Math.max(st.base, Math.min(end, pemResolvedTo(st))) - st.base;
  let exposed = Math.min(end, st.find.begin.safe, st.find.end.safe, headFence(st)?.start ?? end);
  let start = buf.length;
  for (let i = buf.length, open = true; i > lo; open = false) {
    let j = i;
    while (j > lo && buf.charCodeAt(j - 1) !== 10 && !(buf.charCodeAt(j - 1) === 110 && buf.charCodeAt(j - 2) === 92)) j--;
    regionScanWork.pem += i - j + 1;
    if (!(open ? PEM_LINE_OPEN : PEM_LINE_DONE).test(buf.slice(j, i))) break;
    start = j;
    i = buf.charCodeAt(j - 1) === 10 ? j - 1 : j - 2;
  }
  exposed = Math.min(exposed, start + st.base);
  return Math.max(lo + st.base, exposed);
}

function discoverPem(st: PemScanState, kind: 'begin' | 'end'): void {
  const re = kind === 'begin' ? BEGIN_RE : END_RE;
  const prefix = kind === 'begin' ? '-----BEGIN ' : '-----END ';
  const find = st.find[kind];
  const queue = kind === 'begin' ? st.begins : st.ends;
  const end = st.base + st.buf.length;
  const held = st.final ? end : heldFrom(st.buf, prefix, find.from - st.base) + st.base;
  re.lastIndex = find.from - st.base;
  regionScanWork.pem += st.buf.length - re.lastIndex;
  for (let m = re.exec(st.buf); m && m.index + st.base < held; m = re.exec(st.buf)) {
    const fence = { begin: kind === 'begin', start: m.index + st.base, end: m.index + st.base + m[0].length };
    queue.push(fence);
    st.fences.push(fence);
    find.from = fence.end;
  }
  find.from = Math.max(find.from, held);
  find.safe = held;
}

/** Offset in `buf` of a fence candidate the text so far cannot decide, or buf.length. */
function heldFrom(buf: string, prefix: string, from: number): number {
  const len = buf.length;
  let i = len;
  const lim = Math.max(from, len - PEM_FENCE_HOLD_MAX);
  while (i > lim && isFenceClass(buf.charCodeAt(i - 1))) i--;
  regionScanWork.pem += 2 * (len - i);
  for (let q = buf.indexOf(prefix, i); q !== -1; q = buf.indexOf(prefix, q + 1)) {
    regionScanWork.pem += len - q;
    FENCE_REST.lastIndex = q + prefix.length;
    if (FENCE_REST.test(buf)) return q;
  }
  for (let k = Math.min(prefix.length - 1, len - i); k > 0; k--) if (buf.endsWith(prefix.slice(0, k))) return len - k;
  return len;
}

function isFenceClass(c: number): boolean {
  return (c >= 65 && c <= 90) || c === 32 || c === 45;
}

function headFence(st: PemScanState, skip?: PemFence): PemFence | undefined {
  const b = st.begins.find(f => f !== skip);
  const e = st.ends.find(f => f !== skip);
  return b && (!e || b.start <= e.start) ? b : e;
}

function dropFence(st: PemScanState, f: PemFence): void {
  const q = f.begin ? st.begins : st.ends;
  q.splice(q.indexOf(f), 1);
}

function processPem(st: PemScanState, onSpan: (start: number, end: number) => void): void {
  const end = st.base + st.buf.length;
  for (let f = headFence(st); f; f = headFence(st)) {
    const limit = Math.min(st.find.begin.safe, st.find.end.safe);
    if (f.start >= limit) return;
    if (f.start < st.floor) { dropFence(st, f); continue; }
    if (!f.begin) {
      const start = pemBackwardStart(st.buf, f.start - st.base, Math.max(st.floor - st.base, 0));
      if (start >= 0) claimPem(st, start + st.base, f.end, onSpan);
      st.floor = f.end;
      dropFence(st, f);
      continue;
    }
    if (!st.final && (end < f.end + PEM_CONTEXT_CHARS || limit <= f.end + PEM_BODY_MAX_CHARS)) return;
    const next = headFence(st, f);
    dropFence(st, f);
    if (next && !next.begin && next.start - f.end <= PEM_BODY_MAX_CHARS) {
      claimPem(st, f.start, next.end, onSpan);
      st.floor = next.end;
      dropFence(st, next);
    } else {
      st.floor = pemForwardEnd(st.buf, f.end - st.base) + st.base;
      claimPem(st, f.start, st.floor, onSpan);
    }
    st.readAhead.push({ start: f.start, until: f.end + PEM_CONTEXT_CHARS });
  }
}

function claimPem(st: PemScanState, start: number, end: number, onSpan: (start: number, end: number) => void): void {
  regionScanWork.pem += end - start;
  st.claims.push({ start, end });
  onSpan(start, end);
}

/**
 * A cut at `at` is clean when a scan restarted there (behind a sentinel) finds
 * the same spans after it: no claim or fence spans the cut, no BEGIN before it
 * read past it, and the line on one side of it can stop a backward walk.
 */
function pemCutCheck(st: PemScanState, at: number): { clean: boolean; start: PemStart } {
  const rel = at - st.base;
  if (rel <= 0 && st.base >= 0) return { clean: true, start: 'region_start' };
  const lineStart = st.buf.charCodeAt(rel - 1) === 10;
  const start: PemStart = lineStart ? 'line_start' : 'mid_line';
  const spans = (r: { start: number; end: number }) => r.start < at && at < r.end;
  regionScanWork.entries += st.claims.length + st.fences.length + st.readAhead.length;
  if (st.claims.some(spans) || st.fences.some(spans) || st.readAhead.some(r => r.start < at && r.until > at)) return { clean: false, start };
  if (!lineStart) return { clean: !isPemLineChar(st.buf.charCodeAt(rel - 1)), start };
  return { clean: !(bodyLikeBefore(st.buf, rel - 1) && bodyLikeFrom(st.buf, rel)), start };
}

function isPemLineChar(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 61 || c === 92;
}

/** Could the line could hold PEM body text (only base64, backslash escapes and blanks)? Unknown counts as yes. */
export function pemBodyLike(line: string): boolean {
  return bodyLikeFrom(line, 0);
}

function bodyLikeFrom(s: string, from: number): boolean {
  let any = false;
  for (let i = from; i < s.length; i++) {
    regionScanWork.pem++;
    const c = s.charCodeAt(i);
    if (c === 10 || c === 13) return any;
    if (i - from >= PEM_LINE_PROBE) return true;
    if (isPemLineChar(c)) any = true;
    else if (c !== 32 && c !== 9) return false;
  }
  return any || from >= s.length;
}

function bodyLikeBefore(s: string, nl: number): boolean {
  let i = nl;
  if (s.charCodeAt(i - 1) === 13) i--;
  let any = false;
  for (let k = i - 1; k >= 0; k--) {
    regionScanWork.pem++;
    const c = s.charCodeAt(k);
    if (c === 10) return any;
    if (i - k > PEM_LINE_PROBE) return true;
    if (isPemLineChar(c)) any = true;
    else if (c !== 32 && c !== 9 && c !== 1) return false;
  }
  return true;
}

function trimPem(st: PemScanState): void {
  let keep = Math.min(st.find.begin.safe, st.find.end.safe, st.base + st.buf.length);
  const f = headFence(st);
  if (f) keep = Math.min(keep, f.start);
  keep -= 2 * PEM_CONTEXT_CHARS;
  regionScanWork.entries += st.cuts.length;
  for (const cut of st.cuts) if (!cut.done) keep = Math.min(keep, cut.at - PEM_LINE_PROBE - 2);
  if (st.final || keep - st.base < 4 * PEM_CONTEXT_CHARS) return;
  regionScanWork.pem += st.buf.length - (keep - st.base);
  regionScanWork.entries += st.fences.length + st.claims.length + st.readAhead.length;
  st.buf = st.buf.slice(keep - st.base);
  st.base = keep;
  st.fences = st.fences.filter(x => x.end > keep);
  st.claims = st.claims.filter(x => x.end > keep);
  st.readAhead = st.readAhead.filter(x => x.until > keep);
}
