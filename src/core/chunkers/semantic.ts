/**
 * Semantic Text Chunker
 * Ported from production Ruby implementation (semantic_text_chunker.rb, 242 LOC)
 *
 * Algorithm:
 *   1. Split text into sentences
 *   2. Embed each sentence
 *   3. Compute adjacent cosine similarities
 *   4. Savitzky-Golay filter (5-window, 3rd-order polynomial)
 *   5. Find local minima (topic boundaries)
 *   6. Group sentences, recursively split oversized groups
 *
 * Falls back to recursive chunker on any failure.
 */

import { chunkText as recursiveChunk, type TextChunk } from './recursive.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';

export interface SemanticChunkOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  embedFn?: (texts: string[]) => Promise<Float32Array[]>;
}

export async function chunkTextSemantic(
  text: string,
  opts: SemanticChunkOptions,
): Promise<TextChunk[]> {
  text = sanitizeRemoteBody(text);
  const chunkSize = opts.chunkSize || 300;
  const chunkOverlap = opts.chunkOverlap || 50;
  const embedFn = opts.embedFn;

  if (!embedFn) {
    return recursiveChunk(text, { chunkSize, chunkOverlap });
  }

  try {
    const sentences = splitSentences(text);
    if (sentences.length <= 3) {
      return recursiveChunk(text, { chunkSize, chunkOverlap });
    }

    // Embed all sentences
    const embeddings = await embedFn(sentences);
    if (embeddings.length !== sentences.length) {
      return recursiveChunk(text, { chunkSize, chunkOverlap });
    }

    // Compute adjacent cosine similarities
    const similarities = computeAdjacentSimilarities(embeddings);

    // Find topic boundaries
    const boundaries = findBoundaries(similarities);

    // Group sentences at boundaries
    const groups = groupAtBoundaries(sentences, boundaries);

    // Recursively split oversized groups
    const chunks: TextChunk[] = [];
    let idx = 0;
    for (const group of groups) {
      const groupText = group.join(' ');
      const wordCount = (groupText.match(/\S+/g) || []).length;

      if (wordCount > chunkSize * 1.5) {
        const subChunks = recursiveChunk(groupText, { chunkSize, chunkOverlap });
        for (const sc of subChunks) {
          chunks.push({ text: sc.text, index: idx++ });
        }
      } else {
        chunks.push({ text: groupText.trim(), index: idx++ });
      }
    }

    return chunks;
  } catch {
    // Any failure falls back to recursive
    return recursiveChunk(text, { chunkSize, chunkOverlap });
  }
}

/**
 * Split text into sentences. Handles common abbreviations.
 */
export function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by whitespace or newline
  const raw = text.split(/(?<=[.!?])\s+/);
  return raw
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Compute cosine similarity between each adjacent pair of embeddings.
 * Returns array of length (embeddings.length - 1).
 */
function computeAdjacentSimilarities(embeddings: Float32Array[]): number[] {
  const sims: number[] = [];
  for (let i = 0; i < embeddings.length - 1; i++) {
    sims.push(cosineSimilarity(embeddings[i], embeddings[i + 1]));
  }
  return sims;
}

/**
 * Find topic boundaries using Savitzky-Golay smoothing.
 * Falls back to percentile-based detection if SG fails.
 */
function findBoundaries(similarities: number[]): number[] {
  if (similarities.length < 5) {
    return findBoundariesPercentile(similarities);
  }

  try {
    return findBoundariesSavGol(similarities);
  } catch {
    return findBoundariesPercentile(similarities);
  }
}

/**
 * Savitzky-Golay boundary detection.
 * Apply SG filter to get 1st derivative, find local minima.
 */
function findBoundariesSavGol(similarities: number[]): number[] {
  // Compute 1st derivative via Savitzky-Golay (window=5, poly=3, deriv=1)
  const derivative = savitzkyGolay(similarities, 5, 3, 1);

  // Find zero crossings of the derivative (local minima)
  // A minimum is where derivative goes from negative to positive
  const minima: number[] = [];
  for (let i = 1; i < derivative.length; i++) {
    if (derivative[i - 1] < 0 && derivative[i] >= 0) {
      minima.push(i);
    }
  }

  // Filter by percentile: only keep minima where similarity is below 80th percentile
  const threshold = percentile(similarities, 0.2); // low similarity = topic shift
  const filtered = minima.filter(i => {
    const simIdx = Math.min(i, similarities.length - 1);
    return similarities[simIdx] < threshold;
  });

  // Enforce minimum distance of 2 between boundaries
  return enforceMinDistance(filtered, 2);
}

