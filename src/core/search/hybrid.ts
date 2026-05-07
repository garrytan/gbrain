/**
 * Hybrid Search with Reciprocal Rank Fusion (RRF)
 * Ported from production Ruby implementation (content_chunk.rb)
 *
 * Pipeline: keyword + vector → RRF fusion → normalize → boost → cosine re-score → dedup
 *
 * RRF score = sum(1 / (60 + rank_in_list))
 * Compiled truth boost: 2.0x for compiled_truth chunks after RRF normalization
 * Cosine re-score: blend 0.7*rrf + 0.3*cosine for query-specific ranking
 */

import type { BrainEngine } from '../engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from '../engine.ts';
import type { SearchResult, SearchOpts, HybridSearchMeta } from '../types.ts';
import { embed } from '../embedding.ts';
import { dedupResults } from './dedup.ts';
import { autoDetectDetail } from './intent.ts';
import { expandAnchors, hydrateChunks } from './two-pass.ts';
import { buildVisibilityClause } from './sql-ranking.ts';

const RRF_K = 60;
const COMPILED_TRUTH_BOOST = 2.0;
/**
 * Graph-hop rerank: after dedup, extract `[text](slug)` markdown wikilinks
 * from the top-K winning chunks and inject the linked pages as additional
 * candidates with score = parent_score * GRAPH_HOP_DECAY. Heuristic-free
 * (multilingual-safe regex, no slug-prefix branching, no entity dictionary).
 * Targets the dominant failure mode where the gold page is mentioned as a
 * wikilink inside a winning container chunk but never surfaces in top-k.
 */
const GRAPH_HOP_TOPK = 6;
const GRAPH_HOP_DECAY = 0.55;
/**
 * Rank-aware decay range: anchor at rank 0 contributes injected score with
 * decay = GRAPH_HOP_DECAY + GRAPH_HOP_RANK_BONUS; the decay falls linearly
 * to GRAPH_HOP_DECAY for the last anchor in the top-K window. Same DB cost,
 * pure score-shaping.
 */
const GRAPH_HOP_RANK_BONUS = 0.2;
const GRAPH_HOP_MAX_INJECT = 15;
/**
 * Depth-2 traversal cap. After depth-1 candidates are hydrated, scan their
 * chunk_text for further wikilinks and inject those as depth-2 candidates
 * with compounded decay. Capped separately so link-rich pages can't dominate
 * the merged result set. Best-effort: depth-2 SELECT failures fall through
 * to depth-1 result without breaking base retrieval.
 */
const GRAPH_HOP_DEPTH2_MAX_INJECT = 10;
/**
 * Depth-2 base decay. Compounded with the depth-1 decay already baked into
 * each depth-1 anchor's score. Mid-range: lets depth-2 candidates compete
 * with low-rank depth-1, but stays below high-rank depth-1 + originals.
 */
