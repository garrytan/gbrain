/**
 * Recursive Delimiter-Aware Text Chunker
 * Ported from production Ruby implementation (text_chunker.rb, 205 LOC)
 *
 * 5-level delimiter hierarchy:
 *   1. Paragraphs (\n\n)
 *   2. Lines (\n)
 *   3. Sentences (. ! ? followed by space or newline; CJK 。！？)
 *   4. Clauses (; : , ; CJK ；：，、)
 *   5. Words (whitespace; or codepoint slicing for CJK / no-space text)
 *
 * Config: 300-word chunks with 50-word sentence-aware overlap.
 *
 * Boundary trim: each emitted chunk's text is `.trim()`-ed (see chunkText
 * tail and splitAtDelimiters), so delimiter whitespace at chunk boundaries
 * — most commonly a trailing `\n` after a sentence-ending `。`/`!`/`?` —
 * is dropped from chunk content. The chunk sequence still covers the
 * original text modulo this whitespace; the invariant is "no semantic
 * loss" (every non-whitespace token of the source appears in some chunk),
 * NOT "byte-exact reassembly". Loss is bounded by O(chunks.length) outer
 * whitespace chars, never per-character content drift.
 *
 * v2 (PROSE_CHUNKER_VERSION) — CJK awareness:
 *   - countWords() counts each CJK char as 1 word, plus ASCII whitespace words
 *   - DELIMITERS extended with CJK punctuation
 *   - Level-4 fallback uses codepoint-slicing for CJK / no-space text so the
 *     chunker can ALWAYS reduce a piece below the target word count.
 *
 * Why bump PROSE_CHUNKER_VERSION: importFromContent's content_hash
 * short-circuits unchanged pages. Folding the version into that hash
 * forces existing affected pages to re-chunk on next put_page (one-time
 * mass re-embed cost; repairs the 158 pages where dense CJK paragraphs
 * collapsed to a single 8192+ token chunk that OpenAI rejected).
 */

/**
 * Recursive prose chunker version. Folded into content_hash by
 * import-file.ts so a bump forces re-chunking of every markdown page on
 * its next put_page. Bump whenever the chunking *shape* changes (delimiter
 * set, fallback strategy, word counting), not for cosmetic refactors.
 */
export const PROSE_CHUNKER_VERSION = 2;

// CJK char range used everywhere in this module.
// Mirrors src/core/search/expansion.ts so query-time and index-time
// CJK detection stay consistent.
const CJK_RE = /[一-鿿぀-ゟ゠-ヿ가-힯]/;
const CJK_RE_GLOBAL = /[一-鿿぀-ゟ゠-ヿ가-힯]/g;

// Ordering note: within each level, LONGER delimiters MUST appear before
// shorter ones that are their prefix. splitAtDelimiters picks the earliest
// match index and breaks ties by *array order* (first wins). If we listed
// '。' before '。\n', a string like '甲乙。\n丙丁' matches '。' at index 2
// and the trailing '\n' leaks into the *next* piece, where trim() drops it
// — losing one char per CJK sentence boundary across the document. Same for
// '！\n' / '？\n' on L2 and any '<punct>\n' shapes added in the future.
const DELIMITERS: string[][] = [
  ["\n\n"], // L0: paragraphs
  ["\n"], // L1: lines
  // L2: sentence boundaries — '<punct>\n' BEFORE bare '<punct>' so the
  // newline stays attached. '. ' / '! ' / '? ' don't share a prefix with
  // any other entry, so their order is incidental.
  [
    "。\n",
    "！\n",
    "？\n",
    ".\n",
    "!\n",
    "?\n", // L2: sentences w/ trailing newline
    ". ",
    "! ",
    "? ", //     ASCII sentence + space
    "。",
    "！",
    "？",
  ], //     bare CJK sentence punct
  // L3: clause boundaries. None of the entries are prefixes of another
  // today, but we keep the longer-first convention so a future '，\n'
  // addition slots in correctly without resurrecting the L2 bug.
  [
    "; ",
    ": ",
    ", ", // L3: ASCII clauses
    "；",
    "：",
    "，",
    "、",
  ], //     CJK clauses
  [], // L4: words (whitespace or codepoint split)
];

export interface ChunkOptions {
  chunkSize?: number; // target words per chunk (default 300)
  chunkOverlap?: number; // overlap words (default 50)
}

export interface TextChunk {
  text: string;
  index: number;
}

export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  const chunkSize = opts?.chunkSize || 300;
  const chunkOverlap = opts?.chunkOverlap || 50;

  if (!text || text.trim().length === 0) return [];

  const wordCount = countWords(text);
  if (wordCount <= chunkSize) {
    return [{ text: text.trim(), index: 0 }];
  }

  // Recursively split, then greedily merge to target size
  const pieces = recursiveSplit(text, 0, chunkSize);
  const merged = greedyMerge(pieces, chunkSize);
  const withOverlap = applyOverlap(merged, chunkOverlap);

  return withOverlap.map((t, i) => ({ text: t.trim(), index: i }));
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
    let earliestDelim = "";

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

  return pieces.filter((p) => p.trim().length > 0);
}