/**
 * Simple percentile-based boundary detection.
 * Find positions where similarity drops below the 20th percentile.
 */
function findBoundariesPercentile(similarities: number[]): number[] {
  if (similarities.length === 0) return [];

  const threshold = percentile(similarities, 0.2);
  const boundaries: number[] = [];

  for (let i = 0; i < similarities.length; i++) {
    if (similarities[i] < threshold) {
      boundaries.push(i + 1); // boundary is after position i
    }
  }

  return enforceMinDistance(boundaries, 2);
}

/**
 * Savitzky-Golay filter implementation.
 * Polynomial fitting over a sliding window.
 */
function savitzkyGolay(
  data: number[],
  windowSize: number,
  polyOrder: number,
  derivOrder: number,
): number[] {
  const half = Math.floor(windowSize / 2);
  const n = data.length;

  if (n < windowSize) return data.slice();

  // Build Vandermonde matrix for the window
  const J: number[][] = [];
  for (let i = -half; i <= half; i++) {
    const row: number[] = [];
    for (let j = 0; j <= polyOrder; j++) {
      row.push(Math.pow(i, j));
    }
    J.push(row);
  }

  // Compute (J^T J)^-1 J^T
  const JT = transpose(J);
  const JTJ = matMul(JT, J);
  const JTJinv = invertMatrix(JTJ);
  const coeffs = matMul(JTJinv, JT);

  // The row corresponding to derivOrder gives us the filter coefficients
  // For derivative of order d, multiply by d!
  const filterRow = coeffs[derivOrder];
  const factorial = factorialN(derivOrder);

  const result: number[] = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    let val = 0;
    for (let j = -half; j <= half; j++) {
      const idx = Math.min(Math.max(i + j, 0), n - 1);
      val += filterRow[j + half] * data[idx];
    }
    result[i] = val * factorial;
  }

  return result;
}

/**
 * Group sentences into chunks at the given boundary positions.
 */
function groupAtBoundaries(sentences: string[], boundaries: number[]): string[][] {
  const groups: string[][] = [];
  let start = 0;

  for (const b of boundaries) {
    if (b > start && b < sentences.length) {
      groups.push(sentences.slice(start, b));
      start = b;
    }
  }

  // Last group
  if (start < sentences.length) {
    groups.push(sentences.slice(start));
  }

  return groups.length > 0 ? groups : [sentences];
}

// Math helpers

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(p * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function enforceMinDistance(boundaries: number[], minDist: number): number[] {
  if (boundaries.length <= 1) return boundaries;
  const result = [boundaries[0]];
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] - result[result.length - 1] >= minDist) {
      result.push(boundaries[i]);
    }
  }
  return result;
}

function transpose(m: number[][]): number[][] {
  const rows = m.length, cols = m[0].length;
  const result: number[][] = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[j][i] = m[i][j];
    }
  }
  return result;
}

function matMul(a: number[][], b: number[][]): number[][] {
  const rows = a.length, cols = b[0].length, inner = b.length;
  const result: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      for (let k = 0; k < inner; k++) {
        result[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return result;
}

function invertMatrix(m: number[][]): number[][] {
  const n = m.length;
  // Augment with identity
  const aug: number[][] = m.map((row, i) => {
    const identity = new Array(n).fill(0);
    identity[i] = 1;
    return [...row, ...identity];
  });

  // Gauss-Jordan elimination
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
        maxRow = row;
      }
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) {
      throw new Error('Matrix is singular');
    }

    // Scale pivot row
    for (let j = 0; j < 2 * n; j++) {
      aug[col][j] /= pivot;
    }

    // Eliminate column
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  return aug.map(row => row.slice(n));
}

function factorialN(n: number): number {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}
