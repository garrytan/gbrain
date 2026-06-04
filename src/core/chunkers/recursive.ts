/**
 * Recursive Delimiter-Aware Text Chunker
 * Ported from production Ruby implementation (text_chunker.rb, 205 LOC)
 *
 * 5-level delimiter hierarchy:
 *   1. Paragraphs (\n\n)
 *   2. Lines (\n)
 *   3. Sentences (. ! ? followed by space or newline)
 *   4. Clauses (; : , )
 *   5. Words (whitespace)
 *
 * Default config: Qwen3-oriented 768-token chunks with 128-token overlap.
 * Explicit chunkSize/chunkOverlap options preserve the legacy word budget.
 * Lossless invariant: non-overlapping portions reassemble to original.
 */

import { estimateTokenCount } from '../token-count.ts';

export const DEFAULT_QWEN3_CHUNK_SIZE_TOKENS = 768;
export const DEFAULT_QWEN3_CHUNK_OVERLAP_TOKENS = 128;

const DELIMITERS: string[][] = [
  ['\n\n'],                          // L0: paragraphs
  ['\n'],                            // L1: lines
  ['. ', '! ', '? ', '.\n', '!\n', '?\n'], // L2: sentences
  ['; ', ': ', ', '],                // L3: clauses
  [],                                // L4: words (whitespace split)
];

export interface ChunkOptions {
  chunkSize?: number;    // target words per chunk (default 300)
  chunkOverlap?: number; // overlap words (default 50)
  chunkSizeTokens?: number;
  chunkOverlapTokens?: number;
  estimateTokens?: (text: string) => number;
}

export interface TextChunk {
  text: string;
  index: number;
  token_count?: number;
}

export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  const useTokenBudget = opts?.chunkSizeTokens !== undefined
    || opts?.chunkOverlapTokens !== undefined
    || (opts?.chunkSize === undefined && opts?.chunkOverlap === undefined);
  const measure = useTokenBudget
    ? (opts?.estimateTokens ?? estimateTokenCount)
    : countWords;
  const chunkSize = useTokenBudget
    ? opts?.chunkSizeTokens || DEFAULT_QWEN3_CHUNK_SIZE_TOKENS
    : opts?.chunkSize || 300;
  const chunkOverlap = useTokenBudget
    ? opts?.chunkOverlapTokens ?? DEFAULT_QWEN3_CHUNK_OVERLAP_TOKENS
    : opts?.chunkOverlap || 50;

  if (!text || text.trim().length === 0) return [];

  const measuredCount = measure(text);
  if (measuredCount <= chunkSize) {
    return [{ text: text.trim(), index: 0, token_count: estimateTokenCount(text.trim()) }];
  }

  // Recursively split, then greedily merge to target size
  const pieces = recursiveSplit(text, 0, chunkSize, measure);
  const merged = greedyMerge(pieces, chunkSize, measure);
  const withOverlap = applyOverlap(merged, chunkOverlap, measure);

  return withOverlap.map((t, i) => ({
    text: t.trim(),
    index: i,
    token_count: estimateTokenCount(t),
  }));
}

function recursiveSplit(
  text: string,
  level: number,
  target: number,
  measure: (text: string) => number,
): string[] {
  if (level >= DELIMITERS.length) {
    // Level 4: split on whitespace
    return splitOnWhitespace(text, target, measure);
  }

  const delimiters = DELIMITERS[level];
  if (delimiters.length === 0) {
    return splitOnWhitespace(text, target, measure);
  }

  const pieces = splitAtDelimiters(text, delimiters);

  // If splitting didn't help (only 1 piece), try next level
  if (pieces.length <= 1) {
    return recursiveSplit(text, level + 1, target, measure);
  }

  // Check if any piece is still too large, recurse deeper
  const result: string[] = [];
  for (const piece of pieces) {
    if (measure(piece) > target) {
      result.push(...recursiveSplit(piece, level + 1, target, measure));
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
 */
function splitOnWhitespace(text: string, target: number, measure: (text: string) => number): string[] {
  const words = text.match(/\S+\s*/g) || [];
  if (words.length === 0) return [];

  const pieces: string[] = [];
  let current = '';
  for (const word of words) {
    if (measure(word) > target) {
      if (current.trim().length > 0) {
        pieces.push(current);
        current = '';
      }
      pieces.push(...splitOversizedUnit(word, target, measure));
      continue;
    }

    const next = current + word;
    if (current.trim().length > 0 && measure(next) > target) {
      pieces.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current.trim().length > 0) {
    pieces.push(current);
  }
  return pieces;
}

function splitOversizedUnit(
  text: string,
  target: number,
  measure: (text: string) => number,
): string[] {
  const chars = Array.from(text);
  const pieces: string[] = [];
  let current = '';

  for (const char of chars) {
    const next = current + char;
    if (current.length > 0 && measure(next) > target) {
      pieces.push(current);
      current = char;
    } else {
      current = next;
    }
  }

  if (current.trim().length > 0) {
    pieces.push(current);
  }
  return pieces;
}

/**
 * Greedily merge adjacent pieces until each chunk is near the target size.
 * Avoids creating chunks larger than target * 1.5.
 */
function greedyMerge(pieces: string[], target: number, measure: (text: string) => number): string[] {
  if (pieces.length === 0) return [];

  const result: string[] = [];
  let current = pieces[0];

  for (let i = 1; i < pieces.length; i++) {
    const combined = current + pieces[i];
    if (measure(combined) <= Math.ceil(target * 1.5)) {
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
function applyOverlap(
  chunks: string[],
  overlapBudget: number,
  measure: (text: string) => number,
): string[] {
  if (chunks.length <= 1 || overlapBudget <= 0) return chunks;

  const result: string[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prevTrailing = extractTrailingContext(chunks[i - 1], overlapBudget, measure);
    result.push(prevTrailing + chunks[i]);
  }

  return result;
}

/**
 * Extract the last N words from text, trying to align to sentence boundaries.
 * If a sentence boundary exists within the last N words, start there.
 */
function extractTrailingContext(
  text: string,
  targetBudget: number,
  measure: (text: string) => number,
): string {
  const words = text.match(/\S+\s*/g) || [];
  if (measure(text) <= targetBudget) return '';

  let trailing = '';
  for (let index = words.length - 1; index >= 0; index--) {
    const candidate = words[index] + trailing;
    if (trailing.length > 0 && measure(candidate) > targetBudget) break;
    trailing = candidate;
  }

  if (!trailing || measure(trailing) > targetBudget) {
    trailing = extractTrailingChars(text, targetBudget, measure);
  }

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

function extractTrailingChars(
  text: string,
  targetBudget: number,
  measure: (text: string) => number,
): string {
  const chars = Array.from(text);
  let trailing = '';

  for (let index = chars.length - 1; index >= 0; index--) {
    const candidate = chars[index] + trailing;
    if (trailing.length > 0 && measure(candidate) > targetBudget) break;
    trailing = candidate;
  }

  return trailing;
}

function countWords(text: string): number {
  return (text.match(/\S+/g) || []).length;
}
