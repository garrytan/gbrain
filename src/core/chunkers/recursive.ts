/**
 * Recursive Delimiter-Aware Text Chunker
 * Ported from production Ruby implementation (text_chunker.rb, 205 LOC)
 *
 * 5-level delimiter hierarchy:
 *   1. Paragraphs (\n\n)
 *   2. Lines (\n)
 *   3. Sentences (. ! ? followed by space or newline; plus CJK 。！？)
 *   4. Clauses (; : , ; plus CJK ；：，、)
 *   5. Words (whitespace + CJK char-slice fallback)
 *
 * Config: 300-word chunks with 50-word sentence-aware overlap.
 * v0.32.7: maxChars hard cap (default 6000) sliding-window safety belt
 * guarantees no chunk overflows OpenAI's 8192-token embedding limit even
 * on pathological CJK / whitespace-less text.
 * #3477 follow-up: the belt also bounds ESTIMATED embedding tokens
 * (DEFAULT_MAX_CHUNK_TOKENS, shared with the code chunker's oversize cap) —
 * a char-only cap cannot bound tokens for CJK/dense text (#3037, #2826).
 *
 * Lossless invariant: non-overlapping portions reassemble to original.
 */

import { countCJKAwareWords, isCJKDominant, wordStats, concatWordStats, wordCountOf, CJK_SENTENCE_DELIMITERS, CJK_CLAUSE_DELIMITERS } from '../cjk.ts';
import { estimateEmbedTokens, fitsEmbedTokens, DEFAULT_MAX_CHUNK_TOKENS } from './token-estimate.ts';
import { safeSplitIndex } from '../text-safe.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { credentialSafeProjection } from '../credential-projection.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';

/**
 * Markdown chunker version. Folded into the per-page chunker_version column
 * so post-upgrade reindex sweeps can find pages built with old chunkers and
 * rebuild them on the new shape. Bump on any change that affects chunk
 * boundaries (delimiters, word counting, maxChars cap) OR the per-chunk
 * embedding shape (wrapper prefix added at embed time).
 *
 * v4: strict full-body Facts/Takes sanitation covers repeated, nested and
 * unterminated protected fences before splitting or embedding.
 *
 * v3 (v0.40.3.0): chunks embed with optional contextual retrieval wrapper
 * per Anthropic's published methodology. Wrapper is built JUST IN TIME at
 * embed call; stored `content_chunks.chunk_text` stays canonical. Chunk
 * boundaries themselves are unchanged from v2 — bumping the version forces
 * re-embed (not re-chunk) so existing pages pick up the wrapper on the
 * post-upgrade reembed sweep. See
 * `src/core/contextual-retrieval-service.ts`.
 */
export const MARKDOWN_CHUNKER_VERSION = SAFE_FENCE_CHUNKER_VERSION;

const DELIMITERS: string[][] = [
  ['\n\n'],                          // L0: paragraphs
  ['\n'],                            // L1: lines
  ['. ', '! ', '? ', '.\n', '!\n', '?\n', ...CJK_SENTENCE_DELIMITERS], // L2: sentences
  ['; ', ': ', ', ', ...CJK_CLAUSE_DELIMITERS],                         // L3: clauses
  [],                                // L4: words (whitespace + CJK char-slice fallback)
];

export interface ChunkOptions {
  chunkSize?: number;    // target words per chunk (default 300)
  chunkOverlap?: number; // overlap words (default 50)
  maxChars?: number;     // hard cap on any chunk's char length (default 6000)
  /**
   * #4530: hard cap on any chunk's ESTIMATED embedding tokens (default
   * DEFAULT_MAX_CHUNK_TOKENS). Callers on strict per-input embedding models
   * (e.g. nvidia/nv-embedqa-e5-v5's 512) thread
   * resolveMaxChunkTokens() (src/core/embedding-input-limit.ts) so oversize
   * text is SPLIT to fit — never truncated, never left permanently
   * unembeddable. Chunk boundaries are unchanged for callers that don't pass
   * it (or whose model has no declared limit), so MARKDOWN_CHUNKER_VERSION
   * does not bump.
   */
  maxTokens?: number;
  /** Record each chunk's projected UTF-8 byte span (TextChunk.byte_start/byte_end). Chunk text is unchanged. */
  spans?: boolean;
  /**
   * A Markdown heading line (or a run of them) joins the running chunk only together with the piece after it;
   * when that piece starts the next chunk, the headings start it too. Segmented pages only (segment-chunks.ts):
   * a section appended after a full last chunk then leaves that chunk's text, and its vector, unchanged.
   */
  headingsLead?: boolean;
  /**
   * The hard cap's forced cuts (capByChars) land on a sentence end, else a line end, else whitespace, else a code point,
   * searched backward from the bound over at most CUT_LOOKBACK_CHARS, and the next window starts one overlap before
   * that cut. Segmented pages only (segment-chunks.ts, SEGMENTED_CHUNKER_VERSION): inline chunks are unchanged.
   */
  boundaryCuts?: boolean;
}