/**
 * Fallback: split on whitespace boundaries to hit target word count.
 *
 * For CJK / no-space text, falls back to codepoint slicing — every `target`
 * codepoints becomes a piece. Without this, dense CJK prose with no
 * delimiters would return as one giant piece and blow OpenAI's 8192-token
 * embedding limit (this is the bug repaired by PROSE_CHUNKER_VERSION=2).
 */
function splitOnWhitespace(text: string, target: number): string[] {
  // CJK or no-whitespace text: codepoint-slice.
  // We use Array.from() to iterate codepoints (handles surrogate pairs);
  // slicing by string indices would split astral characters mid-pair.
  if (CJK_RE.test(text) || !/\s/.test(text.trim())) {
    const codepoints = Array.from(text);
    if (codepoints.length === 0) return [];
    const pieces: string[] = [];
    for (let i = 0; i < codepoints.length; i += target) {
      const slice = codepoints.slice(i, i + target).join("");
      if (slice.trim().length > 0) {
        pieces.push(slice);
      }
    }
    return pieces;
  }

  // Pure-ASCII / space-delimited: original whitespace behavior.
  const words = text.match(/\S+\s*/g) || [];
  if (words.length === 0) return [];

  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += target) {
    const slice = words.slice(i, i + target).join("");
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
  if (words.length <= targetWords) return "";

  const trailing = words.slice(-targetWords).join("");

  // Try to find a sentence boundary to start from
  const sentenceStart = trailing.search(/[.!?]\s+/);
  if (sentenceStart !== -1 && sentenceStart < trailing.length / 2) {
    // Start after the sentence boundary
    const afterSentence = trailing
      .slice(sentenceStart)
      .replace(/^[.!?]\s+/, "");
    if (afterSentence.trim().length > 0) {
      return afterSentence;
    }
  }

  return trailing;
}

/**
 * Count "words" in a script-aware way:
 *   - each CJK character (Han, Hiragana, Katakana, Hangul) counts as 1 word
 *   - remaining text (after CJK chars are stripped) is counted by
 *     whitespace-delimited tokens
 *   - degenerate "long no-space, no-CJK" inputs (emoji ZWJ sequences,
 *     combining marks like 'é', non-BMP CJK like Han Extension B that
 *     falls outside the BMP CJK_RE block) get a codepoint-count floor
 *     so they don't slip past chunkText's `wordCount <= chunkSize` early
 *     exit as a single oversized chunk
 *
 * Mirrors the CJK detection used in src/core/search/expansion.ts so that
 * query-time and index-time word counts stay aligned.
 */
export function countWords(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_RE_GLOBAL);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const ascii = text.replace(CJK_RE_GLOBAL, " ");
  const asciiCount = (ascii.match(/\S+/g) || []).length;
  const base = cjkCount + asciiCount;

  // Codepoint-count floor for degenerate inputs.
  //
  // The chunker's recursive pipeline relies on `wordCount > chunkSize` to
  // decide a piece needs further splitting. Three input shapes silently
  // defeat that signal pre-fix and return a single oversized chunk:
  //
  //   1. emoji ZWJ sequences ('👨‍👩‍👧‍👦'.repeat(1000)) — `\S+` matches the
  //      whole 7000-codepoint blob as 1 token, no CJK_RE hits, base=1.
  //   2. combining marks ('é'.repeat(2000)) — same shape, base=1.
  //   3. Han Extension B ('𠀀'.repeat(1000)) — non-BMP, sits outside the
  //      U+4E00-U+9FFF block CJK_RE matches, so cjkCount=0, base=1.
  //
  // All three blow OpenAI's 8192-token embedding ceiling on a single
  // chunk. The floor below forces wordCount above chunkSize for any
  // sufficiently long single-token, no-CJK input, so chunkText drops
  // into recursiveSplit → splitOnWhitespace's codepoint-slicing branch.
  //
  // Constraint: must NOT regress ASCII baselines. We only apply the
  // floor when the trimmed text is non-empty AND has NO whitespace AND
  // no CJK match — i.e. it genuinely is one long codepoint blob. Short
  // inputs ('hello', 'word') trivially pass `wordCount <= chunkSize`
  // either way, so promoting their count from 1 to 5 is harmless.
  // Whitespace-bearing ASCII ('word '.repeat(500)) keeps the original
  // asciiCount path. Whitespace-only inputs ('   ') stay at 0 — the
  // outer trim()-non-empty guard catches them so we don't accidentally
  // count whitespace codepoints.
  const trimmed = text.trim();
  if (trimmed.length > 0 && cjkCount === 0 && !/\s/.test(trimmed)) {
    const codepointCount = Array.from(text).length;
    return Math.max(base, codepointCount);
  }

  return base;
}
