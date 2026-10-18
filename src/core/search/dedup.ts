/**
 * 4-Layer Dedup Pipeline + Compiled Truth Guarantee
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * 1. By source: top 3 chunks per page by score
 * 2. By text similarity: remove chunks >0.85 Jaccard-similar to kept results
 * 3. By type: no page type exceeds 60% of results
 * 4. By page: max N chunks per page (default 2)
 * 5. Compiled truth guarantee: ensure at least 1 compiled_truth chunk per page
 *    (appended, never evicting a kept chunk; the output is re-sorted by score)
 *
 * Segmented pages (Wave B, spec 7.5): a page stored in segments counts each
 * occurrence cluster (occurrences more than SEGMENT_CLUSTER_BYTES apart are
 * separate regions) as a page in layers 1 and 4, so far-apart regions of one
 * large page each keep up to N chunks, at most MAX_PER_SEGMENTED_PAGE in all.
 * The caller passes the occurrence positions (`regions`, segmentRegions);
 * without them, and for every inline page, nothing changes.
 *
 * v0.18.0: every page key is composite (source_id, slug). Pre-v0.17 this
 * was slug alone — under multi-source uniqueness that would collapse two
 * same-slug pages in different sources into one, destroying recall.
 * Codex review flagged this as a regression-critical path. The
 * `pageKey()` helper below is the one canonical way to derive the key;
 * every layer uses it so future "dedup just changed" drift is one file
 * to fix.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { chunkManifestJoin, chunkManifestReads, chunkVisibleFilter } from './safe-chunks.ts';

const COSINE_DEDUP_THRESHOLD = 0.85;
const MAX_TYPE_RATIO = 0.6;
const MAX_PER_PAGE = 2;
/** Chunks one segmented page may keep across its occurrence clusters. */
export const MAX_PER_SEGMENTED_PAGE = 6;
/** Stored bytes between two occurrences of a segmented page beyond which they are separate regions. */
export const SEGMENT_CLUSTER_BYTES = 1024 * 1024;

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

/**
 * Occurrence positions of the chunks of segmented pages among `results`, for
 * dedupResults' `regions`: chunk id -> stored byte where the chunk's live
 * occurrence starts. One query, run only when some page has more results
 * than MAX_PER_PAGE (otherwise the region rule changes nothing), with its
 * chunk-manifest probe in one read under the keyword statement bound
 * (engine.keywordBoundedRead); a failed read, a cancelled one included,
 * leaves every page under the inline rule.
 */
export async function segmentRegions(engine: Pick<BrainEngine, 'kind' | 'executeRaw' | 'keywordBoundedRead'>, results: readonly SearchResult[]): Promise<Map<number, number>> {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(pageKey(r), (counts.get(pageKey(r)) ?? 0) + 1);
  const ids = results.filter(r => counts.get(pageKey(r))! > MAX_PER_PAGE && r.chunk_id > 0).map(r => r.chunk_id);
  if (ids.length === 0) return new Map();
  try {
    return await engine.keywordBoundedRead(async db => {
      if (!await chunkManifestReads(engine, db)) return new Map<number, number>();
      const rows = await db.executeRaw<{ id: number; byte_start: number | string }>(`SELECT cc.id, m.byte_start FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id AND p.body_storage = 'segmented'
        ${chunkManifestJoin('p', 'cc', 'm')}
        WHERE cc.id = ANY($1::int[]) AND m.byte_start IS NOT NULL AND ${chunkVisibleFilter('p', 'cc')}`, [ids]);
      return new Map(rows.map(r => [Number(r.id), Number(r.byte_start)]));
    });
  } catch {
    return new Map();
  }
}

/**
 * The dedup key of each result: its page, or for a segmented page (a chunk with a region) its page and occurrence
 * cluster. Clusters are single-linkage over the page's occurrence positions in `results`: sorted, a gap over
 * SEGMENT_CLUSTER_BYTES starts a new one. A segmented page's result with no region is a region of its own.
 */
function regionKeys(results: readonly SearchResult[], regions: ReadonlyMap<number, number>): Map<SearchResult, string> {
  const positions = new Map<string, number[]>();
  for (const r of results) {
    const at = regions.get(r.chunk_id);
    if (at !== undefined) positions.set(pageKey(r), [...(positions.get(pageKey(r)) ?? []), at]);
  }
  const clusterOf = new Map<string, Map<number, number>>();
  for (const [page, list] of positions) {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    const ids = new Map<number, number>();
    let cluster = 0;
    sorted.forEach((at, i) => { if (i > 0 && at - sorted[i - 1]! > SEGMENT_CLUSTER_BYTES) cluster++; ids.set(at, cluster); });
    clusterOf.set(page, ids);
  }
  const keys = new Map<SearchResult, string>();
  for (const r of results) {
    const page = pageKey(r);
    const ids = clusterOf.get(page);
    keys.set(r, ids ? `${page}#${regions.has(r.chunk_id) ? ids.get(regions.get(r.chunk_id)!) : `chunk:${r.chunk_id}`}` : page);
  }
  return keys;
}

