/**
 * 4-Layer Dedup Pipeline
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * 1. By source: one chunk per page with highest score
 * 2. By cosine similarity: remove chunks >0.85 similar to kept results
 * 3. By type: no page type exceeds 60% of results
 * 4. By page: max N chunks per page (default 2)
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
    score?: (result: SearchResult) => number;
  },
): SearchResult[] {
  const threshold = opts?.cosineThreshold ?? COSINE_DEDUP_THRESHOLD;
  const maxRatio = opts?.maxTypeRatio ?? MAX_TYPE_RATIO;
  const maxPerPage = opts?.maxPerPage ?? MAX_PER_PAGE;
  const score = opts?.score ?? ((result: SearchResult) => result.score);
  const preDedup = results;

  let deduped = results;

  // Layer 1: By source (one chunk per page with highest score)
  deduped = dedupBySource(deduped, score);

  // Layer 2: By cosine similarity text overlap
  // (We don't have embeddings for results here, so use text similarity as proxy)
  deduped = dedupByTextSimilarity(deduped, threshold);

  // Layer 3: By type distribution
  deduped = enforceTypeDiversity(deduped, maxRatio);

  // Layer 4: By page cap
  deduped = capPerPage(deduped, maxPerPage);

  return guaranteeCompiledTruth(deduped, preDedup, score)
    .sort((a, b) => score(b) - score(a));
}

/**
 * Layer 1: Keep top 3 chunks per page (not just 1).
 * Later layers (text similarity, cap per page) handle further reduction.
 */
function dedupBySource(
  results: SearchResult[],
  score: (result: SearchResult) => number,
): SearchResult[] {
  const byPage = new Map<string, SearchResult[]>();

  for (const r of results) {
    const existing = byPage.get(r.slug) || [];
    existing.push(r);
    byPage.set(r.slug, existing);
  }

  const kept: SearchResult[] = [];
  for (const chunks of byPage.values()) {
    chunks.sort((a, b) => score(b) - score(a));
    kept.push(...chunks.slice(0, 3));
  }

  return kept.sort((a, b) => score(b) - score(a));
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

function guaranteeCompiledTruth(
  results: SearchResult[],
  preDedup: SearchResult[],
  score: (result: SearchResult) => number,
): SearchResult[] {
  const byPage = new Map<string, SearchResult[]>();
  for (const result of results) {
    const existing = byPage.get(result.slug) || [];
    existing.push(result);
    byPage.set(result.slug, existing);
  }

  const output = [...results];

  for (const [slug, pageChunks] of byPage) {
    const hasCompiledTruth = pageChunks.some((chunk) => chunk.chunk_source === 'compiled_truth');
    if (hasCompiledTruth) continue;

    const candidate = preDedup
      .filter((result) => result.slug === slug && result.chunk_source === 'compiled_truth')
      .sort((a, b) => score(b) - score(a))[0];

    if (!candidate) continue;

    const lowestIdx = output.reduce((minIdx, result, idx) => {
      if (result.slug !== slug) return minIdx;
      if (minIdx === -1) return idx;
      return score(result) < score(output[minIdx]) ? idx : minIdx;
    }, -1);

    if (lowestIdx !== -1) {
      output[lowestIdx] = candidate;
    }
  }

  return output;
}