export interface TextChunk {
  text: string;
  index: number;
  /**
   * With `spans: true`: the chunk's position in the projected text it was cut
   * from (credentialSafeProjection(sanitizeRemoteBody(text))), as UTF-8 byte
   * offsets, end exclusive. The span starts at the chunk's first character and
   * ends after its last one; whitespace-only runs the chunker folded away lie
   * inside it, so the span's text equals the chunk text once whitespace is
   * ignored. Absent when the span cannot be traced.
   */
  byte_start?: number;
  byte_end?: number;
}

// The strict full-body sanitizer removes all Takes and non-world Facts. Takes content
// lives in the takes table only; duplicating it inside content_chunks would
// bypass the per-token MCP allow-list (Codex P0 #3 privacy fix).

// v0.32.2 (Codex R2-#1 P0): same posture for facts — private fact rows must
// not reach content_chunks.chunk_text, embeddings, or search. Pass
// `keepVisibility: ['world']` so world-visibility facts remain searchable
// (they're public knowledge by definition) while private rows are stripped
// at the row level. The fence shell stays in the chunked body so callers
// that re-import the chunk content can still parse it; only the private
// rows go.

export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  if (!text || text.trim().length === 0) return [];

  // v0.28: strip fenced takes blocks BEFORE chunking. Takes are retrieval-
  // accessible only via the takes table; their content must not appear in
  // content_chunks where the per-token allow-list cannot reach.
  //
  // v0.32.2: also strip private facts (Codex R2-#1). World facts stay so
  // search retains its public-knowledge surface; private rows are filtered
  // out at the fence-row level via stripFactsFence({keepVisibility:['world']}).
  return chunkProjectedText(credentialSafeProjection(sanitizeRemoteBody(text)), opts);
}

/**
 * chunkText on text that is already the retrieval projection (sanitized and
 * credential-safe): segmented pages build it per segment from stored regions
 * (page-body/segment-chunks.ts). Spans index `stripped`.
 */
export function chunkProjectedText(stripped: string, opts?: ChunkOptions): TextChunk[] {
  const chunkSize = opts?.chunkSize || 300;
  const chunkOverlap = opts?.chunkOverlap || 50;
  const maxChars = opts?.maxChars || 6000;
  // #4530: per-call token budget, clamped to the historical default so a
  // misconfigured larger value can't emit chunks the rest of the pipeline
  // (tsvector limits, context assembly) was never sized for.
  const maxTokens = opts?.maxTokens && opts.maxTokens > 0
    ? Math.min(opts.maxTokens, DEFAULT_MAX_CHUNK_TOKENS)
    : DEFAULT_MAX_CHUNK_TOKENS;

  if (!stripped || stripped.trim().length === 0) return [];
  const boundaryCuts = opts?.boundaryCuts === true;

  const wordCount = countWords(stripped);
  if (wordCount <= chunkSize) {
    // Single-chunk path: still apply the maxChars cap.
    const whole = trimmedRun({ text: stripped, segs: [{ t: 0, s: 0, n: stripped.length }] });
    return finish(stripped, capByChars(whole.text, maxChars, maxTokens, undefined, boundaryCuts).map(c => placed(whole, c)), opts?.spans === true);
  }

  // Recursively split, then greedily merge to target size
  const pieces = recursiveSplit(stripped, 0, chunkSize, 0);
  const merged = greedyMerge(pieces, chunkSize, opts?.headingsLead === true);
  const withOverlap = applyOverlap(merged, chunkOverlap);
  // v0.32.7: hard char cap. Catches pathological CJK + whitespace-less text
  // that the word-level pipeline can't bound (a single Chinese paragraph can
  // exceed 8192 OpenAI embedding tokens at any word count).
  const capped: Placed[] = [];
  for (const chunk of withOverlap) {
    const run = trimmedRun(chunk);
    for (const c of capByChars(run.text, maxChars, maxTokens, undefined, boundaryCuts)) capped.push(placed(run, c));
  }
  return finish(stripped, capped, opts?.spans === true);
}

