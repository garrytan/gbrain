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
  const fingerprints = new Map<SearchResult, TextSimilarityTerms>();

  for (const r of results) {
    const rTerms = textSimilarityTerms(r.chunk_text);
    fingerprints.set(r, rTerms);
    let tooSimilar = false;

    for (const k of kept) {
      const kTerms = fingerprints.get(k) ?? textSimilarityTerms(k.chunk_text);
      fingerprints.set(k, kTerms);
      const intersection = new Set([...rTerms.terms].filter(w => kTerms.terms.has(w)));
      const union = new Set([...rTerms.terms, ...kTerms.terms]);
      const jaccard = intersection.size / union.size;
      const similarityThreshold = rTerms.kind === 'cjk' || kTerms.kind === 'cjk'
        ? Math.min(threshold, 0.8)
        : threshold;

      if (jaccard > similarityThreshold) {
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

interface TextSimilarityTerms {
  kind: 'cjk' | 'word';
  terms: Set<string>;
}

function textSimilarityTerms(text: string): TextSimilarityTerms {
  return isCjkHeavy(text)
    ? { kind: 'cjk', terms: cjkCharacterBigrams(text) }
    : { kind: 'word', terms: whitespaceTerms(text) };
}

function whitespaceTerms(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

function isCjkHeavy(text: string): boolean {
  const cjk = Array.from(text.matchAll(/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/gu)).length;
  if (cjk < 3) return false;
  const lettersAndNumbers = Array.from(text.matchAll(/[\p{L}\p{N}]/gu)).length;
  return lettersAndNumbers === 0 ? false : cjk / lettersAndNumbers >= 0.3;
}

function cjkCharacterBigrams(text: string): Set<string> {
  const normalized = Array.from(text.toLowerCase())
    .filter((char) => /[\p{L}\p{N}]/u.test(char))
    .join('');
  const chars = Array.from(normalized);
  if (chars.length <= 1) return new Set(chars);
  const bigrams = new Set<string>();
  for (let index = 0; index < chars.length - 1; index += 1) {
    bigrams.add(`${chars[index]}${chars[index + 1]}`);
  }
  return bigrams;
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
