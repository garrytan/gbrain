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

import { countCJKAwareWords, CJK_SENTENCE_DELIMITERS, CJK_CLAUSE_DELIMITERS } from '../cjk.ts';

/**
 * Markdown chunker version. Folded into the per-page chunker_version column
 * so post-upgrade reindex sweeps can find pages built with old chunkers and
 * rebuild them on the new shape. Bump on any change that affects chunk
 * boundaries (delimiters, word counting, maxChars cap).
 */
export const MARKDOWN_CHUNKER_VERSION = 2;

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

export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  const chunkSize = opts?.chunkSize || 300;
  const chunkOverlap = opts?.chunkOverlap || 50;
  const maxChars = opts?.maxChars || 6000;

  if (!text || text.trim().length === 0) return [];

  // v0.28: strip fenced takes blocks BEFORE chunking. Takes are retrieval-
  // accessible only via the takes table; their content must not appear in
  // content_chunks where the per-token allow-list cannot reach. The
  // takes_fence_chunk_leak doctor check verifies this invariant.
  const stripped = stripTakesFence(text);
  if (!stripped || stripped.trim().length === 0) return [];

  const wordCount = countWords(stripped);
  if (wordCount <= chunkSize) {
    // Single-chunk path: still apply the maxChars cap.
    const capped = capByChars(stripped.trim(), maxChars);
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
    capped.push(...capByChars(chunk.trim(), maxChars));
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
