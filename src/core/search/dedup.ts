/**
 * 4-Layer Dedup Pipeline + Compiled Truth Guarantee
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * 1. By source: top 3 chunks per page by score
 * 2. By text similarity: remove chunks >0.85 Jaccard-similar to kept results
 * 3. By type: no page type exceeds 60% of results
 * 4. By page: max N chunks per page (default 2)
 * 5. Compiled truth guarantee: ensure at least 1 compiled_truth chunk per page
 *
 * v0.18.0: every page key is composite (source_id, slug). Pre-v0.17 this
 * was slug alone — under multi-source uniqueness that would collapse two
 * same-slug pages in different sources into one, destroying recall.
 * Codex review flagged this as a regression-critical path. The
 * `pageKey()` helper below is the one canonical way to derive the key;
 * every layer uses it so future "dedup just changed" drift is one file
 * to fix.
 */

import type { SearchResult } from '../types.ts';

const COSINE_DEDUP_THRESHOLD = 0.85;
const MAX_TYPE_RATIO = 0.6;
const MAX_PER_PAGE = 2;

/**
 * Composite page key: (source_id, slug). Pre-v0.17 rows lacked source_id
 * so we fall back to 'default' to preserve single-source brain behavior
 * exactly. Post-v0.17 callers always populate source_id (SQL JOINs in
 * pglite/postgres engine search paths).
 */
function pageKey(r: SearchResult): string {
  const source = r.source_id ?? 'default';
  return `${source}:${r.slug}`;
}

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
    const k = pageKey(r);
    const existing = byPage.get(k) || [];
    existing.push(r);
    byPage.set(k, existing);
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
const JACCARD_SKIP_THRESHOLD = 80;
const JACCARD_PREFIX_LEN = 200;
const JACCARD_KEPT_CAP = 50;

function dedupByTextSimilarity(results: SearchResult[], threshold: number): SearchResult[] {
  const kept: SearchResult[] = [];
  const keptWords: Set<string>[] = [];
  const keptPrefixes: string[] = [];
  const keptTexts = new Set<string>();
  const usePrefix = results.length > JACCARD_SKIP_THRESHOLD;

  const prefixes = usePrefix
    ? results.map(r => r.chunk_text.toLowerCase().slice(0, JACCARD_PREFIX_LEN))
    : null;

  for (let ri = 0; ri < results.length; ri++) {
    const r = results[ri];
    const rText = r.chunk_text.toLowerCase();
    // Exact duplicates remain cheap to reject even after the approximate
    // Jaccard comparison cap has been reached.
    if (keptTexts.has(rText)) continue;
    if (kept.length >= JACCARD_KEPT_CAP) {
      kept.push(r);
      keptTexts.add(rText);
      continue;
    }

    const rWords = new Set(rText.split(/\s+/));
    const rPre = prefixes?.[ri];
    let tooSimilar = false;

    for (let i = 0; i < kept.length; i++) {
      if (rPre !== undefined) {
        if (rPre !== keptPrefixes[i]) {
          const rPWords = new Set(rPre.split(/\s+/));
          const kPWords = new Set(keptPrefixes[i].split(/\s+/));
          const pInter = [...rPWords].filter(w => kPWords.has(w)).length;
          const pUnion = rPWords.size + kPWords.size - pInter;
          if (pUnion > 0 && pInter / pUnion <= threshold) continue;
        }
      }

      const kWords = keptWords[i];
      let interCount = 0;
      for (const w of rWords) {
        if (kWords.has(w)) interCount++;
      }
      const unionSize = rWords.size + kWords.size - interCount;
      const jaccard = unionSize > 0 ? interCount / unionSize : 0;

      if (jaccard > threshold) {
        tooSimilar = true;
        break;
      }
    }

    if (!tooSimilar) {
      kept.push(r);
      keptWords.push(rWords);
      keptPrefixes.push(rPre ?? '');
      keptTexts.add(rText);
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
    const k = pageKey(r);
    const count = pageCounts.get(k) || 0;
    if (count < maxPerPage) {
      kept.push(r);
      pageCounts.set(k, count + 1);
    }
  }

  return kept;
}

/**
 * Final pass: for each page in results that has no compiled_truth chunk,
 * swap in the best compiled_truth chunk from the pre-dedup set (if one exists).
 */
function guaranteeCompiledTruth(results: SearchResult[], preDedup: SearchResult[]): SearchResult[] {
  // Group results by composite page key (source_id, slug).
  const byPage = new Map<string, SearchResult[]>();
  for (const r of results) {
    const k = pageKey(r);
    const existing = byPage.get(k) || [];
    existing.push(r);
    byPage.set(k, existing);
  }

  const output = [...results];

  for (const [key, pageChunks] of byPage) {
    const hasCompiledTruth = pageChunks.some(c => c.chunk_source === 'compiled_truth');
    if (hasCompiledTruth) continue;

    // Find the best compiled_truth chunk from pre-dedup input for this
    // (source_id, slug) combination. Pre-v0.17 single-source match was
    // "r.slug === slug"; now it's the composite key so two same-slug
    // pages in different sources don't mistakenly swap chunks across.
    const candidate = preDedup
      .filter(r => pageKey(r) === key && r.chunk_source === 'compiled_truth')
      .sort((a, b) => b.score - a.score)[0];

    if (!candidate) continue;

    // Swap: replace the lowest-scored chunk from this page (same
    // composite key match).
    const lowestIdx = output.reduce((minIdx, r, idx) => {
      if (pageKey(r) !== key) return minIdx;
      if (minIdx === -1) return idx;
      return r.score < output[minIdx].score ? idx : minIdx;
    }, -1);

    if (lowestIdx !== -1) {
      output[lowestIdx] = candidate;
    }
  }

  return output;
}
