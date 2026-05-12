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
import { autoDetectDetail, classifyQuery } from './query-intent.ts';
import { expandAnchors, hydrateChunks } from './two-pass.ts';

const RRF_K = 60;
const COMPILED_TRUTH_BOOST = 2.0;
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

/**
 * v0.29.1 — apply salience boost (emotional_weight + take_count, NO time
 * component). Mirror of applyBacklinkBoost. Mutate-in-place; caller re-sorts.
 *
 * `scores` is keyed by `${source_id}::${slug}` (composite) so multi-source
 * brains don't conflate same-slug pages across sources (codex pass-1 #3).
 *
 * strength: 'on' (k=0.15) or 'strong' (k=0.30); 'off' callers should not
 * invoke this function. Logarithmic compression keeps the factor in
 * [1.0, ~1.6] so a strong boost can't catastrophically flip rankings.
 */
export function applySalienceBoost(
  results: SearchResult[],
  scores: Map<string, number>,
  strength: 'on' | 'strong',
): void {
  const k = strength === 'strong' ? 0.30 : 0.15;
  for (const r of results) {
    const key = `${r.source_id ?? 'default'}::${r.slug}`;
    const score = scores.get(key);
    if (!score || score <= 0) continue;
    r.score *= (1.0 + k * Math.log(1 + score));
  }
}

/**
 * v0.29.1 — apply per-prefix recency boost. Mutate-in-place; caller re-sorts.
 *
 * `dates` is keyed by `${source_id}::${slug}`. The boost factor for each
 * page comes from the per-prefix decay map: `1 + coefficient × halflife /
 * (halflife + days_old)`. Evergreen prefixes (halflifeDays=0) contribute 0
 * (factor stays 1.0).
 *
 * strength: 'on' multiplies the coefficient by 1.0; 'strong' multiplies by
 * 1.5 (more aggressive recency tilt). Pages with no date entry in the map
 * are skipped (factor 1.0).
 */
export function applyRecencyBoost(
  results: SearchResult[],
  dates: Map<string, Date>,
  strength: 'on' | 'strong',
  decayMap: import('./recency-decay.ts').RecencyDecayMap,
  fallback: import('./recency-decay.ts').RecencyDecayConfig,
  nowMs: number = Date.now(),
): void {
  const strengthMul = strength === 'strong' ? 1.5 : 1.0;
  // Sort prefixes longest-first so 'media/articles/' matches before 'media/'.
  const prefixes = Object.keys(decayMap).sort((a, b) => b.length - a.length);

  for (const r of results) {
    const key = `${r.source_id ?? 'default'}::${r.slug}`;
    const d = dates.get(key);
    if (!d) continue;
    const daysOld = Math.max(0, (nowMs - d.getTime()) / 86_400_000);

    // Find first matching prefix.
    let cfg: import('./recency-decay.ts').RecencyDecayConfig = fallback;
    for (const p of prefixes) {
      if (r.slug.startsWith(p)) {
        cfg = decayMap[p];
        break;
      }
    }

    if (cfg.halflifeDays === 0 || cfg.coefficient === 0) continue; // evergreen
    const recencyComponent = cfg.coefficient * cfg.halflifeDays / (cfg.halflifeDays + daysOld);
    const factor = 1.0 + strengthMul * recencyComponent;
    r.score *= factor;
  }
}

/**
 * v0.29.1 — runPostFusionStages: wrap backlink + salience + recency in a
 * single stage that fires from EVERY hybridSearch return path (codex
 * pass-1 #2 + pass-2 #4: keyword-only, embed-fail-fallback, full-hybrid).
 * Without this wrapper, salience='on' silently does nothing on keyless
 * installs that fall back to keyword-only.
 *
 * Mutates `results` in place; caller re-sorts.
 */
export interface PostFusionOpts {
  applyBacklinks: boolean;
  salience: 'off' | 'on' | 'strong';
  recency: 'off' | 'on' | 'strong';
  decayMap?: import('./recency-decay.ts').RecencyDecayMap;
  fallback?: import('./recency-decay.ts').RecencyDecayConfig;
}