const GRAPH_HOP_DEPTH2_DECAY = 0.7;
const GRAPH_HOP_LINK_RE = /\[[^\]\n]+\]\(([^)\s#]+)\)/g;
/**
 * Backlink boost coefficient. Score is multiplied by (1 + BACKLINK_BOOST_COEF * log(1 + count)).
 * - 0 backlinks: factor = 1.0 (no boost).
 * - 1 backlink:  factor ~= 1.035.
 * - 10 backlinks: factor ~= 1.12.
 * - 100 backlinks: factor ~= 1.23.
 * Applied AFTER cosine re-score so it survives normalization, BEFORE dedup so the
 * boosted ranking determines which chunks per page are kept.
 */
const BACKLINK_BOOST_COEF = 0.05;
const DEBUG = process.env.GBRAIN_SEARCH_DEBUG === '1';

/**
 * Apply backlink boost to a result list in place. Mutates each result's score
 * by (1 + BACKLINK_BOOST_COEF * log(1 + count)). Pure data transform; no DB call.
 * Caller fetches counts via engine.getBacklinkCounts.
 */
export function applyBacklinkBoost(results: SearchResult[], counts: Map<string, number>): void {
  for (const r of results) {
    const count = counts.get(r.slug) ?? 0;
    if (count > 0) {
      r.score *= (1.0 + BACKLINK_BOOST_COEF * Math.log(1 + count));
    }
  }
}

export interface HybridSearchOpts extends SearchOpts {
  expansion?: boolean;
  expandFn?: (query: string) => Promise<string[]>;
  /** Override default RRF K constant (default: 60). Lower values boost top-ranked results more. */
  rrfK?: number;
  /** Override dedup pipeline parameters. */
  dedupOpts?: {
    cosineThreshold?: number;
    maxTypeRatio?: number;
    maxPerPage?: number;
  };
  /**
   * v0.25.0 — optional side-channel for what hybridSearch actually did
   * (vector ran or fell back, expansion fired or didn't, post-auto-detect
   * detail). Surfaced via callback so the bare-return contract stays as
   * `Promise<SearchResult[]>` for existing Cathedral II callers. Op-layer
   * eval capture passes a callback that threads `meta` into the captured
   * row; everyone else leaves it undefined and pays no cost.
   */
  onMeta?: (meta: HybridSearchMeta) => void;
}

export async function hybridSearch(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts,
): Promise<SearchResult[]> {
  const limit = opts?.limit || 20;
  const offset = opts?.offset || 0;
  const innerLimit = Math.min(limit * 2, MAX_SEARCH_LIMIT);

  // Auto-detect detail level from query intent when caller doesn't specify
  const detail = opts?.detail ?? autoDetectDetail(query);
  const detailResolved: 'low' | 'medium' | 'high' | null = detail ?? null;
  const searchOpts: SearchOpts = {
    limit: innerLimit,
    detail,
    // v0.20.0 Cathedral II Layer 10 — thread language + symbolKind through so
    // per-engine searchKeyword / searchVector apply the filters at SQL level.
    language: opts?.language,
    symbolKind: opts?.symbolKind,
  };
  // Track what actually ran for the optional onMeta callback (v0.25.0).
  // Caller leaves onMeta undefined → these flags are computed but never
  // surfaced. Capture wrapper passes a closure to receive the meta and
  // threads it into the eval_candidates row.
  let expansionApplied = false;

  // A throwing user callback must never break the search hot path — onMeta
  // is a public surface (gbrain/search/hybrid) so a third-party closure bug
  // shouldn't take down query/search responses.
  const emitMeta = (meta: HybridSearchMeta): void => {
    try {
      opts?.onMeta?.(meta);
    } catch {
      // swallow — capture telemetry is best-effort
    }
  };

  if (DEBUG && detail) {
    console.error(`[search-debug] auto-detail=${detail} for query="${query}"`);
  }

  // Run keyword search (always available, no API key needed)
  const keywordResults = await engine.searchKeyword(query, searchOpts);

  // Skip vector search entirely if the gateway has no embedding provider configured (Codex C3).
  const { isAvailable } = await import('../ai/gateway.ts');
  if (!isAvailable('embedding')) {
    // Apply backlink boost in keyword-only path too. One getBacklinkCounts query
    // per search request; not N+1.
    if (keywordResults.length > 0) {
      try {
        const slugs = Array.from(new Set(keywordResults.map(r => r.slug)));
        const counts = await engine.getBacklinkCounts(slugs);
        applyBacklinkBoost(keywordResults, counts);
        keywordResults.sort((a, b) => b.score - a.score);
      } catch {
        // Boost failure is non-fatal: keep unboosted ranking.
      }
    }
    emitMeta({ vector_enabled: false, detail_resolved: detailResolved, expansion_applied: false });
    return dedupResults(keywordResults).slice(offset, offset + limit);
  }

  // Determine query variants (optionally with expansion)
  // expandQuery already includes the original query in its return value,
  // so we use it directly instead of prepending query again
  let queries = [query];
  if (opts?.expansion && opts?.expandFn) {
    try {
      queries = await opts.expandFn(query);
      if (queries.length === 0) queries = [query];
      // "Applied" = produced variants beyond the original, not just called.
      expansionApplied = queries.length > 1;
    } catch {
      // Expansion failure is non-fatal
    }
  }

  // Embed all query variants and run vector search
  let vectorLists: SearchResult[][] = [];
  let queryEmbedding: Float32Array | null = null;
  try {
    const embeddings = await Promise.all(queries.map(q => embed(q)));
    queryEmbedding = embeddings[0];
    vectorLists = await Promise.all(
      embeddings.map(emb => engine.searchVector(emb, searchOpts)),
    );
  } catch {
    // Embedding failure is non-fatal, fall back to keyword-only
  }

  if (vectorLists.length === 0) {
    // Embed/vector failed silently; record that vector did not run.
    emitMeta({ vector_enabled: false, detail_resolved: detailResolved, expansion_applied: expansionApplied });
    return dedupResults(keywordResults).slice(offset, offset + limit);
  }

  // Merge all result lists via RRF (includes normalization + boost)
  // Skip boost for detail=high (temporal/event queries want natural ranking)
  const allLists = [...vectorLists, keywordResults];
  let fused = rrfFusion(allLists, opts?.rrfK ?? RRF_K, detail !== 'high');

  // Cosine re-scoring before dedup so semantically better chunks survive
  if (queryEmbedding) {
    fused = await cosineReScore(engine, fused, queryEmbedding);
  }

  // Apply backlink boost AFTER cosine re-score so the boost survives normalization,
  // and BEFORE dedup so it influences which chunks per page survive deduplication.
  // One DB query for the whole result set (not N+1).
  if (fused.length > 0) {
    try {
      const slugs = Array.from(new Set(fused.map(r => r.slug)));
      const counts = await engine.getBacklinkCounts(slugs);
      applyBacklinkBoost(fused, counts);
      fused.sort((a, b) => b.score - a.score);
    } catch {
      // Boost failure is non-fatal: keep blended cosine ranking.
    }
  }

  // v0.20.0 Cathedral II Layer 7 (A2): two-pass structural expansion.
  // Default OFF. When opts.walkDepth > 0 OR opts.nearSymbol is set, we
  // walk code_edges_chunk + code_edges_symbol up to walkDepth hops from
  // the anchor set (top of `fused`). Expanded neighbors get score decayed
  // by 1/(1+hop) from their anchor's score and merge back into the pool.
  //
  // Dedup per-page cap lifts to min(10, walkDepth * 5) when walking —
  // structural neighbors from the same file/class are the whole point
  // of two-pass; clipping them at 2/page defeats A2 (codex F5).
  const walkDepth = Math.min(opts?.walkDepth ?? 0, 2);
  const needsExpansion = walkDepth > 0 || Boolean(opts?.nearSymbol);
  let dedupOpts = opts?.dedupOpts;

  if (needsExpansion) {
    const anchorSet = fused.slice(0, Math.max(10, limit));
    try {
      const expanded = await expandAnchors(engine, anchorSet, {
        walkDepth,
        nearSymbol: opts?.nearSymbol,
        sourceId: opts?.sourceId,
      });
      // Resolve new chunk IDs (not already in fused) into full rows.
      const existingIds = new Set(fused.map(r => r.chunk_id));
      const newIds = expanded
        .filter(e => !existingIds.has(e.chunk_id))
        .map(e => e.chunk_id);
      if (newIds.length > 0) {
        const hydrated = await hydrateChunks(engine, newIds);
        const scoreById = new Map(expanded.map(e => [e.chunk_id, e.score]));
        for (const r of hydrated) {
          r.score = scoreById.get(r.chunk_id) ?? 0.01;
          fused.push(r);
        }
        fused.sort((a, b) => b.score - a.score);
      }
      // Widen per-page dedup cap when walking.
      const capFromWalk = Math.min(10, Math.max(walkDepth * 5, 5));
      dedupOpts = { ...(dedupOpts ?? {}), maxPerPage: capFromWalk };
    } catch {
      // Expansion is best-effort — missing edge tables or a transient
      // DB error must not break base hybrid retrieval.
    }
  }

  // Dedup
  const deduped = dedupResults(fused, dedupOpts);

  // Auto-escalate: if detail=low returned 0, retry with high. The inner
  // call's onMeta fires with the escalated detail_resolved; do NOT also
  // fire here (would double-emit and capture stale meta).
  if (deduped.length === 0 && opts?.detail === 'low') {
    return hybridSearch(engine, query, { ...opts, detail: 'high' });
  }

  // Graph-hop rerank: surface pages mentioned as wikilinks inside winning
  // chunks. Best-effort; failures fall through to deduped.
  let withGraphHop = deduped;
  try {
    withGraphHop = await graphHopRerank(engine, deduped, opts?.sourceId);
  } catch {
    // Non-fatal: missing tables or transient DB error must not break base retrieval.
  }

  emitMeta({ vector_enabled: true, detail_resolved: detailResolved, expansion_applied: expansionApplied });
  return withGraphHop.slice(offset, offset + limit);
}

/**
 * Hydrate a slug list against `pages` + `content_chunks`. Returns one row
 * per slug (DISTINCT ON p.slug), scored from `candidateScore`. Pure DB I/O —
 * no scoring decisions. Used by both depth-1 and depth-2 of graphHopRerank.
 */
async function hydrateSlugs(
  engine: BrainEngine,
  candidateScore: Map<string, number>,
  sourceId?: string,
  cap = GRAPH_HOP_MAX_INJECT,
): Promise<SearchResult[]> {
  if (candidateScore.size === 0) return [];
  const slugSet = new Set<string>();
  for (const k of candidateScore.keys()) {
    const idx = k.indexOf('::');
    slugSet.add(idx === -1 ? k : k.slice(idx + 2));
  }
  const slugs = [...slugSet].slice(0, cap * 4);
  const sourceFilter = sourceId ? ' AND p.source_id = $2' : '';
  const params: unknown[] = [slugs];
  if (sourceId) params.push(sourceId);
  const visibility = buildVisibilityClause('p', 's');
  const rows = await engine.executeRaw<{
    slug: string; page_id: number; title: string; type: string; source_id: string;
    chunk_id: number; chunk_index: number; chunk_text: string; chunk_source: string;
  }>(
    `SELECT DISTINCT ON (p.slug) p.slug, p.id as page_id, p.title, p.type, p.source_id,
            cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source
       FROM pages p
       JOIN content_chunks cc ON cc.page_id = p.id
       JOIN sources s ON s.id = p.source_id
      WHERE p.slug = ANY($1::text[])${sourceFilter} ${visibility}
      ORDER BY p.slug, cc.chunk_index ASC`,
    params,
  );
  if (rows.length === 0) return [];
  return rows.map(r => {
    const key = `${r.source_id ?? 'default'}::${r.slug}`;
    return {
      slug: r.slug,
      page_id: r.page_id,
      title: r.title,
      type: r.type as import('../types.ts').PageType,
      chunk_text: r.chunk_text,
      chunk_source: r.chunk_source as 'compiled_truth' | 'timeline',
      chunk_id: r.chunk_id,
      chunk_index: r.chunk_index,
      score: candidateScore.get(key) ?? 0.001,
      stale: false,
      source_id: r.source_id,
    };
  });
}

/**
 * Extract wikilinks from a list of anchor results. Returns a key → score map
 * where key = `${source_id}::${slug}`. Skips http/mailto links, normalizes
 * leading `./` and trailing `.md`. Multilingual-safe regex (no entity dicts,
 * no slug-prefix branching). Ranking-aware: anchor at index 0 contributes
 * the highest decay; the last anchor contributes the base decay.
 */
function extractWikilinkCandidates(
  anchors: SearchResult[],
  existing: Set<string>,
  baseDecay: number,
): Map<string, number> {
  const candidateScore = new Map<string, number>();
  if (anchors.length === 0) return candidateScore;
  const rankSpan = Math.max(1, anchors.length - 1);
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const text = a.chunk_text || '';
    const decay = baseDecay + GRAPH_HOP_RANK_BONUS * (1 - i / rankSpan);
    GRAPH_HOP_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GRAPH_HOP_LINK_RE.exec(text)) !== null) {
      const target = m[1];
      if (!target || target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:')) continue;
      const slug = target.replace(/^\.?\//, '').replace(/\.md$/i, '').split('#')[0].trim();
      if (!slug || slug.includes(' ')) continue;
      const key = `${a.source_id ?? 'default'}::${slug}`;
      if (existing.has(key)) continue;
      const injected = a.score * decay;
      const prev = candidateScore.get(key);
      if (prev === undefined || injected > prev) candidateScore.set(key, injected);
    }
  }
  return candidateScore;
}

/**
 * Two-pass graph-hop rerank.
 *
 * Pass 1 (depth-1): extract `[text](slug)` markdown wikilinks from the top-K
 * winning chunks, inject linked pages with score = anchor * rank_aware_decay.
 *
 * Pass 2 (depth-2): scan the hydrated depth-1 chunks' chunk_text for further
 * wikilinks and inject those with score = depth1_score * GRAPH_HOP_DECAY
 * (compounded). Targets the dominant remaining failure shape — "Who invested
 * in X?" where the gold person is two graph hops away (company → deal →
 * investor). Best-effort: depth-2 SELECT failures fall through to the
 * depth-1 result so base retrieval never breaks.
 *
 * Heuristic-free, multilingual-safe (regex only, no slug-prefix branching,
 * no entity dictionary).
 */
async function graphHopRerank(
  engine: BrainEngine,
  results: SearchResult[],
  sourceId?: string,
): Promise<SearchResult[]> {
  if (results.length === 0) return results;

  // ---- Depth 1 ----
  const anchorsD1 = results.slice(0, GRAPH_HOP_TOPK);
  const existing = new Set(results.map(r => `${r.source_id ?? 'default'}::${r.slug}`));
  const d1Candidates = extractWikilinkCandidates(anchorsD1, existing, GRAPH_HOP_DECAY);
  if (d1Candidates.size === 0) return results;

  const d1Hydrated = await hydrateSlugs(engine, d1Candidates, sourceId, GRAPH_HOP_MAX_INJECT);
  if (d1Hydrated.length === 0) return results;
  d1Hydrated.sort((a, b) => b.score - a.score);
  const d1Capped = d1Hydrated.slice(0, GRAPH_HOP_MAX_INJECT);

  // ---- Depth 2 (best-effort) ----
  // Scan the hydrated depth-1 chunks for further wikilinks and inject them
  // as depth-2 candidates with compounded decay. Wrap in try/catch so DB
  // errors fall through to the depth-1 result without breaking retrieval.
  let d2Capped: SearchResult[] = [];
  try {
    const existingForD2 = new Set(existing);
    for (const r of d1Capped) {
      existingForD2.add(`${r.source_id ?? 'default'}::${r.slug}`);
    }
    // Use the hydrated depth-1 chunks as anchors. Their `score` already
    // carries the depth-1 decay, so extractWikilinkCandidates compounds it.
    const d2Candidates = extractWikilinkCandidates(d1Capped, existingForD2, GRAPH_HOP_DEPTH2_DECAY);
    if (d2Candidates.size > 0) {
      const d2Hydrated = await hydrateSlugs(engine, d2Candidates, sourceId, GRAPH_HOP_DEPTH2_MAX_INJECT);
      d2Hydrated.sort((a, b) => b.score - a.score);
      d2Capped = d2Hydrated.slice(0, GRAPH_HOP_DEPTH2_MAX_INJECT);
    }
  } catch {
    // Non-fatal: depth-2 missing data must not break depth-1 retrieval.
    d2Capped = [];
  }

  const merged = [...results, ...d1Capped, ...d2Capped];
  merged.sort((a, b) => b.score - a.score);
  return merged;
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * Each result gets score = sum(1 / (K + rank)) across all lists it appears in.
 * After accumulation: normalize to 0-1, then boost compiled_truth chunks.
 */
export function rrfFusion(lists: SearchResult[][], k: number, applyBoost = true): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = `${r.slug}:${r.chunk_id ?? r.chunk_text.slice(0, 50)}`;
      const existing = scores.get(key);
      const rrfScore = 1 / (k + rank);

      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { result: r, score: rrfScore });
      }
    }
  }

  const entries = Array.from(scores.values());
  if (entries.length === 0) return [];

  // Normalize to 0-1 by dividing by observed max
  const maxScore = Math.max(...entries.map(e => e.score));
  if (maxScore > 0) {
    for (const e of entries) {
      const rawScore = e.score;
      e.score = e.score / maxScore;

      // Apply compiled truth boost after normalization (skip for detail=high)
      const boost = applyBoost && e.result.chunk_source === 'compiled_truth' ? COMPILED_TRUTH_BOOST : 1.0;
      e.score *= boost;

      if (DEBUG) {
        console.error(`[search-debug] ${e.result.slug}:${e.result.chunk_id} rrf_raw=${rawScore.toFixed(4)} rrf_norm=${(rawScore / maxScore).toFixed(4)} boost=${boost} boosted=${e.score.toFixed(4)} source=${e.result.chunk_source}`);
      }
    }
  }

  // Sort by boosted score descending
  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}