/** A substring of the projected text: `s` is its UTF-16 offset there. */
interface Piece { text: string; s: number }
/** `n` code units of a run's text at run offset `t` sit at projected offset `s`. */
interface Seg { t: number; s: number; n: number }
/** Text assembled from projected substrings (whitespace-only gaps may be folded away). */
interface Run { text: string; segs: Seg[] }
/** A run slice: `at` is its offset in the run's text. */
interface Slice { text: string; at: number }
interface Placed { text: string; start: number | null; end: number | null }

/**
 * @internal Work the span bookkeeping does, for the linearity test: seg entries
 * visited or copied (`segs`) and steps the UTF-8 offset walk takes
 * (`units`). Counts, not time, so a busy machine cannot move them.
 */
export const spanWork = { segs: 0, units: 0 };

function runOffset(run: Run, t: number): number | null {
  for (const seg of run.segs) {
    spanWork.segs++;
    if (t >= seg.t && t < seg.t + seg.n) return seg.s + (t - seg.t);
  }
  return null;
}

function placed(run: Run, c: Slice): Placed {
  if (c.text.length === 0) return { text: c.text, start: null, end: null };
  const start = runOffset(run, c.at);
  const last = runOffset(run, c.at + c.text.length - 1);
  return { text: c.text, start, end: last === null ? null : last + 1 };
}

function trimmedRun(run: Run): Run {
  const text = run.text.trim();
  const lead = run.text.length - run.text.trimStart().length;
  return lead === 0 && text.length === run.text.length ? run : sliceRun(run, lead, lead + text.length);
}

function sliceRun(run: Run, from: number, to: number): Run {
  spanWork.segs += run.segs.length;
  const segs: Seg[] = [];
  for (const seg of run.segs) {
    const a = Math.max(from, seg.t);
    const b = Math.min(to, seg.t + seg.n);
    if (a < b) segs.push({ t: a - from, s: seg.s + (a - seg.t), n: b - a });
  }
  return { text: run.text.slice(from, to), segs };
}

function joinRuns(a: Run, b: Run): Run {
  spanWork.segs += a.segs.length + b.segs.length;
  return { text: a.text + b.text, segs: [...a.segs, ...b.segs.map(seg => ({ ...seg, t: seg.t + a.text.length }))] };
}

/** Chunks with indexes, plus UTF-8 spans in the projected text when asked for (one pass over it). */
function finish(stripped: string, chunks: Placed[], spans: boolean): TextChunk[] {
  const out: TextChunk[] = chunks.map((c, i) => ({ text: c.text, index: i }));
  if (!spans) return out;
  const wanted: number[] = [];
  for (const c of chunks) if (c.start !== null && c.end !== null) wanted.push(c.start, c.end);
  const bytes = utf16ToUtf8Offsets(stripped, wanted);
  chunks.forEach((c, i) => {
    if (c.start === null || c.end === null) return;
    out[i].byte_start = bytes.get(c.start);
    out[i].byte_end = bytes.get(c.end);
  });
  return out;
}

/** UTF-8 byte offset of each UTF-16 offset (offsets inside a surrogate pair count from the pair start). */
export function utf16ToUtf8Offsets(text: string, offsets: readonly number[]): Map<number, number> {
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let bytes = 0;
  let i = 0;
  let walked = 0;
  for (const target of sorted) {
    while (i < target && i < text.length) {
      walked++;
      const c = text.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
        const d = text.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { if (i + 1 === target) { out.set(target, bytes); } bytes += 4; i += 2; continue; }
        bytes += 3;
      } else bytes += 3;
      i++;
    }
    if (!out.has(target)) out.set(target, bytes);
  }
  spanWork.units += walked;
  return out;
}

