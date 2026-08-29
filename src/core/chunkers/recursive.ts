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

import { countCJKAwareWords, CJK_SENTENCE_DELIMITERS, CJK_CLAUSE_DELIMITERS } from '../cjk.ts';
import { estimateEmbedTokens, DEFAULT_MAX_CHUNK_TOKENS } from './token-estimate.ts';
import { safeSplitIndex } from '../text-safe.ts';

/**
 * Markdown chunker version. Folded into the per-page chunker_version column
 * so post-upgrade reindex sweeps can find pages built with old chunkers and
 * rebuild them on the new shape. Bump on any change that affects chunk
 * boundaries (delimiters, word counting, maxChars cap) OR the per-chunk
 * embedding shape (wrapper prefix added at embed time).
 *
 * v3 (v0.40.3.0): chunks embed with optional contextual retrieval wrapper
 * per Anthropic's published methodology. Wrapper is built JUST IN TIME at
 * embed call; stored `content_chunks.chunk_text` stays canonical. Chunk
 * boundaries themselves are unchanged from v2 — bumping the version forces
 * re-embed (not re-chunk) so existing pages pick up the wrapper on the
 * post-upgrade reembed sweep. See
 * `src/core/contextual-retrieval-service.ts`.
 */
export const MARKDOWN_CHUNKER_VERSION = 3;

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
}

export interface TextChunk {
  text: string;
  index: number;
}

// v0.28: import takes-fence stripper as a pre-processing pass. Takes content
// lives in the takes table only; duplicating it inside content_chunks would
// bypass the per-token MCP allow-list (Codex P0 #3 privacy fix).
import { stripTakesFence } from '../takes-fence.ts';

// v0.32.2 (Codex R2-#1 P0): same posture for facts — private fact rows must
// not reach content_chunks.chunk_text, embeddings, or search. Pass
// `keepVisibility: ['world']` so world-visibility facts remain searchable
// (they're public knowledge by definition) while private rows are stripped
// at the row level. The fence shell stays in the chunked body so callers
// that re-import the chunk content can still parse it; only the private
// rows go.
import { stripFactsFence } from '../facts-fence.ts';

export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  const chunkSize = opts?.chunkSize || 300;
  const chunkOverlap = opts?.chunkOverlap || 50;
  const maxChars = opts?.maxChars || 6000;
  // #4530: per-call token budget, clamped to the historical default so a
  // misconfigured larger value can't emit chunks the rest of the pipeline
  // (tsvector limits, context assembly) was never sized for.
  const maxTokens = opts?.maxTokens && opts.maxTokens > 0
    ? Math.min(opts.maxTokens, DEFAULT_MAX_CHUNK_TOKENS)
    : DEFAULT_MAX_CHUNK_TOKENS;

  if (!text || text.trim().length === 0) return [];

  // v0.28: strip fenced takes blocks BEFORE chunking. Takes are retrieval-
  // accessible only via the takes table; their content must not appear in
  // content_chunks where the per-token allow-list cannot reach. The
  // takes_fence_chunk_leak doctor check verifies this invariant.
  //
  // v0.32.2: also strip private facts (Codex R2-#1). World facts stay so
  // search retains its public-knowledge surface; private rows are filtered
  // out at the fence-row level via stripFactsFence({keepVisibility:['world']}).
  const stripped = stripFactsFence(stripTakesFence(text), { keepVisibility: ['world'] });
  if (!stripped || stripped.trim().length === 0) return [];

  const wordCount = countWords(stripped);
  if (wordCount <= chunkSize) {
    // Single-chunk path: still apply the maxChars cap.
    const capped = capByChars(stripped.trim(), maxChars, maxTokens);
    return capped.map((t, i) => ({ text: t, index: i }));
  }

  // Recursively split, then greedily merge to target size
  const pieces = recursiveSplit(stripped, 0, chunkSize);
  const merged = greedyMerge(pieces, chunkSize);
  const withOverlap = applyOverlap(merged, chunkOverlap);
  // v0.32.7: hard char cap. Catches pathological CJK + whitespace-less text
  // that the word-level pipeline can't bound (a single Chinese paragraph can
  // exceed 8192 OpenAI embedding tokens at any word count).
  const capped: string[] = [];
  for (const chunk of withOverlap) {
    capped.push(...capByChars(chunk.trim(), maxChars, maxTokens));
  }
  return capped.map((t, i) => ({ text: t, index: i }));
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
): string[] {
  if (text.length === 0) return [];
  const est = knownEst ?? probeEmbedTokens(text);
  const window = est <= maxTokens
    ? maxChars
    : Math.max(1, Math.min(maxChars, Math.floor((text.length * maxTokens) / est)));
  if (text.length <= window) {
    // Emitting the text whole is the one path that skips the per-slice
    // re-check below, so a PROBED estimate has to be confirmed exactly first:
    // a sparse ASCII head can under-read a dense CJK tail.
    if (knownEst !== undefined || text.length <= DENSITY_PROBE_CHARS) return [text];
    const exact = estimateEmbedTokens(text);
    return exact <= maxTokens ? [text] : capByChars(text, maxChars, maxTokens, exact);
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
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = safeSplitIndex(text, Math.min(text.length, i + window));
    const slice = text.slice(i, end).trim();
    if (slice.length > 0) {
      const sliceEst = estimateEmbedTokens(slice);
      if (sliceEst > maxTokens) {
        // Denser than the text average — re-derive locally, reusing the exact
        // figure just measured (it also guarantees window < slice.length, so
        // the recursion strictly shrinks).
        out.push(...capByChars(slice, maxChars, maxTokens, sliceEst));
      } else {
        out.push(slice);
      }
    }
    if (end >= text.length) break;
    const next = safeSplitIndex(text, Math.min(text.length, i + stride));
    i = next > i ? next : i + 1;
  }
  return out;
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

function recursiveSplit(text: string, level: number, target: number): string[] {
  if (level >= DELIMITERS.length) {
    // Level 4: split on whitespace
    return splitOnWhitespace(text, target);
  }

  const delimiters = DELIMITERS[level];
  if (delimiters.length === 0) {
    return splitOnWhitespace(text, target);
  }

  const pieces = splitAtDelimiters(text, delimiters);

  // If splitting didn't help (only 1 piece), try next level
  if (pieces.length <= 1) {
    return recursiveSplit(text, level + 1, target);
  }

  // Check if any piece is still too large, recurse deeper
  const result: string[] = [];
  for (const piece of pieces) {
    if (countWords(piece) > target) {
      result.push(...recursiveSplit(piece, level + 1, target));
    } else {
      result.push(piece);
    }
  }

  return result;
}

/**
 * Split text at delimiter boundaries, preserving delimiters at the end
 * of the piece that precedes them (lossless).
 */
function splitAtDelimiters(text: string, delimiters: string[]): string[] {
  const pieces: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let earliest = -1;
    let earliestDelim = '';

    for (const delim of delimiters) {
      const idx = remaining.indexOf(delim);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        earliestDelim = delim;
      }
    }

    if (earliest === -1) {
      pieces.push(remaining);
      break;
    }

    // Include the delimiter with the preceding text
    const piece = remaining.slice(0, earliest + earliestDelim.length);
    if (piece.trim().length > 0) {
      pieces.push(piece);
    }
    remaining = remaining.slice(earliest + earliestDelim.length);
  }

  // Handle trailing content
  if (remaining.trim().length > 0 && !pieces.includes(remaining)) {
    // Already added above
  }

  return pieces.filter(p => p.trim().length > 0);
}