export async function runPostFusionStages(
  engine: import('../engine.ts').BrainEngine,
  results: SearchResult[],
  opts: PostFusionOpts,
): Promise<void> {
  if (results.length === 0) return;

  // Backlink stage (existing behavior, preserved).
  if (opts.applyBacklinks) {
    try {
      const slugs = Array.from(new Set(results.map(r => r.slug)));
      const counts = await engine.getBacklinkCounts(slugs);
      applyBacklinkBoost(results, counts);
    } catch {
      // Non-fatal; preserves the existing pre-v0.29.1 contract.
    }
  }

  // Composite refs for the orthogonal axes (multi-source isolation).
  const refs = Array.from(
    new Map(
      results.map(r => [`${r.source_id ?? 'default'}::${r.slug}`, { slug: r.slug, source_id: r.source_id ?? 'default' }]),
    ).values(),
  );

  // Salience stage (mattering, no time).
  if (opts.salience !== 'off') {
    try {
      const scores = await engine.getSalienceScores(refs);
      applySalienceBoost(results, scores, opts.salience);
    } catch {
      // Non-fatal.
    }
  }

  // Recency stage (per-prefix decay, no mattering).
  if (opts.recency !== 'off') {
    try {
      const dates = await engine.getEffectiveDates(refs);
      const { DEFAULT_RECENCY_DECAY, DEFAULT_FALLBACK } = await import('./recency-decay.ts');
      applyRecencyBoost(
        results,
        dates,
        opts.recency,
        opts.decayMap ?? DEFAULT_RECENCY_DECAY,
        opts.fallback ?? DEFAULT_FALLBACK,
      );
    } catch {
      // Non-fatal.
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
    // v0.33: multi-type filter for whoknows ('person','company'). Pushes
    // type filter to SQL level so the limit budget goes to candidate-typed
    // pages instead of being eaten by note/transcript/article pages.
    types: opts?.types,
    // v0.29.1: since/until take precedence over deprecated afterDate/beforeDate.
    // The engine still consumes the legacy field names; this aliasing keeps
    // PR #618 callers compiling while the new names are the public surface.
    afterDate: opts?.since ?? opts?.afterDate,
    beforeDate: opts?.until ?? opts?.beforeDate,
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

  // v0.29.1: resolve salience/recency from caller (back-compat aliases for
  // PR #618's `recencyBoost` numeric scale) or fall back to the heuristic.
  // The wrapper fires from ALL THREE return paths (codex pass-1 #2 + pass-2 #4).
  const suggestions = classifyQuery(query);
  // Back-compat: recencyBoost: 1|2 → 'on'|'strong'; 0 → 'off'.
  const legacyRecency: 'off' | 'on' | 'strong' | undefined =
    opts?.recencyBoost === 2 ? 'strong' :
    opts?.recencyBoost === 1 ? 'on' :
    opts?.recencyBoost === 0 ? 'off' :
    undefined;
  const salienceMode: 'off' | 'on' | 'strong' = opts?.salience ?? suggestions.suggestedSalience;
  const recencyMode: 'off' | 'on' | 'strong' = opts?.recency ?? legacyRecency ?? suggestions.suggestedRecency;
  const postFusionOpts = {
    applyBacklinks: true,
    salience: salienceMode,
    recency: recencyMode,
  };

  // Skip vector search entirely if the gateway has no embedding provider configured (Codex C3).
  const { isAvailable } = await import('../ai/gateway.ts');
  if (!isAvailable('embedding')) {
    if (keywordResults.length > 0) {
      await runPostFusionStages(engine, keywordResults, postFusionOpts);
      keywordResults.sort((a, b) => b.score - a.score);
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
    // v0.29.1 codex pass-2 #4: this is the third return path. Apply
    // post-fusion stages here too — without it, salience='on' silently
    // does nothing on embed failures.
    if (keywordResults.length > 0) {
      await runPostFusionStages(engine, keywordResults, postFusionOpts);
      keywordResults.sort((a, b) => b.score - a.score);
    }
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

  // v0.29.1: post-fusion stages (backlink + salience + recency) run via
  // runPostFusionStages so all three early-return paths share the same
  // boost surface. Salience and recency are independent axes — either,
  // both, or neither fires depending on resolved modes.
  if (fused.length > 0) {
    await runPostFusionStages(engine, fused, postFusionOpts);
    fused.sort((a, b) => b.score - a.score);
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

  // v0.27.0 PR #618 recency boost was here; v0.29.1 unifies it into
  // runPostFusionStages above so all three return paths get the same
  // treatment. PR #618's recencyBoost: 0|1|2 still works via back-compat
  // aliasing in the postFusionOpts resolver near line ~256.

  // Dedup
  const deduped = dedupResults(fused, dedupOpts);

  // Auto-escalate: if detail=low returned 0, retry with high. The inner
  // call's onMeta fires with the escalated detail_resolved; do NOT also
  // fire here (would double-emit and capture stale meta).
  if (deduped.length === 0 && opts?.detail === 'low') {
    return hybridSearch(engine, query, { ...opts, detail: 'high' });
  }

  emitMeta({ vector_enabled: true, detail_resolved: detailResolved, expansion_applied: expansionApplied });
  return deduped.slice(offset, offset + limit);
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