/**
 * Hard-cap a chunk via a sliding window — by char length AND by estimated
 * embedding tokens. Returns the input unchanged when it fits both budgets.
 *
 * The char budget (maxChars, default 6000) is the historical belt; the token
 * budget (DEFAULT_MAX_CHUNK_TOKENS, shared with the code chunker's oversize
 * cap) is the constraint embedders actually enforce. A char-only cap cannot
 * bound tokens: 6000 CJK-dense chars run 3-6k tokens, past strict embedder
 * contexts (nomic-embed-text 2048), so those chunks fail on every embed
 * sweep, silently, forever (#3037) — and URL-dense CJK markdown emits
 * over-limit chunks well under maxChars (#2826). When the text over-runs the
 * token budget, the window is derived from its own measured density —
 * floor(length × budget / estimate) — and every slice is re-checked (local
 * density can exceed the whole-text average), re-deriving on the slice until
 * each piece fits. ASCII prose is unaffected: 6000 chars measure ~1.5-1.7k
 * cl100k tokens, under the budget, so the window stays maxChars.
 *
 * Overlap is min(500, window/10) so successive windows preserve semantic
 * continuity across the cut.
 *
 * v0.32.7. Surrogate-safe: the window is derived from measured density and so
 * has arbitrary parity, which a raw slice would use to cut an astral pair in
 * half — every boundary goes through safeSplitIndex. (The former "BMP-only
 * safe" note rested on maxChars=6000 and stride=5500 both being even;
 * deriving the window from density retired that guarantee.)
 */
function capByChars(
  text: string,
  maxChars: number,
  maxTokens: number = DEFAULT_MAX_CHUNK_TOKENS,
  knownEst?: number,
  boundaryCuts = false,
): Slice[] {
  if (text.length === 0) return [];
  if (knownEst === undefined && text.length <= maxChars && fitsEmbedTokens(text, maxTokens)) return [{ text, at: 0 }];
  const est = knownEst ?? probeEmbedTokens(text);
  const window = est <= maxTokens
    ? maxChars
    : Math.max(1, Math.min(maxChars, Math.floor((text.length * maxTokens) / est)));
  if (text.length <= window) {
    // Emitting the text whole is the one path that skips the per-slice
    // re-check below, so a PROBED estimate has to be confirmed exactly first:
    // a sparse ASCII head can under-read a dense CJK tail.
    if (knownEst !== undefined || text.length <= DENSITY_PROBE_CHARS) return [{ text, at: 0 }];
    const exact = estimateEmbedTokens(text);
    return exact <= maxTokens ? [{ text, at: 0 }] : capByChars(text, maxChars, maxTokens, exact, boundaryCuts);
  }
  // The stride keeps its nominal window-minus-overlap value. Evening the
  // windows out (as the header-budget hard split does) is WRONG here: that
  // splitter partitions, this one overlaps, so shrinking the stride to land
  // the last window flush against the end collapses successive windows into
  // near-duplicates — measured on scripts/test-weights.json, two 6,047-char
  // chunks differing by 47 chars. A short final window is the cheaper end of
  // that trade and is the behavior this loop has always had.
  const overlap = Math.min(500, Math.floor(window / 10));
  const stride = Math.max(1, window - overlap);
  const lookback = Math.min(CUT_LOOKBACK_CHARS, Math.floor(window / 4));
  const out: Slice[] = [];
  let i = 0;
  while (i < text.length) {
    const bound = safeSplitIndex(text, Math.min(text.length, i + window));
    const end = boundaryCuts && bound < text.length ? forcedCut(text, bound, lookback) : bound;
    const raw = text.slice(i, end);
    const slice = raw.trim();
    const at = i + raw.length - raw.trimStart().length;
    if (slice.length > 0) {
      const sliceEst = fitsEmbedTokens(slice, maxTokens) ? 0 : estimateEmbedTokens(slice);
      if (sliceEst > maxTokens) {
        // Denser than the text average — re-derive locally, reusing the exact
        // figure just measured (it also guarantees window < slice.length, so
        // the recursion strictly shrinks).
        for (const part of capByChars(slice, maxChars, maxTokens, sliceEst, boundaryCuts)) out.push({ text: part.text, at: at + part.at });
      } else {
        out.push({ text: slice, at });
      }
    }
    if (end >= text.length) break;
    const next = safeSplitIndex(text, Math.min(text.length, boundaryCuts ? end - overlap : i + stride));
    i = next > i ? next : i + 1;
  }
  return out;
}

/**
 * Chars a forced cut may move back from the hard bound to reach a sentence or line end. A constant, so the cut search
 * adds at most this much work per window and chunking stays linear; capped at a quarter of the window, so a window
 * keeps three quarters of its length and the next one (one overlap, at most a tenth, before the cut) moves forward.
 */
