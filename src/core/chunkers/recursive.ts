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
 *
 * Lossless invariant: non-overlapping portions reassemble to original.
 */

import {
  countCJKAwareWords,
  CJK_SENTENCE_DELIMITERS,
  CJK_CLAUSE_DELIMITERS,
  charEmbedTokenWeight,
  estimateEmbeddingTokens,
} from '../cjk.ts';

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
 *
 * v4: estimated-token hard cap + whitespace-word undercount fix. The word
 * pipeline counted a 150-char URL as ONE whitespace word, so URL/phone/
 * email-dense docs (CJK density < 0.30 → whitespace fallback) produced
 * 3-4K-char chunks that overflow strict per-request embedding-token
 * limits (measured: local llama-server crashes past ~2,050 tokens; URL
 * soup tokenizes at ~1.6 chars/token). Two changes:
 *   1. countWords() floors the count at ceil(nonWhitespaceChars/6) so a
 *      URL counts roughly per-character, not as one word.
 *   2. capByEstimatedTokens() final pass guarantees every chunk fits
 *      `maxTokens` (default 1500) under a conservative per-char-class
 *      token estimate, regardless of how word counting misjudged it.
 */
export const MARKDOWN_CHUNKER_VERSION = 4;

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
   * v4: hard cap on any chunk's ESTIMATED embedding tokens (default 1500).
   * Estimate = conservative per-char-class weights (see cjk.ts
   * estimateEmbeddingTokens) — deliberately high, so the real tokenizer
   * count stays below this value. Default leaves headroom for the
   * contextual-retrieval wrapper (≤ ~630 chars) under a ~2,050-token
   * per-request embedding server limit.
   */
  maxTokens?: number;
}

/** v4 default for ChunkOptions.maxTokens — see the field doc above. */
export const DEFAULT_MAX_EST_TOKENS = 1500;

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
  const maxTokens = opts?.maxTokens || DEFAULT_MAX_EST_TOKENS;

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
    // Single-chunk path: still apply the maxChars + maxTokens caps.
    const capped = capByChars(stripped.trim(), maxChars)
      .flatMap((t) => capByEstimatedTokens(t, maxTokens));
    return capped.map((t, i) => ({ text: t, index: i }));
  }

  // Recursively split, then greedily merge to target size
  const pieces = recursiveSplit(stripped, 0, chunkSize);
  const merged = greedyMerge(pieces, chunkSize);
  const withOverlap = applyOverlap(merged, chunkOverlap);
  // v0.32.7: hard char cap. Catches pathological CJK + whitespace-less text
  // that the word-level pipeline can't bound (a single Chinese paragraph can
  // exceed 8192 OpenAI embedding tokens at any word count).
  // v4: estimated-token cap on top — the char cap alone passes token-dense
  // content (URL soup at ~1.6 chars/token) that overflows strict embedding
  // server limits.
  const capped: string[] = [];
  for (const chunk of withOverlap) {
    for (const piece of capByChars(chunk.trim(), maxChars)) {
      capped.push(...capByEstimatedTokens(piece, maxTokens));
    }
  }
  return capped.map((t, i) => ({ text: t, index: i }));
}

/**
 * Hard-cap a chunk's char length via a sliding window. Returns the input
 * unchanged when it's already ≤ maxChars.
 *
 * Overlap is min(500, maxChars/10) so successive windows preserve semantic
 * continuity across the cut.
 *
 * v0.32.7. BMP-only safe (does not split astral surrogate pairs in practice
 * because declared CJK ranges are all BMP; widening to astral Han support
 * is a v0.33+ follow-up that requires Array.from-style codepoint iteration).
 */
function capByChars(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text.length > 0 ? [text] : [];
  const overlap = Math.min(500, Math.floor(maxChars / 10));
  const stride = Math.max(1, maxChars - overlap);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += stride) {
    const slice = text.slice(i, i + maxChars).trim();
    if (slice.length > 0) out.push(slice);
    if (i + maxChars >= text.length) break;
  }
  return out;
}

/**
 * How far back (in chars) the token cap looks for a friendly cut point
 * before falling back to a hard cut. 300 covers typical rollup/list line
 * lengths so forced splits land at line starts, not mid-URL.
 */
const TOKEN_CAP_CUT_LOOKBACK = 300;

/**
 * v4: hard-cap a chunk's ESTIMATED embedding tokens. Final safety pass —
 * runs after capByChars on every chunk, so no upstream miscounting
 * (whitespace-word fallback, overlap inflation, char-cap survivors) can
 * emit a chunk past `maxTokens`.
 *
 * Cut placement prefers, within the last TOKEN_CAP_CUT_LOOKBACK chars of
 * the window: a newline, then any whitespace, then a hard cut. This keeps
 * forced splits off mid-line/mid-URL positions for list-shaped content
 * and inside code fences. No overlap is added (pieces stay lossless
 * modulo the trims the char cap already applies).
 *
 * @internal exported for the code chunker (code.ts) and tests.
 */
export function capByEstimatedTokens(text: string, maxTokens: number): string[] {
  if (text.length === 0) return [];
  if (estimateEmbeddingTokens(text) <= maxTokens) return [text];

  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    // Greedily extend the window until the next char would break the cap.
    // Always take at least one char so the loop makes forward progress.
    let est = 0;
    let end = start;
    while (end < text.length) {
      const w = charEmbedTokenWeight(text.charCodeAt(end));
      if (est + w > maxTokens && end > start) break;
      est += w;
      end++;
    }

    if (end < text.length) {
      const windowStart = Math.max(start + 1, end - TOKEN_CAP_CUT_LOOKBACK);
      let cut = text.lastIndexOf('\n', end - 1);
      if (cut < windowStart) {
        cut = -1;
        for (let i = end - 1; i >= windowStart; i--) {
          const code = text.charCodeAt(i);
          if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) {
            cut = i;
            break;
          }
        }
      }
      if (cut >= windowStart) end = cut + 1;
    }

    const slice = text.slice(start, end).trim();
    if (slice.length > 0) out.push(slice);
    start = end;
  }
  return out;
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
 *
 * v4: floored at ceil(nonWhitespaceChars/6). The whitespace fallback
 * counts a 150-char URL as ONE word, so URL/phone/email-dense docs
 * (whose ASCII mass pushes CJK density below the 0.30 threshold) were
 * sized at a fraction of their real bulk and merged into 3-4K-char
 * chunks. The floor makes long whitespace-less runs count roughly
 * per-character while leaving normal Latin prose untouched (average
 * English word ≈ 5 chars < 6, so the whitespace count still wins).
 * Kept local to the chunker — search/expansion.ts keeps the original
 * countCJKAwareWords semantics for its query-length check.
 */
function countWords(text: string): number {
  const cjkAware = countCJKAwareWords(text);
  const nonWhitespace = text.replace(/\s/g, '').length;
  return Math.max(cjkAware, Math.ceil(nonWhitespace / 6));
}