/**
 * Cosine re-scoring: blend RRF score with query-chunk cosine similarity.
 * Runs before dedup so semantically better chunks survive.
 */
async function cosineReScore(
  engine: BrainEngine,
  results: SearchResult[],
  queryEmbedding: Float32Array,
): Promise<SearchResult[]> {
  const chunkIds = results
    .map(r => r.chunk_id)
    .filter((id): id is number => id != null);

  if (chunkIds.length === 0) return results;

  let embeddingMap: Map<number, Float32Array>;
  try {
    embeddingMap = await engine.getEmbeddingsByChunkIds(chunkIds);
  } catch {
    // DB error is non-fatal, return results without re-scoring
    return results;
  }

  if (embeddingMap.size === 0) return results;

  // Normalize RRF scores to 0-1 for blending
  const maxRrf = Math.max(...results.map(r => r.score));

  return results.map(r => {
    const chunkEmb = r.chunk_id != null ? embeddingMap.get(r.chunk_id) : undefined;
    if (!chunkEmb) return r;

    const cosine = cosineSimilarity(queryEmbedding, chunkEmb);
    const normRrf = maxRrf > 0 ? r.score / maxRrf : 0;
    const blended = 0.7 * normRrf + 0.3 * cosine;

    if (DEBUG) {
      console.error(`[search-debug] ${r.slug}:${r.chunk_id} cosine=${cosine.toFixed(4)} norm_rrf=${normRrf.toFixed(4)} blended=${blended.toFixed(4)}`);
    }

    return { ...r, score: blended };
  }).sort((a, b) => b.score - a.score);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