export const CUT_LOOKBACK_CHARS = 512;

/** @internal Code units the forced-cut search visits, for the linearity test (counts, not time). */
export const cutWork = { scanned: 0 };

const SENTENCE_END_CHARS = new Set(['.', '!', '?']);
const CJK_SENTENCE_END_CHARS = new Set(CJK_SENTENCE_DELIMITERS);
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/**
 * Where a forced cut at `bound` lands: after the last sentence end at most `lookback` code units back, else after the
 * last line end, else at the last whitespace, else at `bound` (already a code-point boundary). One backward pass.
 * Every candidate sits between code points (a delimiter or whitespace is one BMP unit) and never between CR and LF.
 */
function forcedCut(text: string, bound: number, lookback: number): number {
  let line = -1, space = -1;
  for (let c = bound; c > bound - lookback && c > 0; c--) {
    cutWork.scanned++;
    const before = text[c - 1]!, at = text[c];
    if (before === '\r' && at === '\n') continue;
    if (CJK_SENTENCE_END_CHARS.has(before) || (isSpace(at) && SENTENCE_END_CHARS.has(before))) return c;
    if (line < 0 && (before === '\n' || at === '\n' || at === '\r')) line = c;
    if (space < 0 && (isSpace(before) || isSpace(at))) space = c;
  }
  return line >= 0 ? line : space >= 0 ? space : bound;
}

/**
 * Chars measured to derive the window. estimateEmbedTokens is SUPERLINEAR on
 * CJK — measured on this repo's encoder: 2K chars 11ms, 6K 99ms, 20K 1,138ms —
 * and capByChars runs on every chunk, so measuring the whole text up front
 * dominates the chunker (the 20K-char whitespace-less CJK cap test went from
 * an O(1) length compare to a 6.7s run, past bun's 5s per-test limit, on a
 * cold encoder). The window only needs an approximate density: every emitted
 * slice is re-measured exactly, denser-than-average slices recurse on that
 * exact figure, and the one path that emits without a re-check confirms
 * exactly first — so the cap holds regardless of what the probe reads.
 */
const DENSITY_PROBE_CHARS = 2000;

function probeEmbedTokens(text: string): number {
  if (text.length <= DENSITY_PROBE_CHARS) return estimateEmbedTokens(text);
  const head = text.slice(0, safeSplitIndex(text, DENSITY_PROBE_CHARS));
  return Math.ceil((estimateEmbedTokens(head) * text.length) / head.length);
}

function recursiveSplit(text: string, level: number, target: number, base: number): Piece[] {
  if (level >= DELIMITERS.length) {
    // Level 4: split on whitespace
    return splitOnWhitespace(text, target, base);
  }

  const delimiters = DELIMITERS[level];
  if (delimiters.length === 0) {
    return splitOnWhitespace(text, target, base);
  }

  const pieces = splitAtDelimiters(text, delimiters, base);

  // If splitting didn't help (only 1 piece), try next level
  if (pieces.length <= 1) {
    return recursiveSplit(text, level + 1, target, base);
  }

  // Check if any piece is still too large, recurse deeper
  const result: Piece[] = [];
  for (const piece of pieces) {
    if (countWords(piece.text) > target) {
      result.push(...recursiveSplit(piece.text, level + 1, target, piece.s));
    } else {
      result.push(piece);
    }
  }

  return result;
}

/**
 * Split text at delimiter boundaries, preserving delimiters at the end
 * of the piece that precedes them (lossless). Each delimiter's next
 * occurrence is searched once and reused until the cursor passes it, so the
 * scan is linear in the text.
 *
 * @internal exported for the differential test.
 */
export function splitAtDelimiters(text: string, delimiters: string[], base: number): Array<{ text: string; s: number }> {
  const pieces: Piece[] = [];
  const next = delimiters.map(() => -2);
  let pos = 0;

  while (pos < text.length) {
    let earliest = -1;
    let earliestDelim = '';

    for (let d = 0; d < delimiters.length; d++) {
      if (next[d] !== -1 && next[d] < pos) next[d] = text.indexOf(delimiters[d], pos);
      const idx = next[d];
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        earliestDelim = delimiters[d];
      }
    }

    if (earliest === -1) {
      pieces.push({ text: text.slice(pos), s: base + pos });
      break;
    }

    // Include the delimiter with the preceding text
    const end = earliest + earliestDelim.length;
    const piece = text.slice(pos, end);
    if (piece.trim().length > 0) {
      pieces.push({ text: piece, s: base + pos });
    }
    pos = end;
  }

  return pieces.filter(p => p.text.trim().length > 0);
}