/**
 * Fallback: split on whitespace boundaries to hit target word count.
 * v0.32.7: when the input is whitespace-less or any single "word" exceeds
 * the target (CJK paragraph, base64 blob, long URL), slice on character
 * boundaries so we still bound chunk size and the chunker makes forward
 * progress. The downstream maxChars cap tightens this further.
 */
function splitOnWhitespace(text: string, target: number): string[] {
  const words = text.match(/\S+\s*/g) || [];

  // No whitespace tokens, OR a single token longer than `target` chars
  // (greedy /\S+/g returns a CJK paragraph as one "word"). Slice by char.
  const noUsefulWhitespace =
    words.length === 0 || (words.length === 1 && words[0].length > target);
  if (noUsefulWhitespace) {
    if (text.trim().length === 0) return [];
    const pieces: string[] = [];
    const charsPerPiece = Math.max(1, target);
    for (let i = 0; i < text.length; i += charsPerPiece) {
      const slice = text.slice(i, i + charsPerPiece);
      if (slice.trim().length > 0) pieces.push(slice);
    }
    return pieces;
  }

  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += target) {
    const slice = words.slice(i, i + target).join('');
    if (slice.trim().length > 0) {
      pieces.push(slice);
    }
  }
  return pieces;
}

/**
 * Greedily merge adjacent pieces until each chunk is near the target size.
 * Avoids creating chunks larger than target * 1.5.
 */
function greedyMerge(pieces: string[], target: number): string[] {
  if (pieces.length === 0) return [];

  const result: string[] = [];
  let current = pieces[0];

  for (let i = 1; i < pieces.length; i++) {
    const combined = current + pieces[i];
    if (countWords(combined) <= Math.ceil(target * 1.5)) {
      current = combined;
    } else {
      result.push(current);
      current = pieces[i];
    }
  }

  if (current.trim().length > 0) {
    result.push(current);
  }

  return result;
}

/**
 * Apply sentence-aware trailing overlap.
 * The last N words of chunk[i] are prepended to chunk[i+1].
 */
function applyOverlap(chunks: string[], overlapWords: number): string[] {
  if (chunks.length <= 1 || overlapWords <= 0) return chunks;

  const result: string[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prevTrailing = extractTrailingContext(chunks[i - 1], overlapWords);
    result.push(prevTrailing + chunks[i]);
  }

  return result;
}

/**
 * Extract the last N words from text, trying to align to sentence boundaries.
 * If a sentence boundary exists within the last N words, start there.
 */
function extractTrailingContext(text: string, targetWords: number): string {
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
