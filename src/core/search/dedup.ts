/**
 * 4-Layer Dedup Pipeline + Compiled Truth Guarantee
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * 1. By source: top 3 chunks per page by score
 * 2. By text similarity: remove chunks >0.85 Jaccard-similar to kept results
 * 3. By type: no page type exceeds 60% of results
 * 4. By page: max N chunks per page (default 2)
 * 5. Compiled truth guarantee: ensure at least 1 compiled_truth chunk per page
 */

import type { SearchResult } from '../types.ts';

const COSINE_DEDUP_THRESHOLD = 0.85;
const MAX_TYPE_RATIO = 0.6;
const MAX_PER_PAGE = 2;

export function dedupResults(
  results: SearchResult[],
  opts?: {
    cosineThreshold?: number;
    maxTypeRatio?: number;
    maxPerPage?: number;
  },
): SearchResult[] {
  const threshold = opts?.cosineThreshold ?? COSINE_DEDUP_THRESHOLD;
  const maxRatio = opts?.maxTypeRatio ?? MAX_TYPE_RATIO;
  const maxPerPage = opts?.maxPerPage ?? MAX_PER_PAGE;

  // Preserve pre-dedup input for compiled truth guarantee
  const preDedup = results;

  let deduped = results;

  // Layer 1: Top 3 chunks per page by score
  deduped = dedupBySource(deduped);

  // Layer 2: Text similarity dedup (Jaccard on word sets)
  deduped = dedupByTextSimilarity(deduped, threshold);

  // Layer 3: Type diversity (no page type exceeds 60%)
  deduped = enforceTypeDiversity(deduped, maxRatio);

  // Layer 4: Cap chunks per page
  deduped = capPerPage(deduped, maxPerPage);

  // Final pass: guarantee compiled_truth representation
  deduped = guaranteeCompiledTruth(deduped, preDedup);

  return deduped;
}

/**
 * Layer 1: Keep top 3 chunks per page.
 * Later layers (text similarity, cap per page) handle further reduction.
 */
function dedupBySource(results: SearchResult[]): SearchResult[] {
  const byPage = new Map<string, SearchResult[]>();

  for (const r of results) {
    const existing = byPage.get(r.slug) || [];
    existing.push(r);
    byPage.set(r.slug, existing);
  }

  const kept: SearchResult[] = [];
  for (const chunks of byPage.values()) {
    chunks.sort((a, b) => b.score - a.score);
    kept.push(...chunks.slice(0, 3));
  }

  return kept.sort((a, b) => b.score - a.score);
}

/**
 * Layer 2: Remove chunks that are too similar to already-kept results.
 * Uses Jaccard similarity on word sets as a proxy for cosine similarity.
 */
function dedupByTextSimilarity(results: SearchResult[], threshold: number): SearchResult[] {
  const kept: SearchResult[] = [];

  for (const r of results) {
    const rWords = new Set(r.chunk_text.toLowerCase().split(/\s+/));
    let tooSimilar = false;

    for (const k of kept) {
      const kWords = new Set(k.chunk_text.toLowerCase().split(/\s+/));
      const intersection = new Set([...rWords].filter(w => kWords.has(w)));
      const union = new Set([...rWords, ...kWords]);
      const jaccard = intersection.size / union.size;

      if (jaccard > threshold) {
        tooSimilar = true;
        break;
      }
    }

    if (!tooSimilar) {
      kept.push(r);
    }
  }

  return kept;
}

/**
 * Layer 3: No page type exceeds maxRatio of total results.
 */
function enforceTypeDiversity(results: SearchResult[], maxRatio: number): SearchResult[] {
  const maxPerType = Math.max(1, Math.ceil(results.length * maxRatio));
  const typeCounts = new Map<string, number>();
  const kept: SearchResult[] = [];

  for (const r of results) {
    const count = typeCounts.get(r.type) || 0;
    if (count < maxPerType) {
      kept.push(r);
      typeCounts.set(r.type, count + 1);
    }
  }

  return kept;
}

/**
 * Layer 4: Cap chunks per page.
 */
function capPerPage(results: SearchResult[], maxPerPage: number): SearchResult[] {
  const pageCounts = new Map<string, number>();
  const kept: SearchResult[] = [];

  for (const r of results) {
    const count = pageCounts.get(r.slug) || 0;
    if (count < maxPerPage) {
      kept.push(r);
      pageCounts.set(r.slug, count + 1);
    }
  }

  return kept;
}

/**
 * Final pass: for each page in results that has no compiled_truth chunk,
 * swap in the best compiled_truth chunk from the pre-dedup set (if one exists).
 */
function guaranteeCompiledTruth(results: SearchResult[], preDedup: SearchResult[]): SearchResult[] {
  // Group results by page
  const byPage = new Map<string, SearchResult[]>();
  for (const r of results) {
    const existing = byPage.get(r.slug) || [];
    existing.push(r);
    byPage.set(r.slug, existing);
  }

  const output = [...results];

  for (const [slug, pageChunks] of byPage) {
    const hasCompiledTruth = pageChunks.some(c => c.chunk_source === 'compiled_truth');
    if (hasCompiledTruth) continue;

    // Find the best compiled_truth chunk from pre-dedup input for this page
    const candidate = preDedup
      .filter(r => r.slug === slug && r.chunk_source === 'compiled_truth')
      .sort((a, b) => b.score - a.score)[0];

    if (!candidate) continue;

    // Swap: replace the lowest-scored chunk from this page
    const lowestIdx = output.reduce((minIdx, r, idx) => {
      if (r.slug !== slug) return minIdx;
      if (minIdx === -1) return idx;
      return r.score < output[minIdx].score ? idx : minIdx;
    }, -1);

    if (lowestIdx !== -1) {
      output[lowestIdx] = candidate;
    }
  }

  return output;
}