/**
 * Fallback: split on whitespace boundaries to hit target word count.
 * v0.32.7: when the input is whitespace-less or any single "word" exceeds
 * the target (CJK paragraph, base64 blob, long URL), slice on character
 * boundaries so we still bound chunk size and the chunker makes forward
 * progress. The downstream maxChars cap tightens this further.
 */
function splitOnWhitespace(text: string, target: number, base: number): Piece[] {
  const words = [...text.matchAll(/\S+\s*/g)];

  // No whitespace tokens, OR a single token longer than `target` chars
  // (greedy /\S+/g returns a CJK paragraph as one "word"). Slice by char.
  const noUsefulWhitespace =
    words.length === 0 || (words.length === 1 && words[0][0].length > target);
  if (noUsefulWhitespace) {
    if (text.trim().length === 0) return [];
    const pieces: Piece[] = [];
    const charsPerPiece = Math.max(1, target);
    // Cursor advances to wherever safeSplitIndex actually cut, so no astral
    // pair (emoji, non-BMP CJK) is halved and no code unit is skipped or
    // repeated. A window too narrow to hold a pair takes the pair whole.
    let i = 0;
    while (i < text.length) {
      let end = safeSplitIndex(text, Math.min(text.length, i + charsPerPiece));
      if (end <= i) end = Math.min(text.length, i + 2);
      const slice = text.slice(i, end);
      if (slice.trim().length > 0) pieces.push({ text: slice, s: base + i });
      i = end;
    }
    return pieces;
  }

  // Consecutive matches are contiguous, so a run of words is one substring.
  const pieces: Piece[] = [];
  for (let i = 0; i < words.length; i += target) {
    const first = words[i];
    const last = words[Math.min(i + target, words.length) - 1];
    const from = first.index!;
    const slice = text.slice(from, last.index! + last[0].length);
    if (slice.trim().length > 0) {
      pieces.push({ text: slice, s: base + from });
    }
  }
  return pieces;
}

/**
 * Greedily merge adjacent pieces until each chunk is near the target size.
 * Avoids creating chunks larger than target * 1.5. The running chunk's word
 * stats grow with it (concatWordStats), so each piece is counted once instead
 * of recounting the whole chunk on every merge.
 */
const HEADING_PIECE = /^#{1,6}[ \t][^\n]*$/;
const isHeadingPiece = (p: Piece) => HEADING_PIECE.test(p.text.trim());

function greedyMerge(pieces: Piece[], target: number, headingsLead = false): Run[] {
  if (pieces.length === 0) return [];

  const result: Run[] = [];
  const limit = Math.ceil(target * 1.5);
  const runOf = (p: Piece): Run => ({ text: p.text, segs: [{ t: 0, s: p.s, n: p.text.length }] });
  let current = runOf(pieces[0]);
  let currentStats = wordStats(current.text);

  for (let i = 1; i < pieces.length; i++) {
    const pieceStats = wordStats(pieces[i].text);
    const combinedStats = concatWordStats(currentStats, pieceStats);
    // A run of heading pieces is checked once, at its first piece, together with the piece after the run.
    let leads = false;
    if (headingsLead && isHeadingPiece(pieces[i]) && !isHeadingPiece(pieces[i - 1])) {
      let runStats = combinedStats;
      let j = i + 1;
      for (; j < pieces.length && isHeadingPiece(pieces[j]); j++) runStats = concatWordStats(runStats, wordStats(pieces[j].text));
      if (j < pieces.length) runStats = concatWordStats(runStats, wordStats(pieces[j].text));
      leads = j < pieces.length && wordCountOf(runStats) > limit;
    }
    if (!leads && wordCountOf(combinedStats) <= limit) {
      // `current` is this loop's own run: extend it in place (copying its segs per merge is quadratic in
      // pieces per chunk), and grow the last seg when the piece follows it directly in the projected text.
      const last = current.segs[current.segs.length - 1];
      if (last.s + last.n === pieces[i].s) last.n += pieces[i].text.length;
      else current.segs.push({ t: current.text.length, s: pieces[i].s, n: pieces[i].text.length });
      current.text += pieces[i].text;
      currentStats = combinedStats;
    } else {
      result.push(current);
      current = runOf(pieces[i]);
      currentStats = pieceStats;
    }
  }

  if (current.text.trim().length > 0) {
    result.push(current);
  }

  return result;
}

