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
 * Layer 2: Remove chunks that are too similar to already-kept results
 * FROM THE SAME PAGE. Uses Jaccard similarity on word sets as a proxy for
 * cosine similarity.
 *
 * v0.46.15 (#3983): the comparison is scoped to the same pageKey. The
 * unscoped version dropped a chunk because a DIFFERENT page's chunk was
 * textually similar — on near-duplicate-record corpora (many similar deal
 * memos, weekly reports, boilerplate-heavy notes) that silently deleted
 * whole PAGES from the result set. Distinct pages are distinct answers;
 * only intra-page near-dups are redundant.
 */
function dedupByTextSimilarity(results: SearchResult[], threshold: number): SearchResult[] {
  const kept: SearchResult[] = [];
  const keptWordsByPage = new Map<string, Set<string>[]>();

  for (const r of results) {
    const rWords = new Set(r.chunk_text.toLowerCase().split(/\s+/));
    const k = pageKey(r);
    const samePageKept = keptWordsByPage.get(k) ?? [];
    let tooSimilar = false;

    for (const kWords of samePageKept) {
      // Allocation-free Jaccard: |A ∩ B| by iterating the smaller set,
      // |A ∪ B| = |A| + |B| - |A ∩ B|. Bit-identical to building the
      // intersection/union Sets (both sides hold unique words), without
      // the two Set allocations per comparison.
      const [smaller, larger] =
        rWords.size <= kWords.size ? [rWords, kWords] : [kWords, rWords];
      let intersectionSize = 0;
      for (const w of smaller) if (larger.has(w)) intersectionSize++;
      const unionSize = rWords.size + kWords.size - intersectionSize;
      const jaccard = unionSize === 0 ? 0 : intersectionSize / unionSize;

      if (jaccard > threshold) {
        tooSimilar = true;
        break;
      }
    }

    if (!tooSimilar) {
      kept.push(r);
      samePageKept.push(rWords);
      keptWordsByPage.set(k, samePageKept);
    }
  }

  return kept;
}

/**
 * Layer 3: No page type exceeds maxRatio of total results.
 */
function enforceTypeDiversity(results: SearchResult[], maxRatio: number): SearchResult[] {
  // A diversity cap cannot improve a homogeneous candidate set. Applying
  // the ratio anyway only drops relevant results (for 3 notes, the default
  // 60% cap returns 2) without adding another type in their place.
  if (new Set(results.map(r => r.type)).size <= 1) return results;

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
 *
 * Linear-time: page keys are computed once per row (the old code rebuilt the
 * `source:slug` template string on every inner-loop iteration — O(pages × N)
 * string builds), and the per-page best-truth candidate is found in one
 * pre-dedup scan instead of a filter+sort per page. Tie order is preserved:
 * first-seen max wins (as with a stable sort + [0]), and the swap replaces
 * the first lowest-scored chunk of the page (as with the strict-< reduce).
 */
function guaranteeCompiledTruth(results: SearchResult[], preDedup: SearchResult[]): SearchResult[] {
  // One pass: memoize the composite page key for every row scanned below.
  const keyMemo = new Map<SearchResult, string>();
  const keyOf = (r: SearchResult): string => {
    let k = keyMemo.get(r);
    if (k === undefined) {
      k = pageKey(r);
      keyMemo.set(r, k);
    }
    return k;
  };

  // One scan: best compiled_truth candidate per page (first max wins).
  const bestTruthByPage = new Map<string, SearchResult>();
  for (const r of preDedup) {
    if (r.chunk_source !== 'compiled_truth') continue;
    const k = keyOf(r);
    const cur = bestTruthByPage.get(k);
    if (cur === undefined || r.score > cur.score) bestTruthByPage.set(k, r);
  }

  // One pass: group results by page and record each page's output indices.
  const byPage = new Map<string, { hasTruth: boolean; idxs: number[] }>();
  const output = [...results];
  for (let i = 0; i < output.length; i++) {
    const r = output[i];
    const k = keyOf(r);
    let e = byPage.get(k);
    if (e === undefined) {
      e = { hasTruth: false, idxs: [] };
      byPage.set(k, e);
    }
    if (r.chunk_source === 'compiled_truth') e.hasTruth = true;
    e.idxs.push(i);
  }

  for (const [key, e] of byPage) {
    if (e.hasTruth) continue;
    const candidate = bestTruthByPage.get(key);
    if (candidate === undefined) continue;

    // Swap: replace the lowest-scored chunk from this page; first index
    // wins on ties.
    let lowestIdx = -1;
    for (const idx of e.idxs) {
      if (lowestIdx === -1 || output[idx].score < output[lowestIdx].score) lowestIdx = idx;
    }

    if (lowestIdx !== -1) {
      output[lowestIdx] = candidate;
    }
  }

  return output;
}
