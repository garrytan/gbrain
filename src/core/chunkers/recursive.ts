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
 * v0.42.70 (issue #3037): CJK-dense content gets a token-aware cap.
 * The embedder limits by TOKENS not characters; for CJK text 1 char ≈ 1
 * token, so a 6000-char CJK chunk can be ~6000 tokens and get silently
 * rejected (exit 0, never embedded). The chunker now detects CJK density
 * and applies a tighter char budget (3000 chars for CJK-dominant text)
 * so chunks stay under the typical 8192-token limit.
 *
 * Lossless invariant: non-overlapping portions reassemble to original.
 */

import { countCJKAwareWords, CJK_SENTENCE_DELIMITERS, CJK_CLAUSE_DELIMITERS, CJK_DENSITY_THRESHOLD, hasCJK } from '../cjk.ts';

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

  // v0.42.70 (issue #3037): detect CJK density upfront so we can apply
  // a token-aware cap. CJK text has ~1 char/token ratio vs ~3.5 chars/
  // token for English; the same char cap produces very different token
  // counts. We compute an effective char cap that accounts for CJK
  // density, ensuring chunks stay under the embedder's token limit.
  const effectiveMaxChars = computeEffectiveMaxChars(stripped, maxChars);

  const wordCount = countWords(stripped);
  if (wordCount <= chunkSize) {
    // Single-chunk path: still apply the CJK-aware maxChars cap.
    const capped = capByChars(stripped.trim(), effectiveMaxChars);
    return capped.map((t, i) => ({ text: t, index: i }));
  }

  // Recursively split, then greedily merge to target size
  const pieces = recursiveSplit(stripped, 0, chunkSize);
  const merged = greedyMerge(pieces, chunkSize);
  const withOverlap = applyOverlap(merged, chunkOverlap);
  // v0.32.7: hard char cap. Catches pathological CJK + whitespace-less text
  // that the word-level pipeline can't bound (a single Chinese paragraph can
  // exceed 8192 OpenAI embedding tokens at any word count).
  //
  // v0.42.70 (issue #3037): use the CJK-aware effective cap. CJK-dense
  // chunks need a tighter char budget because 1 CJK char ≈ 1 token (vs
  // 3.5 chars/token for English). Without this, a 6000-char CJK chunk
  // would be ~6000 tokens, dangerously close to the 8192-token limit.
  const capped: string[] = [];
  for (const chunk of withOverlap) {
    capped.push(...capByChars(chunk.trim(), effectiveMaxChars));
  }
  return capped.map((t, i) => ({ text: t, index: i }));
}

/**
 * Compute an effective char cap that accounts for CJK token density
 * (issue #3037).
 *
 * The embedder limits by TOKENS, not characters. For English text,
 * ~3.5 chars = 1 token; for CJK text, ~1 char = 1 token. The default
 * maxChars (6000) is safe for English (≈1714 tokens) but dangerous for
 * CJK (≈6000 tokens, close to the 8192-token limit).
 *
 * This function detects CJK density and scales the cap proportionally:
 * - CJK density < 0.30: keep original maxChars (Latin-dominant)
 * - CJK density ≥ 0.30: scale cap by density / CJK_DENSITY_THRESHOLD
 *   so that at full CJK density (1.0), the cap is maxChars * 0.30
 *   ≈ 1800 chars, keeping chunks well under the 8192-token limit.
 *
 * The formula: effectiveMaxChars = maxChars * (CJK_DENSITY_THRESHOLD / density)
 * clamped to [500, maxChars].
 */
function computeEffectiveMaxChars(text: string, maxChars: number): number {
  const cjkMatches = text.match(new RegExp(`[${'一-鿿぀-ゟ゠-ヿ가-힯'}]`, 'g'));
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonWhitespace = text.replace(/\s/g, '').length;
  if (nonWhitespace === 0) return maxChars;
  const density = cjkCount / nonWhitespace;
  if (density < CJK_DENSITY_THRESHOLD) return maxChars;
  // CJK-dominant: scale down the char cap. At density=1.0 (pure CJK),
  // effective = maxChars * (0.30 / 1.0) = maxChars * 0.30 ≈ 1800 chars.
  // This keeps chunks well under the 8192-token embedder limit.
  const scaleFactor = CJK_DENSITY_THRESHOLD / density;
  const scaled = Math.floor(maxChars * scaleFactor);
  // Never exceed the original cap; never go below a minimum useful size.
  return Math.max(500, Math.min(maxChars, scaled));
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