/**
 * Apply sentence-aware trailing overlap.
 * The last N words of chunk[i] are prepended to chunk[i+1].
 */
function applyOverlap(chunks: Run[], overlapWords: number): Run[] {
  if (chunks.length <= 1 || overlapWords <= 0) return chunks;

  const result: Run[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const prevTrailing = extractTrailingContext(prev.text, overlapWords);
    // The trailing context is always a suffix of the previous chunk; a run
    // whose suffix cannot be traced keeps its text and loses its span.
    const tail = prev.text.endsWith(prevTrailing)
      ? sliceRun(prev, prev.text.length - prevTrailing.length, prev.text.length)
      : { text: prevTrailing, segs: [] };
    result.push(joinRuns(tail, chunks[i]));
  }

  return result;
}

/**
 * Extract the last N words from text, trying to align to sentence boundaries.
 * If a sentence boundary exists within the last N words, start there.
 */
function extractTrailingContext(text: string, targetWords: number): string {
  // CJK-dominant chunks count chars, not whitespace tokens (see countWords);
  // the whitespace path below would return '' (whole chunk = one token) or
  // duplicate most of the chunk. English path is unchanged.
  if (isCJKDominant(text)) return extractTrailingContextCJK(text, targetWords);

  const words = text.match(/\S+\s*/g) || [];
  if (words.length <= targetWords) return '';

  const trailing = words.slice(-targetWords).join('');

  // Try to find a sentence boundary to start from
  const sentenceStart = trailing.search(/[.!?]\s+/);
  if (sentenceStart !== -1 && sentenceStart < trailing.length / 2) {
    // Start after the sentence boundary
    const afterSentence = trailing.slice(sentenceStart).replace(/^[.!?]\s+/, '');
    if (afterSentence.trim().length > 0) {
      return afterSentence;
    }
  }

  return trailing;
}

/**
 * Sentence end for the CJK overlap aligner: a CJK delimiter needs no trailing
 * whitespace; an ASCII one still does, so "3.5" inside CJK prose is not a
 * boundary.
 */
const CJK_SENTENCE_END = new RegExp(`[${CJK_SENTENCE_DELIMITERS.join('')}]\\s*|[.!?]\\s+`);

/**
 * CJK-dominant twin of extractTrailingContext: walks back targetWords
 * non-whitespace code units (the unit countCJKAwareWords counts), then
 * aligns to a sentence end the same way. Changes chunk boundaries only for
 * CJK-dominant pages chunked from now on; re-chunking existing pages needs a
 * MARKDOWN_CHUNKER_VERSION bump (see TODOS.md).
 */
function extractTrailingContextCJK(text: string, targetWords: number): string {
  if (countCJKAwareWords(text) <= targetWords) return '';

  let count = 0;
  let i = text.length;
  while (i > 0 && count < targetWords) {
    i--;
    if (!/\s/.test(text[i])) count++;
  }
  // Code-unit walk can stop between an astral pair's halves; move the cut to
  // the pair start (one extra overlap char beats a lone surrogate).
  const trailing = text.slice(safeSplitIndex(text, i));

  const sentenceEnd = CJK_SENTENCE_END.exec(trailing);
  if (sentenceEnd && sentenceEnd.index < trailing.length / 2) {
    const afterSentence = trailing.slice(sentenceEnd.index + sentenceEnd[0].length);
    if (afterSentence.trim().length > 0) return afterSentence;
  }

  return trailing;
}

/**
 * Word count, CJK-aware (v0.32.7). For Latin-dominant text this behaves
 * exactly like the historical `text.match(/\S+/g).length`. When CJK char
 * density exceeds CJK_DENSITY_THRESHOLD (30%), each non-whitespace char is
 * counted as one "word" so the chunker actually splits CJK paragraphs
 * (whitespace-tokenization counts a whole Chinese paragraph as 1 word,
 * letting it overflow the OpenAI embedding token limit).
 *
 * Delegated to src/core/cjk.ts so the slugify whitelist, expansion
 * detection, and PGLite keyword fallback all agree on what "CJK enough"
 * means.
 */
function countWords(text: string): number {
  return countCJKAwareWords(text);
}