export function dedupResults(
  results: SearchResult[],
  opts?: {
    cosineThreshold?: number;
    maxTypeRatio?: number;
    maxPerPage?: number;
    /** Segmented pages: chunk id -> stored byte of its occurrence (segmentRegions). */
    regions?: ReadonlyMap<number, number>;
  },
): SearchResult[] {
  const threshold = opts?.cosineThreshold ?? COSINE_DEDUP_THRESHOLD;
  const maxRatio = opts?.maxTypeRatio ?? MAX_TYPE_RATIO;
  const maxPerPage = opts?.maxPerPage ?? MAX_PER_PAGE;
  const keys = opts?.regions?.size ? regionKeys(results, opts.regions) : undefined;
  const regionKey = (r: SearchResult) => keys?.get(r) ?? pageKey(r);

  // Preserve pre-dedup input for compiled truth guarantee
  const preDedup = results;

  let deduped = results;

  // Layer 1: Top 3 chunks per page (per region of a segmented page) by score
  deduped = dedupBySource(deduped, regionKey);

  // Layer 2: Text similarity dedup (Jaccard on word sets)
  deduped = dedupByTextSimilarity(deduped, threshold);

  // Layer 3: Type diversity (no page type exceeds 60%)
  deduped = enforceTypeDiversity(deduped, maxRatio);

  // Layer 4: Cap chunks per page (per region of a segmented page, MAX_PER_SEGMENTED_PAGE per page)
  deduped = capPerPage(deduped, maxPerPage, regionKey);

  // Final pass: guarantee compiled_truth representation, then restore score
  // order (downstream slice / token budget / evidence assume it).
  deduped = guaranteeCompiledTruth(deduped, preDedup);

  return deduped.sort((a, b) => b.score - a.score);
}

/**
 * Layer 1: Keep top 3 chunks per page.
 * Later layers (text similarity, cap per page) handle further reduction.
 */
function dedupBySource(results: SearchResult[], keyOf: (r: SearchResult) => string): SearchResult[] {
  const byPage = new Map<string, SearchResult[]>();

  for (const r of results) {
    const k = keyOf(r);
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
      // |A ∩ B| by iterating the smaller set; |A ∪ B| = |A| + |B| - |A ∩ B|.
      // Same value as building intersection/union Sets, without allocating.
      const [smaller, larger] = rWords.size <= kWords.size ? [rWords, kWords] : [kWords, rWords];
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
function capPerPage(results: SearchResult[], maxPerPage: number, keyOf: (r: SearchResult) => string): SearchResult[] {
  const pageCounts = new Map<string, number>();
  const regionCounts = new Map<string, number>();
  const kept: SearchResult[] = [];

  for (const r of results) {
    const page = pageKey(r);
    const k = keyOf(r);
    const count = regionCounts.get(k) || 0;
    const total = pageCounts.get(page) || 0;
    if (count < maxPerPage && (k === page || total < Math.max(MAX_PER_SEGMENTED_PAGE, maxPerPage))) {
      kept.push(r);
      regionCounts.set(k, count + 1);
      pageCounts.set(page, total + 1);
    }
  }

  return kept;
}

/**
 * Final pass: for each page in results that has no compiled_truth chunk,
 * add the best compiled_truth chunk from the pre-dedup set (if one exists).
 * It is appended, not swapped in: evicting the page's lowest kept chunk threw
 * away matching evidence (a 0.90 hit replaced by a 0.10 summary chunk).
 */
function guaranteeCompiledTruth(results: SearchResult[], preDedup: SearchResult[]): SearchResult[] {
  // Per composite page key (source_id, slug): does the kept set already hold
  // a compiled_truth chunk? Insertion order = first appearance in results.
  const hasTruth = new Map<string, boolean>();
  for (const r of results) {
    const k = pageKey(r);
    hasTruth.set(k, hasTruth.get(k) === true || r.chunk_source === 'compiled_truth');
  }

  // One pre-dedup scan: the best compiled_truth chunk for each page that
  // lacks one (first-seen max wins on ties). The composite key keeps two
  // same-slug pages in different sources from borrowing each other's chunk.
  const best = new Map<string, SearchResult>();
  for (const r of preDedup) {
    if (r.chunk_source !== 'compiled_truth') continue;
    const k = pageKey(r);
    if (hasTruth.get(k) !== false) continue;
    const cur = best.get(k);
    if (cur === undefined || r.score > cur.score) best.set(k, r);
  }

  const output = [...results];
  for (const [k, truth] of hasTruth) {
    const candidate = truth ? undefined : best.get(k);
    if (candidate) output.push(candidate);
  }
  return output;
}
