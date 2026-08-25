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
import type {
  SearchResult,
  SearchOpts,
  HybridSearchMeta,
  DegradedStage,
  DegradedStageEntry,
  DegradedReason,
} from '../types.ts';
import { embed, embedQuery } from '../embedding.ts';
import { registerBackgroundWorkDrainer } from '../background-work.ts';
import { resolveEmbeddingColumn, isCacheSafe } from './embedding-column.ts';
import { resolveHardExcludes } from './source-boost.ts';
import {
  resolveAdaptiveReturn,
  applyAdaptiveReturn,
  adaptiveReturnFromConfig,
  adaptiveReturnEnabled,
  type AdaptiveReturnDecision,
} from './return-policy.ts';
import { applyAutocut, type AutocutDecision } from './autocut.ts';
import {
  buildRelationalArm,
  ensureRelationalEvidenceSlot,
  type RelationalEvidenceSlotDecision,
} from './relational-recall.ts';
import { loadConfigWithEngine } from '../config.ts';
import { dedupResults } from './dedup.ts';
import { applyReranker } from './rerank.ts';
import {
  classifyQuery,
  classifyQueryWithBrainPatterns,
  isAmbiguousModalityQuery,
  loadEngineIntentPatterns,
  type QuerySuggestions,
} from './query-intent.ts';
import { isTitlePhraseMatch } from './title-match.ts';
import { normalizeAlias } from './alias-normalize.ts';
import { stampEvidence, markKeywordHits } from './evidence.ts';
import { applyExactLookupTier } from './exact-lookup.ts';
import { expandAnchors, hydrateChunks } from './two-pass.ts';
import { enforceTokenBudget, searchSalvageEnabled, type TokenBudgetMeta } from './token-budget.ts';
import { warnOncePerProcess } from '../utils.ts';
import { recordSearchTelemetry } from './telemetry.ts';
import {
  weightsForIntent,
  effectiveRrfK,
  applyExactMatchBoost,
} from './intent-weights.ts';
import {
  SemanticQueryCache,
  loadCacheConfig,
} from './query-cache.ts';

export const RRF_K = 60;
const COMPILED_TRUTH_BOOST = 2.0;

// D-3002: pre-fusion candidate-pool floor. `limit*2` alone starves RRF fusion
// at small limits (limit=10 → a 20-row budget per recall arm) and turns offset
// pagination into a cliff: slice(offset, offset + limit) past the pool returns
// empty pages even when deeper matches exist. Each recall arm fetches at least
// this many candidates (and at least offset + limit), capped by
// MAX_SEARCH_LIMIT. Result-affecting for identical knobs → KNOBS_HASH_VERSION
// bumped to 20 in mode.ts so pre-floor cache rows can't be served post-upgrade.
export const PRE_FUSION_POOL_FLOOR = 50;

/**
 * Which detail levels get the compiled_truth boost (#3430).
 *
 * ONLY `low`. The documented contract (`src/core/operations.ts`) is
 * "low (compiled truth only), medium (default, all with dedup), high (all
 * chunks)" — so `low` is the level that privileges compiled truth, and both
 * `medium` and `high` are supposed to see everything on equal footing.
 *
 * This was previously spelled `detail !== 'high'`, i.e. written as though
 * `high` were the special case. Because COMPILED_TRUTH_BOOST is applied AFTER
 * RRF normalization, and RRF's whole range over a 100-deep pool is 1/60 → 1/160,
 * a 2.0x multiplier is not a tilt — break-even is `2/(60+r) >= 1/60`, so any
 * boosted chunk inside the first 60 ranks outranks an unboosted rank-1 chunk.
 * At the default detail that made search categorically compiled-truth-only:
 * a page whose answer lived in a `fenced_code` chunk returned the prose chunk,
 * and the code chunk fell out of the window entirely.
 *
 * Extracted as a named predicate rather than left inline at three call sites so
 * the detail→boost mapping is directly testable. An inline expression can only
 * be covered through a full `hybridSearch` round trip, which is why the
 * original inversion went unnoticed.
 */
export function shouldBoostCompiledTruth(detail: string | null | undefined): boolean {
  return detail === 'low';
}
const pendingCacheWrites = new Set<Promise<unknown>>();

/**
 * v0.42 (issue #1699) agent-warning channel. Stamps `SearchResult.content_flag`
 * for any result whose page carries a `frontmatter.content_flag` marker (fuzzy
 * markup-heavy / oversize). One batched query over the returned set's page_ids;
 * runs on the FINAL sliced set so the fetch is bounded by `limit`, not the full
 * candidate pool. Fail-open: the warning is best-effort and never breaks search.
 * Mirrors the stampEvidence post-fusion precedent (T4).
 */
export async function stampContentFlags(engine: BrainEngine, results: SearchResult[]): Promise<void> {
  if (results.length === 0) return;
  try {
    const ids = [...new Set(
      results.map((r) => r.page_id).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
    )];
    if (ids.length === 0) return;
    const flags = await engine.getContentFlagsByPageIds(ids);
    if (flags.size === 0) return;
    for (const r of results) {
      const f = flags.get(r.page_id);
      if (f) r.content_flag = f;
    }
  } catch {
    // best-effort: a flag-fetch failure must not break retrieval.
  }
}

/**
 * Extraction quarantine lane (issue #160). Stamps `SearchResult.unverified`
 * for any result whose page is an unverified auto-extracted entity stub
 * (frontmatter `provenance: 'auto-extracted'` + `status: 'unverified'`).
 * MUST run PRE-fusion: rrfFusion/rrfFusionWeighted read the flag to skip the
 * COMPILED_TRUTH_BOOST for these pages, so a stub fabricated by hostile
 * ingested text ranks as ordinary content, never with entity authority.
 * One batched query over the candidate arms' page_ids. Fail-open on the
 * fetch (a marker-fetch failure must not break retrieval) — the boost then
 * applies, but the SQL-side source-boost guard still holds.
 *
 * #4220: the same batched query now surfaces the page's raw
 * `frontmatter.status` value, stamped on `SearchResult.status` for EVERY
 * result whose page carries one (draft/superseded/restricted/verified/...).
 * `unverified` remains the special case requiring the full quarantine pair.
 */
export async function stampUnverifiedExtractions(
  engine: BrainEngine,
  results: SearchResult[],
): Promise<void> {
  if (results.length === 0) return;
  try {
    const ids = [...new Set(
      results.map((r) => r.page_id).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
    )];
    if (ids.length === 0) return;
    const marks = await engine.getUnverifiedExtractionPageIds(ids);
    if (marks.size === 0) return;
    for (const r of results) {
      const m = marks.get(r.page_id);
      if (!m) continue;
      r.status = m.status;
      if (m.unverified) r.unverified = true;
    }
  } catch {
    // best-effort: never break retrieval.
  }
}

/**
 * v0.42.20.0 — bounded drain (was an unbounded `Promise.allSettled`, codex
 * confirmed; TODOS retrofit). Mirrors `awaitPendingLastRetrievedWrites`: races
 * the in-flight cache writes against a timeout and reports leftovers so the
 * background-work registry can move on to disconnect instead of hanging on a
 * wedged cache write. Drops the timed-out snapshot's references so a long-lived
 * process doesn't accumulate forever-pending ghosts.
 */
export async function awaitPendingSearchCacheWrites(
  timeoutMs = 5_000,
): Promise<{ unfinished: number }> {
  if (pendingCacheWrites.size === 0) return { unfinished: 0 };
  const snapshot = [...pendingCacheWrites];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const drain = Promise.allSettled(snapshot).then(() => 'drained' as const);
  const outcome = await Promise.race([drain, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    const unfinished = pendingCacheWrites.size;
    for (const p of snapshot) pendingCacheWrites.delete(p);
    return { unfinished };
  }
  return { unfinished: 0 };
}

/** Test seam — clears the pending cache-write set so each test starts clean. */
export function _resetPendingSearchCacheWritesForTests(): void {
  pendingCacheWrites.clear();
}

function trackCacheWrite(promise: Promise<unknown>): void {
  pendingCacheWrites.add(promise);
  promise.finally(() => pendingCacheWrites.delete(promise)).catch(() => { /* swallow */ });
}

// v0.42.20.0 — register as a background-work sink (order 2; no abort — bare
// cache INSERTs). Drained before CLI disconnect, for BOTH search and query
// (previously only `query` drained it, and unbounded).
registerBackgroundWorkDrainer({
  name: 'search-cache',
  order: 2,
  drain: (ms) => awaitPendingSearchCacheWrites(ms),
});
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
 *
 * v0.35.6.0 — floor-ratio gate. When `floorThreshold` is provided, results
 * with `r.score < floorThreshold` are SKIPPED (no boost applied). NaN scores
 * are also skipped (NaN < x is false in JS, which would otherwise let NaN
 * results bypass the gate). The threshold is an ABSOLUTE score, not a ratio
 * — compute it once at `runPostFusionStages` entry via `computeFloorThreshold`
 * so stage order doesn't change which results clear the gate.
 *
 * The gate is scoped to the three metadata-axis boost stages (backlink +
 * salience + recency). Exact-match boost (`applyExactMatchBoost` in
 * intent-weights.ts) runs independently as a lexical-relevance signal by
 * design.
 */
export function applyBacklinkBoost(
  results: SearchResult[],
  counts: Map<string, number>,
  floorThreshold?: number,
): void {
  for (const r of results) {
    if (!Number.isFinite(r.score)) continue;
    if (floorThreshold !== undefined && r.score < floorThreshold) continue;
    const count = counts.get(r.slug) ?? 0;
    if (count > 0) {
      const factor = 1.0 + BACKLINK_BOOST_COEF * Math.log(1 + count);
      r.score *= factor;
      // v0.40.4 attribution stamp (D12=A) — formatter reads this for
      // --explain output. Stays undefined when count == 0 so the
      // formatter can render "no boosts applied" honestly.
      r.backlink_boost = factor;
    }
  }
}

/**
 * v0.35.6.0 — floor-ratio threshold computation.
 *
 * Returns the absolute score floor below which boost stages skip a result.
 * Returns `Number.NEGATIVE_INFINITY` (no gate) when:
 *   - `floorRatio` is undefined (default — preserves prior behavior bit-for-bit)
 *   - `floorRatio` is NaN, infinite, negative, or > 1 (out-of-range silently
 *     disables the gate; range validation lives at the config-parse layer)
 *   - No result has a positive, finite score (all-NaN, all-negative, or empty
 *     input arrays produce no positive signal — gate stays off)
 *
 * Otherwise returns `topScore * floorRatio`, where `topScore` is the largest
 * finite score in `results`. Callers compute this ONCE before any boost stage
 * runs, then pass the resulting threshold to every stage. Single-baseline
 * semantic — order-independent across the three metadata-axis boosts.
 *
 * Why this exists: gbrain's bounded boosts (`[1.0, ~1.6]` log-compressed
 * salience clip, log-scaled backlinks, half-life recency) keep any single
 * boost from catastrophically flipping rankings on curated small corpora.
 * On larger corpora indexed with dense embedders (text-embedding-3-large,
 * Voyage 3+, ZeroEntropy zembed-1), weak-overlap candidates can land in
 * top-K via baseline vector overlap and accumulate metadata boost until
 * they leapfrog the legitimate primary hit. The gate restricts each
 * metadata boost to the head of the candidate pool so the long tail keeps
 * its unboosted relevance ranking.
 *
 * 0.85 is a reasonable starting value for dense-embedder corpora. Default
 * stays undefined (no gate) until per-corpus ablation evidence supports a
 * default flip (see `TODOS.md` floor-ratio ablation entry).
 */
export function computeFloorThreshold(
  results: SearchResult[],
  floorRatio: number | undefined,
): number {
  if (floorRatio === undefined) return Number.NEGATIVE_INFINITY;
  if (!Number.isFinite(floorRatio) || floorRatio < 0 || floorRatio > 1) {
    return Number.NEGATIVE_INFINITY;
  }
  let top = Number.NEGATIVE_INFINITY;
  for (const r of results) {
    if (Number.isFinite(r.score) && r.score > top) top = r.score;
  }
  if (!Number.isFinite(top) || top <= 0) return Number.NEGATIVE_INFINITY;
  return top * floorRatio;
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
  floorThreshold?: number,
): void {
  const k = strength === 'strong' ? 0.30 : 0.15;
  for (const r of results) {
    if (!Number.isFinite(r.score)) continue;
    if (floorThreshold !== undefined && r.score < floorThreshold) continue;
    const key = `${r.source_id ?? 'default'}::${r.slug}`;
    const score = scores.get(key);
    if (!score || score <= 0) continue;
    const factor = 1.0 + k * Math.log(1 + score);
    r.score *= factor;
    // v0.40.4 attribution stamp (D12=A).
    r.salience_boost = factor;
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
  floorThreshold?: number,
): void {
  const strengthMul = strength === 'strong' ? 1.5 : 1.0;
  // Sort prefixes longest-first so 'media/articles/' matches before 'media/'.
  const prefixes = Object.keys(decayMap).sort((a, b) => b.length - a.length);

  for (const r of results) {
    if (!Number.isFinite(r.score)) continue;
    if (floorThreshold !== undefined && r.score < floorThreshold) continue;
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
    // v0.40.4 attribution stamp (D12=A).
    r.recency_boost = factor;
  }
}

/**
 * T2 (retrieval-maxpool incident) — apply the title-phrase boost.
 *
 * Fires when the normalized query is a contiguous token-run inside a result's
 * page title (or an exact full-title match), per `isTitlePhraseMatch`. Mutate-
 * in-place; caller re-sorts. Mirrors applyBacklinkBoost's floor-gate + stamp.
 *
 * Bounded by construction: a single fixed multiplier (`factor`, default 1.25),
 * floor-ratio-gated so a title hit on a weak-overlap page can't leapfrog a
 * strong primary hit. `base_score` (stamped at runPostFusionStages entry) is
 * NOT touched, so the agent's dedup gate still reads true match confidence.
 *
 * Why page.title and not "first compiled_truth chunk" (Codex#11): the title is
 * a stable column; the first chunk is a chunking accident that import changes
 * could shift. The signal is "the query is the name of this thing."
 */
export function applyTitleBoost(
  results: SearchResult[],
  query: string,
  factor: number,
  floorThreshold?: number,
): void {
  if (!query || !Number.isFinite(factor) || factor <= 1.0) return;
  for (const r of results) {
    if (!Number.isFinite(r.score)) continue;
    if (floorThreshold !== undefined && r.score < floorThreshold) continue;
    if (!r.title) continue;
    if (isTitlePhraseMatch(query, r.title)) {
      r.score *= factor;
      r.title_match_boost = factor; // attribution stamp (v0.40.4 convention)
    }
  }
}

/** Default title-phrase boost multiplier (mode-overridable via `title_boost`). */
export const DEFAULT_TITLE_BOOST = 1.25;

/**
 * v0.42.x — Life Chronicle (#2390) E1 temporal recall arm. On temporal queries
 * (the caller gates this on recency !== 'off'), give chronicle `event`/`diary`
 * pages a bounded boost so the timeline surfaces for "what happened…" / "when
 * did…" queries — ambient temporality without a separate recall arm. Bounded
 * ([1.0, 1.25]) + floor-gated like the other metadata stages, so it can't
 * leapfrog a strong primary hit. Mutate-in-place; caller re-sorts. Pure no-op
 * for non-chronicle results. NOT called on non-temporal queries (recency='off'),
 * so ordinary search is bit-for-bit unchanged.
 */
export function applyChronicleTypeBoost(
  results: SearchResult[],
  strength: 'on' | 'strong',
  floorThreshold?: number,
): void {
  const factor = strength === 'strong' ? 1.25 : 1.15;
  for (const r of results) {
    if (!Number.isFinite(r.score)) continue;
    if (floorThreshold !== undefined && r.score < floorThreshold) continue;
    if (r.type === 'event' || r.type === 'diary') {
      r.score *= factor;
      r.chronicle_boost = factor;
    }
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
  /**
   * v0.35.6.0 — floor-ratio gate (opt-in, default off). When set, each
   * metadata-axis boost stage (backlink, salience, recency) skips results
   * whose score is below `floorRatio * topScore`. Threshold is computed
   * ONCE at runPostFusionStages entry from the post-cosine-rescore score
   * snapshot, then passed uniformly to all three stages — order-independent.
   *
   * Default undefined preserves prior behavior bit-for-bit. Sensible values
   * for dense-embedder corpora: 0.85-0.95. See `computeFloorThreshold` for
   * the empirical motivation and out-of-range handling.
   *
   * SCOPE: gates the three metadata stages only. Exact-match boost
   * (`applyExactMatchBoost`) runs AFTER `runPostFusionStages` and is NOT
   * gated — it's a lexical-relevance signal, different in kind from
   * metadata boosts.
   *
   * v0.40.4: scope extended to the new graph_signals stage. Graph
   * signals are a metadata-axis boost like backlink/salience/recency
   * — same floor-gate inheritance prevents the weak-page-becomes-hub
   * regression (codex T2 / D1=A in v0.40.4 plan).
   */
  floorRatio?: number;
  /**
   * v0.40.4 — gate for the graph-signals stage (4th post-fusion stage).
   * False short-circuits to no-op. When true, applyGraphSignals fires
   * AFTER backlink/salience/recency so it stacks on top of metadata
   * boosts. Resolved from ModeBundle.graph_signals by the caller.
   */
  graphSignalsEnabled?: boolean;
  /**
   * v0.40.4 — observability sink for graph-signal fire counts. Threaded
   * through hybridSearch.onMeta so eval-capture sees per-query metrics.
   */
  onGraphMeta?: (meta: import('./graph-signals.ts').GraphSignalsMeta) => void;
  /**
   * v0.40.4 — observability sink for score-distribution stats (top-K
   * min/p25/p50/p75/p95/max + reorder_band_width). Always emitted when
   * graphSignalsEnabled is true. Feeds T-todo-2 magnitude calibration
   * wave via search-stats.
   */
  onScoreDistribution?: (dist: import('./graph-signals.ts').ScoreDistribution) => void;
  /**
   * T2 — the raw query string, needed by the title-phrase boost stage.
   * Undefined disables the stage (e.g. image-only queries).
   */
  query?: string;
  /**
   * T2 — title-phrase boost multiplier (mode-resolved from `title_boost`).
   * <= 1.0 or undefined disables the stage. Floor-ratio-gated like the
   * metadata stages so a title hit can't bury a strong semantic match.
   */
  titleBoost?: number;
}

export async function runPostFusionStages(
  engine: import('../engine.ts').BrainEngine,
  results: SearchResult[],
  opts: PostFusionOpts,
): Promise<void> {
  if (results.length === 0) return;

  // v0.40.4 attribution stamp (D12=A) — capture base_score ONCE at entry,
  // BEFORE any boost mutates r.score. Without this, --explain can't
  // reconstruct the pre-boost score. Idempotent: if base_score is
  // already populated (caller stamped upstream), preserve it.
  for (const r of results) {
    if (r.base_score === undefined) {
      r.base_score = r.score;
    }
  }

  // v0.35.6.0 [floor-ratio gate]: compute threshold ONCE at entry, BEFORE any
  // boost mutates scores. Single-baseline semantic — the same threshold gates
  // all three downstream stages. This is intentionally different from a
  // per-stage recompute (which would couple stage order to gating decisions);
  // see plan `swift-sniffing-nygaard.md` D6 / codex outside-voice T2.
  const floorThreshold = computeFloorThreshold(results, opts.floorRatio);

  // Backlink stage (existing behavior, preserved).
  if (opts.applyBacklinks) {
    try {
      const slugs = Array.from(new Set(results.map(r => r.slug)));
      const counts = await engine.getBacklinkCounts(slugs);
      applyBacklinkBoost(results, counts, floorThreshold);
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
      applySalienceBoost(results, scores, opts.salience, floorThreshold);
    } catch {
      // Non-fatal.
    }
  }

  // Recency stage (per-prefix decay, no mattering).
  if (opts.recency !== 'off') {
    try {
      const dates = await engine.getEffectiveDates(refs);
      // Resolve the effective decay map (defaults + gbrain.yml `recency:` +
      // GBRAIN_RECENCY_DECAY env) instead of the baked-in defaults. The
      // get_recent_salience SQL path already goes through resolveRecencyDecayMap()
      // (see sql-ranking.ts); using DEFAULT_RECENCY_DECAY directly here meant the
      // hot hybridSearch path silently ignored operator overrides, leaving
      // non-default vault layouts on DEFAULT_FALLBACK regardless of tuning.
      const { resolveRecencyDecayMap, DEFAULT_FALLBACK } = await import('./recency-decay.ts');
      applyRecencyBoost(
        results,
        dates,
        opts.recency,
        opts.decayMap ?? resolveRecencyDecayMap(),
        opts.fallback ?? DEFAULT_FALLBACK,
        Date.now(),
        floorThreshold,
      );
    } catch {
      // Non-fatal.
    }

    // v0.42.x — Life Chronicle (#2390) E1: chronicle event/diary type boost.
    // Gated INSIDE the recency!=off branch so it fires ONLY on temporal queries;
    // non-temporal search never reaches here → bit-for-bit unchanged. Shares the
    // floor threshold so it can't leapfrog a strong primary hit.
    applyChronicleTypeBoost(results, opts.recency, floorThreshold);
  }

  // T2 — title-phrase boost. Runs after the metadata stages, before graph
  // signals. Shares the single floor-threshold so a title hit on a weak page
  // can't leapfrog a strong primary hit (Codex#10). Fail-soft: pure + in-memory,
  // but guarded so a bad query/title can't throw the whole pipeline.
  if (opts.query && opts.titleBoost && opts.titleBoost > 1.0) {
    try {
      applyTitleBoost(results, opts.query, opts.titleBoost, floorThreshold);
    } catch {
      // Non-fatal; preserves the per-stage contract.
    }
  }

  // v0.40.4 — graph-signals stage (4th post-fusion stage). Runs AFTER
  // backlink/salience/recency so it stacks on top of metadata boosts;
  // shares the same floor-threshold so a weak hub gets the same
  // protection v0.35.6.0 added for other metadata boosts. Fail-open at
  // this level matches the per-stage non-fatal contract.
  if (opts.graphSignalsEnabled) {
    try {
      const { applyGraphSignals } = await import('./graph-signals.ts');
      await applyGraphSignals(results, engine, {
        enabled: true,
        floorThreshold,
        onMeta: opts.onGraphMeta,
        onScoreDistribution: opts.onScoreDistribution,
      });
    } catch {
      // Non-fatal; preserves the per-stage contract.
    }
  }

  // v0.42 (T19, plan D6) — alias_resolved stage (5th post-fusion stage).
  // Runs LAST so its 1.05x multiplier stacks on top of every other boost.
  // Fires when the result's slug is a canonical_slug in slug_aliases —
  // the page is the authoritative version of one or more aliases. Signal
  // intent: "user explicitly disambiguated this as canonical." Defense-
  // in-depth: pre-v105 brains don't have slug_aliases table; the lookup
  // throws isUndefinedTableError and the stage no-ops.
  try {
    await applyAliasResolvedBoost(results, engine);
  } catch {
    // Non-fatal; preserves the per-stage contract.
  }

  // supersession stage — runs LAST so the penalty applies to the fully-boosted
  // score. Down-ranks results whose page is the target of a `supersedes` link
  // (a newer/canon page supersedes it) and stamps `superseded`/`superseded_by`
  // for --explain, the contradiction probe, and agent renderers. The page-level
  // analogue of the superseded_by/expired_at awareness recall.ts applies to
  // facts. Fail-open per the per-stage contract: a brain with no `supersedes`
  // edges (or a pre-links schema) finds 0 rows / throws and no-ops.
  try {
    await applySupersedeDownrank(results, engine);
  } catch {
    // Non-fatal; preserves the per-stage contract.
  }
}

/**
 * Memoized per-engine gate for the supersession stage. Most brains carry zero
 * `supersedes` edges, so the downrank lookup would be a wasted roundtrip on
 * every search. One existence probe per engine per TTL answers "any edges at
 * all?"; false skips the stage entirely. A fresh edge minted inside the TTL
 * window is invisible for up to ~5 minutes — an acceptable delay for a
 * ranking hint (the downrank applies on the next probe refresh). Fail-open: a
 * probe error must never kill search — the stage runs and its own catch
 * no-ops on the same underlying failure (e.g. pre-links schema).
 */
const SUPERSEDE_PROBE_TTL_MS = 5 * 60 * 1000;
let supersedeEdgeProbe = new WeakMap<
  import('../engine.ts').BrainEngine,
  { at: number; exists: boolean }
>();

/** Test seam: drop memoized supersede-edge probes (WeakMap has no clear()). */
export function _resetSupersedeProbeForTests(): void {
  supersedeEdgeProbe = new WeakMap();
}

async function hasAnySupersedeEdges(
  engine: import('../engine.ts').BrainEngine,
): Promise<boolean> {
  const cached = supersedeEdgeProbe.get(engine);
  if (cached && Date.now() - cached.at < SUPERSEDE_PROBE_TTL_MS) return cached.exists;
  try {
    const rows = await engine.executeRaw<{ one: number }>(
      `SELECT 1 AS one FROM links WHERE link_type = 'supersedes' LIMIT 1`,
    );
    const exists = rows.length > 0;
    supersedeEdgeProbe.set(engine, { at: Date.now(), exists });
    return exists;
  } catch {
    // Fail-open; not cached so a transient error doesn't pin the gate open.
    return true;
  }
}

/**
 * Down-rank results whose page is superseded by a newer/canon page, and stamp
 * the SUPERSEDED annotation.
 *
 * A page X is "superseded" when it is the `to_page_id` of a `supersedes` link
 * (`A supersedes B` → from=A canon, to=B stale). This is the page-level
 * analogue of the `superseded_by`/`expired_at` awareness recall.ts already
 * applies to the facts table. Stamps `superseded=true`, `superseded_by` (the
 * superseding page's slug), and multiplies score by SUPERSEDE_PENALTY so
 * current canon out-scores stale material without hiding it — the flag lets
 * callers still surface it, and it is authoritative even in reranked modes
 * where the cross-encoder owns the final head order.
 *
 * Single index-hit query bounded by top-K (links.to_page_id is indexed;
 * `supersedes` edges are sparse). Lookup is by page_id array, but supersession
 * is WITHIN-SOURCE only (matches relational-recall's contract): a cross-source
 * `supersedes` edge neither downranks nor leaks the superseding slug across
 * the source boundary, and a soft-deleted superseder no longer counts.
 * Fail-soft: a brain with no `supersedes` edges (or a pre-links schema)
 * returns 0 rows / throws and the stage no-ops (matches
 * applyAliasResolvedBoost's pre-v104 guard).
 */
export const SUPERSEDE_PENALTY = 0.5;

export async function applySupersedeDownrank(
  results: SearchResult[],
  engine: import('../engine.ts').BrainEngine,
): Promise<void> {
  if (results.length === 0) return;
  const pageIds = Array.from(
    new Set(results.map(r => r.page_id).filter((id): id is number => typeof id === 'number')),
  );
  if (pageIds.length === 0) return;
  if (!(await hasAnySupersedeEdges(engine))) return;
  let rows: Array<{ to_page_id: number; by_slug: string }> = [];
  try {
    rows = await engine.executeRaw<{ to_page_id: number; by_slug: string }>(
      `SELECT DISTINCT l.to_page_id, pf.slug AS by_slug
         FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
        WHERE l.link_type = 'supersedes'
          AND pf.deleted_at IS NULL
          AND pf.source_id = pt.source_id
          AND l.to_page_id = ANY($1::bigint[])`,
      [pageIds],
    );
  } catch {
    // Pre-links schema or SQL miss; no-op.
    return;
  }
  if (rows.length === 0) return;
  const supersededBy = new Map<number, string>();
  for (const row of rows) {
    const id = Number(row.to_page_id);
    if (!supersededBy.has(id)) supersededBy.set(id, row.by_slug);
  }
  for (const r of results) {
    const by = supersededBy.get(r.page_id);
    if (by !== undefined) {
      r.score *= SUPERSEDE_PENALTY;
      r.superseded = true;
      r.superseded_by = by;
      r.supersede_penalty = SUPERSEDE_PENALTY;
    }
  }
}

/**
 * v0.42 (T19) — apply 1.05x boost to results whose slug is a canonical_slug
 * in slug_aliases. Stamps `alias_resolved_boost` on touched results so
 * --explain can render the contribution.
 *
 * Single index-hit query bounded by top-K (slug_aliases is small relative
 * to the result set; ALIASES <<< PAGES even on the 186K-page production
 * brain where 5.5K aliases is ~3% of pages).
 *
 * Source-scoped (codex F9: keyed by {source_id, slug} not just slug).
 */
const ALIAS_RESOLVED_BOOST = 1.05;

async function applyAliasResolvedBoost(
  results: SearchResult[],
  engine: import('../engine.ts').BrainEngine,
): Promise<void> {
  if (results.length === 0) return;
  // Build the (source_id, slug) composite list for the lookup.
  const refs = Array.from(
    new Map(
      results.map(r => [
        `${r.source_id ?? 'default'}::${r.slug}`,
        { slug: r.slug, source_id: r.source_id ?? 'default' },
      ]),
    ).values(),
  );
  if (refs.length === 0) return;
  // Find which refs are canonical of any slug_aliases row.
  // Two-array unnest for source-scoped composite lookup.
  const sourceIds = refs.map(r => r.source_id);
  const slugs = refs.map(r => r.slug);
  let rows: Array<{ source_id: string; canonical_slug: string }> = [];
  try {
    rows = await engine.executeRaw<{ source_id: string; canonical_slug: string }>(
      `SELECT DISTINCT source_id, canonical_slug
       FROM slug_aliases
       WHERE (source_id, canonical_slug) IN (
         SELECT * FROM unnest($1::text[], $2::text[])
       )`,
      [sourceIds, slugs],
    );
  } catch {
    // Pre-v104 brain or other SQL miss; no-op.
    return;
  }
  if (rows.length === 0) return;
  const canonicalSet = new Set(rows.map(r => `${r.source_id}::${r.canonical_slug}`));
  for (const r of results) {
    const key = `${r.source_id ?? 'default'}::${r.slug}`;
    if (canonicalSet.has(key)) {
      r.score *= ALIAS_RESOLVED_BOOST;
      r.alias_resolved_boost = ALIAS_RESOLVED_BOOST;
    }
  }
}

// T3 — free-text alias hop tuning.
const ALIAS_HOP_PRESENT_BOOST = 1.10; // bounded boost when canonical already in results
const MAX_ALIAS_QUERY_TOKENS = 6;     // skip long queries (clearly not a chosen name)
const MAX_ALIAS_INJECT = 3;           // cap injected pages per query (collision safety)

/**
 * T3 — free-text alias hop (retrieval-maxpool incident, the named-thing fix).
 *
 * When the normalized query EXACTLY matches a page's declared alias
 * ("Hall of Light" / "明堂" -> the Mingtang page), make sure that page is in
 * the result set: boost it if already present, inject it at top-of-organic +
 * epsilon if absent. This is the only layer that bridges true synonyms with
 * zero surface overlap — neither max-pool nor title-boost can.
 *
 * Precision guards (Codex#7/#10):
 *   - FULL normalized-query exact match only (not substring / not n-grams) —
 *     "light" won't fire unless the whole query normalizes to a stored alias.
 *   - skip queries longer than MAX_ALIAS_QUERY_TOKENS (clearly prose, not a name).
 *   - bounded: present-boost is 1.10x; inject score is top-of-organic + ε,
 *     never an absolute 1.0 (D3 — aliases are not a ranking sledgehammer).
 *   - collisions (two pages claim one alias): deterministic alpha order, capped.
 *
 * Fail-open: pre-v110 brains (no page_aliases table) and any lookup error
 * degrade to the input unchanged (D9). Returns a NEW array; caller re-slices.
 */
export async function applyAliasHop(
  engine: import('../engine.ts').BrainEngine,
  results: SearchResult[],
  query: string,
  opts: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean },
): Promise<SearchResult[]> {
  if (!query) return results;
  const qNorm = normalizeAlias(query);
  if (!qNorm || qNorm.split(' ').length > MAX_ALIAS_QUERY_TOKENS) return results;

  let aliasMap: Map<string, Array<{ slug: string; source_id: string }>>;
  try {
    aliasMap = await engine.resolveAliases([qNorm], { sourceId: opts.sourceId, sourceIds: opts.sourceIds });
  } catch {
    return results; // pre-v110 table-missing OR transient error -> fail-open
  }
  const refs = aliasMap.get(qNorm);
  if (!refs || refs.length === 0) return results;

  // Deterministic + capped. Source-scoped: each canonical is a (source_id, slug)
  // pair so a federated caller boosts/injects the RIGHT source's page, never
  // collapsing or cross-injecting (P0 source-isolation contract).
  const ordered = [...refs]
    .sort((a, b) => (a.source_id === b.source_id ? a.slug.localeCompare(b.slug) : a.source_id.localeCompare(b.source_id)))
    .slice(0, MAX_ALIAS_INJECT);
  const out = [...results];
  const topScore = out.reduce((m, r) => (Number.isFinite(r.score) && r.score > m ? r.score : m), 0);
  let injectScore = topScore > 0 ? topScore : 1.0;

  for (const ref of ordered) {
    const idx = out.findIndex(r => r.slug === ref.slug && (r.source_id ?? 'default') === ref.source_id);
    if (idx >= 0) {
      if (Number.isFinite(out[idx].score)) out[idx].score *= ALIAS_HOP_PRESENT_BOOST;
      out[idx].alias_hit = true;
      continue;
    }
    // Absent canonical: fetch (in its OWN source) + inject at top-of-organic + epsilon.
    let page;
    try {
      page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
    } catch {
      continue;
    }
    if (!page) continue;
    // #4352 — the alias inject path bypasses the engines' SQL visibility
    // clause (getPage, not search); re-apply the private predicate here so
    // an untrusted caller can't hop into a `visibility: private` page.
    if (
      opts.excludePrivate &&
      ((page.frontmatter as Record<string, unknown> | null | undefined)?.visibility === 'private')
    ) continue;
    injectScore += 1e-6;
    out.push({
      // #2339-sibling: include page_id. The `as SearchResult` cast hid its
      // absence, so any consumer reading page_id off an alias-injected result got
      // undefined — e.g. listActiveTakesForPages bound undefined/NaN into
      // ANY($1::int[]) and crashed the contradiction probe on real Postgres.
      page_id: page.id,
      slug: page.slug,
      title: page.title,
      type: page.type,
      source_id: page.source_id ?? ref.source_id,
      chunk_text: (page.compiled_truth ?? '').slice(0, 200),
      chunk_index: 0,
      chunk_id: 0,
      score: injectScore,
      base_score: injectScore,
      alias_hit: true,
    } as SearchResult);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export interface HybridSearchOpts extends SearchOpts {
  expansion?: boolean;
  /** v0.43 — observability sink for the relational recall arm (fired/no-op,
   *  kind, seeds resolved, candidates, errored). Best-effort. */
  onRelationalMeta?: (meta: import('./relational-recall.ts').RelationalArmMeta) => void;
  /**
   * T4/D5 — per-call search-mode selector (one of SEARCH_MODES). Selects the
   * whole mode bundle for this call, overriding the server-configured mode.
   * The op layer passes this ONLY for trusted/local callers (ctx.remote ===
   * false); remote callers leave it undefined so they can't escalate to the
   * costly tokenmax bundle. Unknown values fall back to the default bundle.
   */
  mode?: string;
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
  /**
   * v0.42.20.0 (Fix 3, #1775) INTERNAL — shared query-embed deadline threaded
   * from `hybridSearchCached` into the inner `hybridSearch` so the cache-lookup
   * embed and the inner embed share ONE wall-clock budget (worst case ~one
   * timeout, not two). Direct `hybridSearch` callers leave it undefined and get
   * a fresh per-call deadline. Not part of the public contract.
   */
  _queryEmbedDeadline?: QueryEmbedDeadline;

  /**
   * Hermetic eval canaries/CI — non-semantic embeddings. When set, the query
   * embedding for the TEXT vector arm comes from this function (e.g. qrels
   * basis vectors) INSTEAD of the gateway's query-embed path, and the
   * no-embedding-provider keyword-only short-circuit is bypassed — so the
   * vector arm runs with no provider key configured at all. Never set on
   * production paths; when absent, behavior is byte-for-byte unchanged.
   *
   * Cache note: bare `hybridSearch` neither reads nor writes the semantic
   * query cache by construction — both the lookup and the store live only in
   * `hybridSearchCached` — so a deterministic-embedding eval run through this
   * seam cannot poison `query_cache` for production queries.
   */
  queryEmbedFn?: (text: string) => Float32Array | Promise<Float32Array>;

  /**
   * INTERNAL — cache-consult outcome threaded from `hybridSearchCached` into
   * the inner `hybridSearch` so the ONE telemetry record per search (emitted
   * by the inner function) carries the cache classification: 'miss' when the
   * semantic cache was consulted and had no row, 'disabled' when the consult
   * was skipped (cache off, walk/near-symbol/non-default-column/adaptive
   * skip, or the lookup embed failed). Folded into the RECORDED meta only —
   * `onMeta` payloads are unchanged. Direct `hybridSearch` callers leave it
   * undefined and keep recording with no cache field (they never consulted
   * the cache). The cache-HIT record is emitted by `hybridSearchCached`
   * itself, since the inner function never runs on a hit. Not part of the
   * public contract.
   */
  _telemetryCacheStatus?: 'miss' | 'disabled';
}

/**
 * v0.42.20.0 (Fix 3, #1775) — bound the query-time embed so a stalled provider
 * (the user's zeroentropy case) fails over to keyword instead of hanging past
 * the CLI's 10s force-exit. Default 6s leaves headroom under that deadline.
 */
const QUERY_EMBED_TIMEOUT_MS = (() => {
  const n = Number(process.env.GBRAIN_QUERY_EMBED_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 6_000;
})();

/**
 * Floor for the remaining shared-deadline budget at each embed call (codex).
 * The shared deadline is absolute from `hybridSearchCached` entry, so slow
 * expansion/keyword (or a 6s cache-lookup stall) before the inner embed could
 * leave ~0 budget and starve a HEALTHY embed into a false keyword-only result.
 * Flooring guarantees every embed gets at least this long, so a fast healthy
 * embed (~0.5s) always succeeds. Worst case under a stalled provider on the
 * cache-miss path: cache-lookup (6s) + inner floor (2s) = 8s, still under the
 * 10s CLI force-exit.
 */
const MIN_QUERY_EMBED_BUDGET_MS = 2_000;

export interface QueryEmbedDeadline {
  /** Aborts the underlying fetch (clean socket close) when the budget elapses. */
  signal: AbortSignal;
  /** Absolute wall-clock deadline (ms epoch) — shared so a second embed sees the elapsed budget. */
  deadlineAt: number;
}

export function makeQueryEmbedDeadline(ms = QUERY_EMBED_TIMEOUT_MS): QueryEmbedDeadline {
  return { signal: AbortSignal.timeout(ms), deadlineAt: Date.now() + ms };
}

/**
 * Embed a query bounded by the shared deadline. Two layers: (1) `abortSignal`
 * aborts the fetch so the socket closes and the process can exit clean; (2) a
 * `Promise.race` against the REMAINING budget GUARANTEES the await rejects even
 * if a wedged provider ignores the abort. On rejection the caller's existing
 * try/catch falls back to keyword. The losing embed promise's late rejection is
 * swallowed so it never surfaces as an unhandledRejection.
 */
export async function embedQueryBounded(
  text: string,
  embedOpts: { embeddingModel?: string; dimensions?: number } | undefined,
  dl: QueryEmbedDeadline,
): Promise<Float32Array> {
  // Floor the budget so a healthy embed isn't starved when the shared absolute
  // deadline was mostly consumed by prior work (codex). Still bounded overall.
  const remaining = Math.max(MIN_QUERY_EMBED_BUDGET_MS, dl.deadlineAt - Date.now());
  const signal = AbortSignal.timeout(remaining);
  const p = embedQuery(text, { ...(embedOpts ?? {}), abortSignal: signal });
  p.catch(() => { /* swallow the loser's late rejection */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`query embed deadline ${QUERY_EMBED_TIMEOUT_MS}ms exceeded`)),
      remaining,
    );
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * #3442 — resolve the public `since`/`until` contract (SearchOpts v0.29.1):
 * ISO-8601 passes through, relative durations ('7d', '2w', '1y') resolve to a
 * concrete timestamp, and a plain YYYY-MM-DD `until` lands at end-of-day.
 * The relative form was documented since v0.29.1 but never implemented — the
 * raw string ('60d') flowed into the engines' `::timestamptz` casts, every
 * arm failed fail-open, and the date filter was SILENTLY ignored.
 * Unparseable input now throws loudly instead of degrading.
 */
export function resolveDateBoundary(
  raw: string | undefined,
  boundary: 'since' | 'until',
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;
  const rel = /^(\d+)\s*([dwmy])$/i.exec(s);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    // m = months (30d). Minutes make no sense for an effective_date filter.
    const days = unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : n * 365;
    return new Date(Date.now() - days * 86400000).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Plain date: `until` lands at end-of-day (documented SearchOpts
    // semantics); `since` keeps UTC start-of-day.
    return boundary === 'until' ? `${s}T23:59:59.999Z` : s;
  }
  if (Number.isFinite(Date.parse(s))) return s;
  throw new Error(
    `Invalid ${boundary} value "${s}" — expected ISO-8601 (YYYY-MM-DD or timestamp) or a relative duration like '7d', '2w', '1y'.`,
  );
}

/**
 * WP2/T3 — classify an embed/vector failure as a timeout vs a provider
 * error for the enumerated degraded[] reason codes (D6). Matches both the
 * embedQueryBounded deadline rejection and AbortSignal.timeout's
 * TimeoutError/AbortError. The raw error text never rides the wire — it
 * goes to stderr via warnOncePerProcess only.
 */
function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (/deadline \d+ms exceeded/.test(err.message)) return true;
  return err.name === 'TimeoutError' || err.name === 'AbortError';
}

/** WP2/T3 — append a degraded stage once (stages are set-like per response). */
function pushDegraded(
  list: DegradedStageEntry[],
  stage: DegradedStage,
  reason?: DegradedReason,
): void {
  if (list.some((d) => d.stage === stage)) return;
  list.push(reason ? { stage, reason } : { stage });
}

/**
 * WP2/T3 — budget-stage stamp shared by the enforceTokenBudget call sites.
 * Two distinct stages so consumers can tell "empty" from "clipped":
 * budget_truncated when the minKeep failsafe kept one truncated copy
 * (results non-empty); budget_dropped_all when the strict packer returned
 * [] (kept 0 with drops, under GBRAIN_SEARCH_SALVAGE=off).
 */
function stampBudgetStage(list: DegradedStageEntry[], meta: TokenBudgetMeta): void {
  if (meta.truncated) pushDegraded(list, 'budget_truncated', 'first_result_truncated');
  else if (meta.kept === 0 && meta.dropped > 0) pushDegraded(list, 'budget_dropped_all');
}

export async function hybridSearch(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts,
): Promise<SearchResult[]> {
  // v0.32.3 search-lite mode: resolve the active mode + per-key overrides
  // once at entry. Mode supplies DEFAULTS for intentWeighting, tokenBudget,
  // expansion, and searchLimit when the caller leaves those undefined.
  // Per-call opts and per-key config overrides still win.
  //
  // This MUST live in bare hybridSearch (NOT just in hybridSearchCached)
  // because eval-replay and eval-longmemeval call bare hybridSearch — and
  // per-mode evals would not test production search if modes lived only in
  // the wrapper. See `[CDX-5+6]` in the plan.
  const { loadSearchModeConfig, resolveSearchMode } = await import('./mode.ts');
  const modeInput = await loadSearchModeConfig(engine);
  const resolvedMode = resolveSearchMode({
    // T4/D5 — per-call mode selector (e.g. `--mode tokenmax`). The op layer
    // only passes this for trusted/local callers; remote callers leave it
    // undefined and fall through to the server-configured mode (no cost
    // escalation). Unknown values fall back to the default in resolveSearchMode.
    mode: opts?.mode ?? modeInput.mode,
    overrides: modeInput.overrides,
    perCall: {
      intentWeighting: opts?.intentWeighting,
      tokenBudget: opts?.tokenBudget,
      expansion: opts?.expansion,
      searchLimit: opts?.limit,
      // v0.35.6.0 — floor-ratio gate thread-through. Per-call value wins
      // over per-key config wins over mode bundle (currently undefined for
      // all 3 bundles — pending ablation evidence).
      floor_ratio: opts?.floorRatio,
      // v0.40.4 — graph_signals thread-through. Per-call wins over config
      // override wins over mode bundle. Without this thread the eval gate
      // would be a no-op (both branches resolve to the same mode default).
      graph_signals: opts?.graph_signals,
      // v0.42.3.0 — autocut per-call enable (boolean ceiling override).
      // `false` forces the full top-K; per-call wins over config + bundle.
      // Non-boolean AutocutInput shapes (Partial) aren't a v1 per-call surface,
      // so only the boolean toggle threads here.
      autocut: typeof opts?.autocut === 'boolean' ? opts.autocut : undefined,
      // v0.43 — relational recall per-call thread-through. Per-call wins over
      // config override wins over mode bundle; without this the A/B eval gate
      // would be a no-op (both branches resolve to the same mode default).
      relationalRetrieval: opts?.relationalRetrieval,
      relational_retrieval_depth: opts?.relationalRetrievalDepth,
    },
  });

  // v0.36 (D7+D11): resolve embedding column once at entry. Single
  // round-trip to read DB-plane config (mirrors loadSearchModeConfig).
  // Resolver throws on unknown name with a paste-ready hint; let it
  // propagate — a misconfig should be loud, not silently fall back.
  // Failing cfg load (pre-config brain, mid-migration, no engine.getConfig)
  // falls through to the file-plane sync loadConfig() — same shape, just
  // misses DB-plane overrides.
  const mergedCfg = await loadConfigWithEngine(engine).catch(() => null);
  const cfgForColumn = mergedCfg ?? ((await import('../config.ts')).loadConfig()) ?? null;
  const resolvedCol = cfgForColumn
    ? resolveEmbeddingColumn(opts, cfgForColumn)
    : resolveEmbeddingColumn(opts, { engine: 'pglite' });

  const limit = opts?.limit || resolvedMode.searchLimit;
  const offset = opts?.offset || 0;
  const innerLimit = Math.min(
    Math.max(limit * 2, PRE_FUSION_POOL_FLOOR, offset + limit),
    MAX_SEARCH_LIMIT,
  );

  // v0.32.x search-lite: classify intent once up front. Drives BOTH the
  // legacy auto-detail / salience / recency suggestions AND the new
  // weight-adjustment path. Intent weighting is on by default (off via
  // `opts.intentWeighting = false`; mode bundle supplies the default).
  // #4415: merges the brain's `search.intent_patterns` config over the banks.
  const suggestions = await classifyQueryWithBrainPatterns(engine, query);
  const intentWeightingOn = resolvedMode.intentWeighting;
  const intentWeights = intentWeightingOn
    ? weightsForIntent(suggestions.intent)
    : weightsForIntent('general');

  // Auto-detect detail level from query intent when caller doesn't specify.
  // wave-g: read the pattern-aware suggestion computed above (per-engine
  // banks) rather than the pattern-less autoDetectDetail — the two drifted
  // on the first query of a fresh process before the config was applied.
  const detail = opts?.detail ?? suggestions.suggestedDetail;
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
    // #3442: resolveDateBoundary implements the documented contract (relative
    // durations + end-of-day for plain-date `until`) at this single seam.
    afterDate: resolveDateBoundary(opts?.since ?? opts?.afterDate, 'since'),
    beforeDate: resolveDateBoundary(opts?.until ?? opts?.beforeDate, 'until'),
    // v0.34.1 (#861, D9 — P0 leak seal): thread source-scoping through so the
    // inner engine.searchKeyword / engine.searchVector calls apply the
    // WHERE source_id filter at SQL level. Pre-fix, this explicit pick
    // silently DROPPED these fields and every authenticated MCP client
    // could see pages from foreign sources via the hybrid search hot
    // path. New SearchOpts fields scoped to source isolation MUST be
    // added here too; the rebuild shape is intentional (HNSW inner-CTE
    // ordering means we can't lazy-spread the full opts).
    sourceId: opts?.sourceId,
    sourceIds: opts?.sourceIds,
    // #4352 — page-level private-visibility enforcement is trust-scoped
    // state, same leak class as source scoping above: dropping it here would
    // let an untrusted caller read `visibility: private` pages through the
    // hybrid hot path.
    excludePrivate: opts?.excludePrivate,
    // v0.36 (D11): pass the pre-validated descriptor into the engine so
    // it never has to read config. Engines normalize string-or-descriptor
    // via normalizeEngineColumn; the descriptor path is the strict one.
    embeddingColumn: resolvedCol,
    // D2 fix (fix/title-retrieval-arm, Reviewer F1): the hybrid keyword arm
    // is a recall arm — opt in to the engine's AND→OR zero-recall fallback.
    // Direct searchKeyword consumers (countMentions, link-extraction, eval)
    // do NOT set this. Knob: search.keywordOrFallback (rationale: ModeBundle).
    orFallback: resolvedMode.keywordOrFallback,
    // v0.46.15: collect searchVector's bounded-escalation exhaustion signal —
    // engines have no telemetry sink (R2-10); hybrid owns the meta emit.
    // ACCUMULATES across vector calls (adversarial F8): expansion runs N
    // sub-queries through this one opts object — last-write-wins would
    // under-report multi-query exhaustion. Keep the max-escalations event.
    onVectorPoolMeta: (m) => {
      if (!vectorPoolUnderfill || m.escalations >= vectorPoolUnderfill.escalations) {
        vectorPoolUnderfill = { escalations: m.escalations, innerLimit: m.innerLimit };
      }
    },
  };
  let vectorPoolUnderfill: { escalations: number; innerLimit: number } | undefined;
  // Track what actually ran for the optional onMeta callback (v0.25.0).
  // Caller leaves onMeta undefined → these flags are computed but never
  // surfaced. Capture wrapper passes a closure to receive the meta and
  // threads it into the eval_candidates row.
  let expansionApplied = false;
  // WP2/T3 — degradation stamp accumulated across stages. Emitted on EVERY
  // return path (empty array = clean run) so cache rows always carry the
  // stamp and a served row can prove its cleanliness (ENG-5/cache_prestamp).
  const degraded: DegradedStageEntry[] = [];

  // A throwing user callback must never break the search hot path — onMeta
  // is a public surface (gbrain/search/hybrid) so a third-party closure bug
  // shouldn't take down query/search responses.
  //
  // v0.32.3 search-lite: every emitMeta call ALSO records to the in-process
  // search_telemetry rollup. Telemetry write is sync (bumps a bucket map),
  // flush is fire-and-forget on 60s / 100-call thresholds. The hot path
  // never waits.
  let lastResultsCount = 0;
  // T7 — rank-1 base_score for the telemetry drift signal. Set alongside
  // lastResultsCount at each return path; undefined when there are no results.
  let lastRank1Score: number | undefined;
  const emitMeta = (meta: HybridSearchMeta): void => {
    try {
      opts?.onMeta?.(meta);
    } catch {
      // swallow — capture telemetry is best-effort
    }
    try {
      // #2952 — fold the cache-consult outcome (threaded by hybridSearchCached)
      // into the RECORDED meta only. None of the inner return paths set a
      // `cache` field themselves, so this is the sole source of the miss /
      // disabled classification; `onMeta` consumers above still receive the
      // meta unchanged (the cached wrapper emits its own merged meta to them).
      const recordedMeta = opts?._telemetryCacheStatus
        ? { ...meta, cache: { status: opts._telemetryCacheStatus } }
        : meta;
      recordSearchTelemetry(engine, recordedMeta, { results_count: lastResultsCount, rank1_score: lastRank1Score });
    } catch {
      // swallow — telemetry must never break the search hot path.
    }
  };

  if (DEBUG && detail) {
    console.error(`[search-debug] auto-detail=${detail} for query="${query}"`);
  }

  // Run keyword search (always available, no API key needed).
  //
  // v0.36 cross-modal (D9): skip keyword for 'image'-only modality. Image
  // chunks may have OCR text in chunk_text, but a text-only keyword scan
  // would also surface every text chunk containing the query phrase —
  // not what an image-intent query asked for. Image vector search is the
  // canonical channel for image-modality queries.
  //
  // We classify modality early (it's also computed after for the modality
  // branch). The classification is pure regex via classifyQuery; running it
  // here is cheap.
  const earlyModality = (opts?.crossModal && opts.crossModal !== 'auto')
    ? opts.crossModal
    : (suggestions.suggestedModality ?? 'text');
  // D1 fix (fix/title-retrieval-arm): page-grain title candidate arm,
  // fetched CONCURRENTLY with the keyword arm (Reviewer F7 — independent
  // engine queries). The chunk FTS vector never includes the page title, so
  // an exact-title query can be unretrievable by keyword — this arm queries
  // pages.search_vector (title weight 'A') directly. Runs regardless of
  // query token count: the alias hop (≤6-token guard) and the title-phrase
  // boost are re-rank-only, so LONG exact-title queries — where strict-AND
  // chunk FTS is weakest — need a candidate GENERATOR. Fail-open WITH
  // SIGNAL (Reviewer F2): a SQL error (e.g. a pre-search_vector brain)
  // degrades to no title candidates, but warns once per process so a
  // broken engine arm cannot ship dark.
  const [keywordResults, titleResults]: [SearchResult[], SearchResult[]] =
    earlyModality === 'image'
      ? [[], []]
      : await Promise.all([
          engine.searchKeyword(query, searchOpts).catch((err: unknown) => {
            warnOncePerProcess(
              'search-keyword-arm-failed',
              `[gbrain] searchKeyword arm failed (fail-open, keyword candidates skipped): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            return [] as SearchResult[];
          }),
          engine.searchTitles(query, searchOpts).catch((err: unknown) => {
            warnOncePerProcess(
              'search-titles-arm-failed',
              `[gbrain] searchTitles arm failed (fail-open, title candidates skipped): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            return [] as SearchResult[];
          }),
        ]);
  // #3783 — stamp lexical-arm membership pre-fusion so evidence's
  // keyword_exact label is earned by an actual FTS hit, never by a solid
  // blended score alone. Both arms are the lexical-evidence class (chunk
  // FTS + title FTS); vector/relational arms are deliberately NOT marked.
  markKeywordHits(keywordResults);
  markKeywordHits(titleResults);

  // v0.29.1: resolve salience/recency from caller (back-compat aliases for
  // PR #618's `recencyBoost` numeric scale) or fall back to the heuristic.
  // The wrapper fires from ALL THREE return paths (codex pass-1 #2 + pass-2 #4).
  // wave-g: extracted to resolveEffectiveSalience/resolveEffectiveRecency so
  // hybridSearchCached's knobs-hash key parts (sal=/rec=, v=24) resolve
  // through the IDENTICAL chain — drift here would key cache rows under a
  // different mode than the stored results used.
  const salienceMode: 'off' | 'on' | 'strong' = resolveEffectiveSalience(opts, suggestions);
  const recencyMode: 'off' | 'on' | 'strong' =
    resolveEffectiveRecency(opts, suggestions, intentWeightingOn);
  const postFusionOpts: PostFusionOpts = {
    applyBacklinks: true,
    salience: salienceMode,
    recency: recencyMode,
    // v0.35.6.0 — floor-ratio gate threaded from resolved mode. Default
    // undefined for all 3 bundles → no behavior change unless caller sets
    // SearchOpts.floorRatio or `search.floor_ratio` config key.
    floorRatio: resolvedMode.floor_ratio,
    // v0.40.4 — graph_signals stage threaded from resolved mode. Defaults
    // per ModeBundle (conservative=false, balanced/tokenmax=true). Per-call
    // SearchOpts.graph_signals overrides through resolveSearchMode.
    // Without this thread, the entire graph-signals wave is dead code —
    // codex outside-voice caught the missing wire pre-merge.
    graphSignalsEnabled: resolvedMode.graph_signals,
    // T2 — title-phrase boost threaded from resolved mode (`title_boost`).
    // The raw query drives the matcher; default factor when the knob is unset.
    query,
    titleBoost: resolvedMode.title_boost,
  };

  // v0.43 — build the relational recall arm ONCE here, before any return
  // path, so typed-edge answers contribute on ALL THREE paths: the
  // no-embedding-provider path, the embed-failed keyword fallback, and the
  // main RRF path. Parsed from the original query (deterministic); empty for
  // non-relational queries → pure no-op. (Modality gate lives on the main
  // path; the parser only matches text-shaped relational queries anyway.)
  let relationalList: SearchResult[] = [];
  if (resolvedMode.relationalRetrieval) {
    relationalList = await buildRelationalArm(engine, query, {
      sourceId: opts?.sourceId,
      sourceIds: opts?.sourceIds,
      depth: resolvedMode.relational_retrieval_depth,
      limit: opts?.limit ?? resolvedMode.searchLimit,
      // #4352 remediation: the arm hydrates titles + compiled_truth snippets
      // straight from pages — thread the caller's private-page gate or a
      // remote relational query bypasses the keyword/vector visibility clause.
      excludePrivate: opts?.excludePrivate,
      onMeta: opts?.onRelationalMeta,
    });
  }

  // Skip vector search entirely if the gateway has no embedding provider configured (Codex C3).
  // v0.36 (D10): ask "is the RESOLVED column's provider reachable?" rather
  // than "is the global default reachable?" — otherwise an unreachable
  // global default disables vector search even when the active column's
  // provider (Voyage, ZE) works fine.
  const { isAvailable } = await import('../ai/gateway.ts');
  const providerProbe = resolvedCol.embeddingModel || undefined;
  // Image/both/unified routing embeds via the MULTIMODAL provider, not the
  // text provider — so a multimodal-only install (text provider absent) must
  // still reach the multimodal branch below. Probe the multimodal provider
  // explicitly and only short-circuit when neither the text provider nor (for
  // multimodal-routed queries) the multimodal provider is reachable. Without
  // this guard a multimodal-only install would fall to keyword-only here and
  // never run the image/unified vector path.
  const multimodalProviderProbe =
    cfgForColumn?.embedding_multimodal_model ?? 'voyage:voyage-multimodal-3';
  // The LLM intent tie-break (below) can escalate a regex-'text' query to
  // 'image'/'both'; account for that possibility so an ambiguous query on a
  // multimodal-only install still reaches the multimodal branch.
  const mayEscalateToMultimodal =
    earlyModality === 'text' &&
    resolvedMode.cross_modal_llm_intent &&
    isAmbiguousModalityQuery(query);
  const willTryMultimodal =
    (resolvedMode.unified_multimodal === true ||
      earlyModality === 'image' ||
      earlyModality === 'both' ||
      mayEscalateToMultimodal) &&
    isAvailable('embedding', multimodalProviderProbe);
  // Hermetic eval canaries/CI: a caller-supplied queryEmbedFn produces the
  // vector-arm query embedding without the gateway, so provider
  // availability is irrelevant — skip the keyword-only short-circuit.
  if (!opts?.queryEmbedFn && !isAvailable('embedding', providerProbe) && !willTryMultimodal) {
    // v0.43 — fuse the relational arm with keyword so typed-edge answers
    // survive on the no-embedding-provider path (the relational win is most
    // valuable exactly when vector is unavailable). The title arm fuses here
    // too — an exact-title lookup on a keyless install is precisely where
    // chunk-grain keyword FTS alone fails (D1).
    // issue #160: stamp unverified stubs BEFORE fusion so the compiled-truth
    // boost skips them (flag survives fusion's result spread).
    await stampUnverifiedExtractions(engine, [...keywordResults, ...titleResults, ...relationalList]);
    let noEmbedResults = keywordResults;
    if (relationalList.length > 0 || titleResults.length > 0) {
      const fk = opts?.rrfK ?? RRF_K;
      const noEmbedLists = [{ list: keywordResults, k: fk }];
      if (titleResults.length > 0) noEmbedLists.push({ list: titleResults, k: fk });
      if (relationalList.length > 0) noEmbedLists.push({ list: relationalList, k: fk });
      noEmbedResults = rrfFusionWeighted(noEmbedLists, shouldBoostCompiledTruth(detailResolved));
    }
    if (noEmbedResults.length > 0) {
      await runPostFusionStages(engine, noEmbedResults, postFusionOpts);
      noEmbedResults.sort((a, b) => b.score - a.score);
    }
    // T3/T4 — alias hop + evidence stamp even without an embedding provider
    // (the named-thing fix is most valuable exactly when vector is unavailable).
    const noEmbedPreExact = await applyAliasHop(engine, dedupResults(noEmbedResults), query, {
      sourceId: opts?.sourceId,
      sourceIds: opts?.sourceIds,
      excludePrivate: opts?.excludePrivate,
    });
    // #1663 — structural exact-lookup tier (slug / exact-title identity).
    const noEmbedHopped = await applyExactLookupTier(engine, noEmbedPreExact, query, {
      sourceId: opts?.sourceId,
      sourceIds: opts?.sourceIds,
      titleCandidates: titleResults,
      // #4480: gate tier injections on the caller's shape filters.
      type: opts?.type,
      types: opts?.types,
      excludeSlugs: opts?.exclude_slugs,
    });
    stampEvidence(noEmbedHopped, { cosineFloor: resolvedMode.evidence_cosine_floor });
    // #3995 — guaranteed page-1 relational evidence: a fired arm's answer is
    // often lexically unrecoverable, so its single-arm fused row can land
    // beyond the limit slice on keyword-heavy corpora. Promote/inject before
    // slicing (first page only; pure no-op when the arm didn't fire).
    let noEmbedPool = noEmbedHopped;
    let noEmbedRelSlot: RelationalEvidenceSlotDecision | undefined;
    if (relationalList.length > 0) {
      const r = ensureRelationalEvidenceSlot(noEmbedHopped, relationalList, limit, offset, {
        cosineFloor: resolvedMode.evidence_cosine_floor,
      });
      noEmbedPool = r.pool;
      noEmbedRelSlot = r.decision;
    }
    const noEmbedSliced = noEmbedPool.slice(offset, offset + limit);
    // v0.32.3 search-lite: budget enforcement on the no-embedding-provider path.
    const { results: noEmbedBudgeted, meta: noEmbedBudgetMeta } = enforceTokenBudget(noEmbedSliced, resolvedMode.tokenBudget);
    await stampContentFlags(engine, noEmbedBudgeted);
    lastResultsCount = noEmbedBudgeted.length;
    lastRank1Score = noEmbedBudgeted[0] ? (noEmbedBudgeted[0].base_score ?? noEmbedBudgeted[0].score) : undefined;
    // WP2/T3 — no silent bypass: the keyword-only-config branch names why
    // vector didn't run, and whether the keyword arm itself came up empty
    // (skipped-by-modality is not a keyword miss, hence the image gate).
    pushDegraded(degraded, 'embed_unavailable', 'no_provider');
    // #3808: meta names the degradation for programmatic callers, but a CLI
    // human never saw it — mirror the embed-failure warn (once per process,
    // stderr) with the diagnose reason so a silently keyword-only brain is
    // visible the first time it ships results.
    try {
      const { diagnoseEmbedding } = await import('../ai/gateway.ts');
      const diag = diagnoseEmbedding(providerProbe);
      const reason = diag.ok ? 'provider_unreachable' : (diag.reason ?? 'provider_unreachable');
      warnOncePerProcess(
        'search-vector-leg-unavailable',
        `[gbrain] vector search unavailable (${reason}) — results are keyword-only. Run \`gbrain doctor\` to diagnose.`,
      );
    } catch {
      // Fail-open like every sibling stage: the warning is best-effort and a
      // gateway import/diagnose throw must never fail the already-computed
      // keyword-only degraded results it exists to explain.
    }
    if (keywordResults.length === 0 && earlyModality !== 'image') {
      pushDegraded(degraded, 'keyword_zero');
    }
    stampBudgetStage(degraded, noEmbedBudgetMeta);
    emitMeta({
      vector_enabled: false,
      detail_resolved: detailResolved,
      expansion_applied: false,
      intent: suggestions.intent,
      mode: resolvedMode.resolved_mode,
      embedding_column: resolvedCol.name,
      degraded: [...degraded],
      retrieved_count: noEmbedSliced.length,
      ...(resolvedMode.tokenBudget && resolvedMode.tokenBudget > 0
        ? { token_budget: noEmbedBudgetMeta }
        : {}),
      ...(noEmbedRelSlot ? { relational_evidence_slot: noEmbedRelSlot } : {}),
    });
    return noEmbedBudgeted;
  }

  // v0.36 cross-modal wave: determine the effective modality once.
  //
  // Precedence (D22-1 normalization): literal 'auto' is normalized to
  // undefined so it doesn't reach the modality branch directly. Resolution:
  //   explicit opts.crossModal ('text'|'image'|'both') wins
  //   else suggestions.suggestedModality (regex-driven)
  //   else (Commit 4) opt-in LLM tie-break for genuinely ambiguous queries
  //   else 'text' (default)
  //
  // D9 mode-bundle override matrix: when effectiveModality === 'image',
  // cross-modal path overrides bundle knobs (expansion=false, no keyword
  // search). Voyage handles synonyms in-space; zerank-2 can't rerank image
  // embeddings.
  //
  // Phase 3 (D8): when search.unified_multimodal is true, ALL queries
  // route through the multimodal model + embedding_multimodal column,
  // regardless of detected modality.
  //
  // Commit 4 (LLM intent escalation): when search.cross_modal.llm_intent
  // is true AND regex returned 'text' AND isAmbiguousModalityQuery fires,
  // await a Haiku tie-break. Fail-open to regex result on any error.
  const explicitModality =
    opts?.crossModal && opts.crossModal !== 'auto' ? opts.crossModal : undefined;
  let regexModality = explicitModality ?? suggestions.suggestedModality ?? 'text';
  // LLM tie-break fires ONLY when:
  //   - no explicit per-call override
  //   - regex returned 'text' (not confident image/both)
  //   - operator opted in via search.cross_modal.llm_intent
  //   - isAmbiguousModalityQuery says the query is genuinely ambiguous
  if (
    explicitModality === undefined &&
    regexModality === 'text' &&
    resolvedMode.cross_modal_llm_intent &&
    isAmbiguousModalityQuery(query)
  ) {
    try {
      const { classifyModalityWithLLM } = await import('./llm-intent.ts');
      regexModality = await classifyModalityWithLLM(query, 'text');
    } catch {
      // Fail-open: regex result stands.
    }
  }
  const effectiveModality = regexModality;
  const unifiedRouting = resolvedMode.unified_multimodal === true;

  // Determine query variants (optionally with expansion)
  // expandQuery already includes the original query in its return value,
  // so we use it directly instead of prepending query again.
  // v0.32.3 search-lite: expansion fires when (a) resolved mode says yes and
  // (b) an expandFn is wired in. The mode bundle is the default; per-call
  // SearchOpts.expansion still wins via resolveSearchMode's chain.
  //
  // D9: image-modality skips expansion regardless of mode bundle.
  let queries = [query];
  const expansionAllowed = resolvedMode.expansion && effectiveModality !== 'image';
  if (expansionAllowed && opts?.expandFn) {
    try {
      queries = await opts.expandFn(query);
      if (queries.length === 0) queries = [query];
      // "Applied" = produced variants beyond the original, not just called.
      expansionApplied = queries.length > 1;
    } catch (err) {
      // Expansion failure is non-fatal — original query proceeds alone,
      // stamped so the consumer knows the multi-query recall arm was lost.
      pushDegraded(degraded, 'expansion_failed', isTimeoutError(err) ? 'timeout' : 'provider_error');
    }
  }

  // Embed all query variants and run vector search.
  //
  // v0.36 cross-modal wave routing:
  //   - 'text' (default): existing text-embedding path, unchanged
  //   - 'image': embedQueryMultimodal + searchVector(embedding_image), skip keyword
  //   - 'both': text + image vector searches in parallel; merged via weighted RRF
  let vectorLists: SearchResult[][] = [];
  let queryEmbedding: Float32Array | null = null;
  let imageVectorList: SearchResult[] | null = null;
  let crossModalFellOpen = false;

  // Phase 3 unified routing: when on, route ALL queries through Voyage
  // multimodal-3 + embedding_multimodal column. Bypasses the dual-column
  // branching below — but with D8 fail-open: if the unified path returns
  // zero rows AND the operator hasn't opted into strict unified-only mode,
  // fall through to the dual-column text path. unified_multimodal_only
  // disables the fallback.
  let unifiedDone = false;
  if (unifiedRouting) {
    try {
      const { isAvailable: aiIsAvailable, embedQueryMultimodal } = await import('../ai/gateway.ts');
      // Probe the MULTIMODAL provider, not the global default — on a
      // multimodal-only install the global default (text) is absent but the
      // multimodal provider is configured, and unified routing embeds via it.
      if (!aiIsAvailable('embedding', multimodalProviderProbe)) {
        throw new Error('gateway not configured for embedding — unified multimodal would also fail');
      }
      const unifiedEmbedding = await embedQueryMultimodal(query);
      const unifiedSearchOpts: SearchOpts = {
        ...searchOpts,
        embeddingColumn: 'embedding_multimodal',
      };
      const unifiedList = await engine.searchVector(unifiedEmbedding, unifiedSearchOpts);
      // D8 fail-open: zero rows + not strict-mode → fall through to dual-column.
      if (unifiedList.length === 0 && !resolvedMode.unified_multimodal_only) {
        console.error(
          `[cross-modal] unified_multimodal returned zero rows for query="${query.slice(0, 60)}". ` +
          `Falling back to dual-column text path (partial coverage during reindex). ` +
          `Set search.unified_multimodal_only=true to bypass this fallback when reindex completes.`,
        );
      } else {
        vectorLists = [unifiedList];
        queryEmbedding = unifiedEmbedding;
        unifiedDone = true;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[cross-modal] unified_multimodal embed failed; falling back to dual-column path. reason=${reason}`,
      );
      crossModalFellOpen = true;
      // WP2/T3 — the configured unified arm fell over; dual-column carried it.
      pushDegraded(degraded, 'vector_arm_failed', isTimeoutError(err) ? 'timeout' : 'provider_error');
    }
  }

  if (!unifiedDone && (effectiveModality === 'image' || effectiveModality === 'both')) {
    // Attempt image-side embedding. Fail-open: if multimodal is unconfigured
    // OR the embed throws, log a structured warning and fall through to text.
    try {
      const { isAvailable: aiIsAvailable, embedQueryMultimodal } = await import('../ai/gateway.ts');
      // Probe the MULTIMODAL provider, not the global default — the image side
      // embeds via the multimodal model, which may be configured even when the
      // text/global-default embedding provider is absent (multimodal-only).
      if (!aiIsAvailable('embedding', multimodalProviderProbe)) {
        throw new Error('gateway not configured for embedding — multimodal would also fail');
      }
      const imageEmbedding = await embedQueryMultimodal(query);
      const imageSearchOpts: SearchOpts = {
        ...searchOpts,
        embeddingColumn: 'embedding_image',
      };
      const imageList = await engine.searchVector(imageEmbedding, imageSearchOpts);
      for (const r of imageList) {
        r.modality = r.modality ?? 'image';
      }
      imageVectorList = imageList;
    } catch (err) {
      // Fail-open per behavioral invariant 2.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[cross-modal] image-side embed failed for modality=${effectiveModality}; falling back to text-only. reason=${reason}`,
      );
      crossModalFellOpen = true;
      // WP2/T3 — the image-search branch is no silent bypass: the fell-open
      // arm is named in the meta the surviving text path emits.
      pushDegraded(degraded, 'vector_arm_failed', isTimeoutError(err) ? 'timeout' : 'provider_error');
    }
  }

  if (unifiedDone) {
    // Unified routing already populated vectorLists + queryEmbedding;
    // skip the dual-column branching.
  } else if (effectiveModality === 'image' && imageVectorList !== null) {
    // Image-only path: results come entirely from the image column.
    vectorLists = [imageVectorList];
    queryEmbedding = null; // no text embedding to cosine-re-score against
  } else {
    // 'text' or 'both' (or 'image' that fell open to text). Run the text
    // path normally, with v0.36 (D10) provider-aware embed routing so a
    // query against `embedding_voyage` actually embeds via Voyage, not
    // the global default. Empty embeddingModel falls back to gateway
    // default — preserves pre-v0.36 behavior for the builtin 'embedding'
    // column.
    const embedOpts = resolvedCol.embeddingModel
      ? { embeddingModel: resolvedCol.embeddingModel, dimensions: resolvedCol.dimensions }
      : undefined;
    // v0.42.20.0 (Fix 3) — bound the query embed. Reuse the shared deadline
    // threaded from hybridSearchCached (so the cache-lookup embed + this one
    // share one ~6s budget); direct callers get a fresh deadline. On timeout
    // the embed rejects → salvage below (or keyword-only when all reject).
    const embedDl = opts?._queryEmbedDeadline ?? makeQueryEmbedDeadline();
    // Hermetic eval canaries/CI: queryEmbedFn (non-semantic deterministic
    // embeddings) replaces the gateway query-embed for the text vector arm.
    // No deadline needed — it's a synchronous-ish local computation with no
    // network. Absent queryEmbedFn, the bounded gateway path is unchanged.
    const embedOneQuery = (q: string): Promise<Float32Array> =>
      opts?.queryEmbedFn
        ? Promise.resolve(opts.queryEmbedFn(q))
        : embedQueryBounded(q, embedOpts, embedDl);
    if (!searchSalvageEnabled()) {
      // ENG-7 kill switch (GBRAIN_SEARCH_SALVAGE=off): pre-wave
      // all-or-nothing fan-outs — one variant's failure abandons every
      // embedding and falls back to keyword-only.
      try {
        const embeddings = await Promise.all(queries.map(q => embedOneQuery(q)));
        queryEmbedding = embeddings[0];
        const textLists = await Promise.all(
          embeddings.map(emb => engine.searchVector(emb, searchOpts)),
        );
        for (const list of textLists) {
          for (const r of list) {
            r.modality = r.modality ?? 'text';
          }
        }
        vectorLists = textLists;
        // 'both' mode: also include the image-side list as another input to RRF.
        if (effectiveModality === 'both' && imageVectorList !== null) {
          vectorLists = [...vectorLists, imageVectorList];
        }
      } catch (err) {
        // Embedding failure is non-fatal, fall back to keyword-only —
        // stamped with an enumerated code; raw text to stderr only (D6).
        const timedOut = isTimeoutError(err);
        pushDegraded(degraded, timedOut ? 'embed_timeout' : 'embed_unavailable', timedOut ? 'timeout' : 'provider_error');
        warnOncePerProcess(
          'search-embed-fanout-failed',
          `[gbrain] query embed/vector fan-out failed (keyword fallback): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // WP2/T3 (ENG-15) salvage fan-outs: allSettled on BOTH the embed
      // fan-out and the searchVector fan-out so one variant's failure no
      // longer abandons the survivors (the query-vs-search asymmetry fix).
      const settled = await Promise.allSettled(queries.map(q => embedOneQuery(q)));
      const okEmbeds: Float32Array[] = [];
      const embedFailures: unknown[] = [];
      for (const s of settled) {
        if (s.status === 'fulfilled') okEmbeds.push(s.value);
        else embedFailures.push(s.reason);
      }
      if (embedFailures.length > 0) {
        warnOncePerProcess(
          'search-embed-fanout-failed',
          `[gbrain] ${embedFailures.length}/${settled.length} query embeds failed (salvaging survivors): ` +
            `${embedFailures[0] instanceof Error ? (embedFailures[0] as Error).message : String(embedFailures[0])}`,
        );
      }
      if (okEmbeds.length === 0) {
        // Every embed failed → keyword-only fallback below, honestly staged.
        const allTimeouts = embedFailures.every(isTimeoutError);
        pushDegraded(degraded, allTimeouts ? 'embed_timeout' : 'embed_unavailable', allTimeouts ? 'timeout' : 'provider_error');
      } else {
        const originalOk = settled[0].status === 'fulfilled';
        if (embedFailures.length > 0) {
          // Mixed outcome — only reachable when expansion produced variants.
          pushDegraded(degraded, 'expansion_partial', originalOk ? 'variant_embed_failed' : 'original_embed_failed');
        }
        if (originalOk) {
          queryEmbedding = (settled[0] as PromiseFulfilledResult<Float32Array>).value;
        } else {
          // Registry refinement: variant lists are salvaged, but the cosine
          // re-score needs the ORIGINAL query's vector — skip it rather than
          // re-score in a variant's embedding space.
          queryEmbedding = null;
          pushDegraded(degraded, 'rescore_skipped', 'original_embed_failed');
        }
        const vSettled = await Promise.allSettled(okEmbeds.map(emb => engine.searchVector(emb, searchOpts)));
        const okLists: SearchResult[][] = [];
        let vFirstErr: unknown;
        let vFailed = 0;
        for (const s of vSettled) {
          if (s.status === 'fulfilled') okLists.push(s.value);
          else {
            if (vFailed === 0) vFirstErr = s.reason;
            vFailed += 1;
          }
        }
        if (vFailed > 0) {
          pushDegraded(degraded, 'vector_arm_failed', isTimeoutError(vFirstErr) ? 'timeout' : 'provider_error');
          warnOncePerProcess(
            'search-vector-arm-failed',
            `[gbrain] ${vFailed}/${vSettled.length} searchVector arms failed (salvaging survivors): ` +
              `${vFirstErr instanceof Error ? vFirstErr.message : String(vFirstErr)}`,
          );
        }
        for (const list of okLists) {
          for (const r of list) {
            r.modality = r.modality ?? 'text';
          }
        }
        vectorLists = okLists;
        // 'both' mode: also include the image-side list as another input to
        // RRF — only when a text arm survived, matching the pre-wave shape
        // (a total text failure falls back to keyword-only either way).
        if (vectorLists.length > 0 && effectiveModality === 'both' && imageVectorList !== null) {
          vectorLists = [...vectorLists, imageVectorList];
        }
      }
    }
  }

  if (vectorLists.length === 0) {
    // Embed/vector failed silently; record that vector did not run.
    // v0.29.1 codex pass-2 #4: this is the third return path. Apply
    // post-fusion stages here too — without it, salience='on' silently
    // does nothing on embed failures.
    // v0.43: fuse the relational arm with keyword via RRF so typed-edge
    // answers survive even when vector is unavailable. The title arm fuses
    // here too (same rationale as the no-embedding-provider path — D1).
    // issue #160: stamp unverified stubs BEFORE fusion (see the
    // no-embedding-provider path for rationale).
    await stampUnverifiedExtractions(engine, [...keywordResults, ...titleResults, ...relationalList]);
    let fallbackResults = keywordResults;
    if (relationalList.length > 0 || titleResults.length > 0) {
      const fk = opts?.rrfK ?? RRF_K;
      const fallbackLists = [{ list: keywordResults, k: fk }];
      if (titleResults.length > 0) fallbackLists.push({ list: titleResults, k: fk });
      if (relationalList.length > 0) fallbackLists.push({ list: relationalList, k: fk });
      fallbackResults = rrfFusionWeighted(fallbackLists, shouldBoostCompiledTruth(detail));
    }
    if (fallbackResults.length > 0) {
      await runPostFusionStages(engine, fallbackResults, postFusionOpts);
      fallbackResults.sort((a, b) => b.score - a.score);
    }
    const kwPreExact = await applyAliasHop(engine, dedupResults(fallbackResults), query, {
      sourceId: opts?.sourceId,
      sourceIds: opts?.sourceIds,
      excludePrivate: opts?.excludePrivate,
    });
    // #1663 — structural exact-lookup tier (slug / exact-title identity).
    const kwHopped = await applyExactLookupTier(engine, kwPreExact, query, {
      sourceId: opts?.sourceId,
      sourceIds: opts?.sourceIds,
      titleCandidates: titleResults,
      // #4480: gate tier injections on the caller's shape filters.
      type: opts?.type,
      types: opts?.types,
      excludeSlugs: opts?.exclude_slugs,
    });
    stampEvidence(kwHopped, { cosineFloor: resolvedMode.evidence_cosine_floor });
    const kwSliced = kwHopped.slice(offset, offset + limit);
    // v0.32.3 search-lite: budget enforcement on the keyword-fallback path too.
    const { results: kwBudgeted, meta: kwBudgetMeta } = enforceTokenBudget(kwSliced, resolvedMode.tokenBudget);
    await stampContentFlags(engine, kwBudgeted);
    lastResultsCount = kwBudgeted.length;
    lastRank1Score = kwBudgeted[0] ? (kwBudgeted[0].base_score ?? kwBudgeted[0].score) : undefined;
    // WP2/T3 — the embed/vector failure that emptied vectorLists already
    // pushed its stage above; add the keyword-arm outcome (skipped-by-
    // modality is not a keyword miss, hence the image gate).
    if (keywordResults.length === 0 && earlyModality !== 'image') {
      pushDegraded(degraded, 'keyword_zero');
    }
    stampBudgetStage(degraded, kwBudgetMeta);
    emitMeta({
      vector_enabled: false,
      detail_resolved: detailResolved,
      expansion_applied: expansionApplied,
      intent: suggestions.intent,
      mode: resolvedMode.resolved_mode,
      embedding_column: resolvedCol.name,
      degraded: [...degraded],
      retrieved_count: kwSliced.length,
      ...(resolvedMode.tokenBudget && resolvedMode.tokenBudget > 0
        ? { token_budget: kwBudgetMeta }
        : {}),
    });
    return kwBudgeted;
  }

  // Merge all result lists via RRF (includes normalization + boost)
  // Skip boost for detail=high (temporal/event queries want natural ranking)
  //
  // v0.32.x search-lite: when intent weighting is on, run RRF with
  // per-list effective k values — entity/event intents nudge keyword
  // contributions up by lowering their k. The base rrfK still controls
  // the overall RRF shape; intent weights tilt within that shape.
  const baseRrfK = opts?.rrfK ?? RRF_K;
  const keywordK = effectiveRrfK(baseRrfK, intentWeights.keywordWeight);
  const vectorK = effectiveRrfK(baseRrfK, intentWeights.vectorWeight);

  // v0.36 cross-modal (D6): in 'both' mode, vectorLists carries
  // [textList, imageList]. Apply per-modality RRF weights so the merge
  // reflects the configured text/image balance. In 'text' and 'image'
  // modes only one branch is present, so per-modality K reduces to
  // the standard vectorK (no behavior change vs pre-v0.36).
  const textRrfK = effectiveRrfK(baseRrfK, resolvedMode.cross_modal_both_text_weight);
  const imageRrfK = effectiveRrfK(baseRrfK, resolvedMode.cross_modal_both_image_weight);
  const isBothMode = effectiveModality === 'both' && vectorLists.length >= 2;

  const allLists: Array<{ list: SearchResult[]; k: number }> = isBothMode
    ? [
      // Last list in vectorLists is the image branch (we appended it above).
      // All preceding lists (1 or more text-query embeddings if expansion ran)
      // get textRrfK. Image branch gets imageRrfK.
      ...vectorLists.slice(0, -1).map(list => ({ list, k: textRrfK })),
      { list: vectorLists[vectorLists.length - 1], k: imageRrfK },
      { list: keywordResults, k: keywordK },
    ]
    : [
      ...vectorLists.map(list => ({ list, k: vectorK })),
      { list: keywordResults, k: keywordK },
    ];

  // D1 fix (fix/title-retrieval-arm) — title candidate arm as a third
  // weighted list. Fuses at the keyword arm's intent-effective k (same
  // lexical-evidence class, no new tunable). Mirrors the keyword list's
  // inclusion rules: fetch was gated on earlyModality, so no extra modality
  // check here. Empty for non-matching queries → pure no-op.
  if (titleResults.length > 0) {
    allLists.push({ list: titleResults, k: keywordK });
  }

  // v0.43 — relational recall arm (fourth RRF arm), built above so it also
  // contributes on the keyword-only fallback path. Neutral weight (baseRrfK):
  // competes evenly with keyword/vector, not dominating. Empty for
  // non-relational queries → pure no-op. Rides every downstream stage (cosine
  // re-score, post-fusion boosts, dedup, reranker, autocut, token budget).
  if (relationalList.length > 0 && effectiveModality !== 'image') {
    allLists.push({ list: relationalList, k: baseRrfK });
  }

  // issue #160: stamp unverified auto-extracted stubs across ALL candidate
  // arms BEFORE fusion so the compiled-truth authority boost skips them.
  await stampUnverifiedExtractions(engine, allLists.flatMap((l) => l.list));

  let fused = rrfFusionWeighted(allLists, shouldBoostCompiledTruth(detail));

  // Cosine re-scoring before dedup so semantically better chunks survive.
  // v0.36 (D9): hydrate from the active embedding column so rescore happens
  // in the same vector space the HNSW just ranked in. Pre-v0.36 this
  // always pulled from `embedding` and silently corrupted alt-column ranks.
  if (queryEmbedding) {
    fused = await cosineReScore(engine, fused, queryEmbedding, resolvedCol.name);
  }

  // v0.29.1: post-fusion stages (backlink + salience + recency) run via
  // runPostFusionStages so all three early-return paths share the same
  // boost surface. Salience and recency are independent axes — either,
  // both, or neither fires depending on resolved modes.
  if (fused.length > 0) {
    await runPostFusionStages(engine, fused, postFusionOpts);
    // v0.32.x search-lite: intent exact-match boost (entity/event intents).
    // No-op when boost factor is 1.0 (general intent or weighting disabled).
    if (intentWeights.exactMatchBoost !== 1.0) {
      applyExactMatchBoost(fused, query, intentWeights);
    }
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

  // v0.35.0.0+: cross-encoder reranker. Slots between dedup and slice so the
  // reranker sees the full candidate pool (its own topNIn caps how many
  // get sent upstream). Fail-open: any error returns deduped unchanged.
  //
  // Resolution: per-call SearchOpts.reranker overrides; otherwise pull
  // from the resolved mode bundle (tokenmax → enabled, others → disabled).
  // The resolved mode's fields already participate in knobsHash, so cache
  // rows naturally segregate by reranker config.
  const rerankerOpts = opts?.reranker ?? {
    enabled: resolvedMode.reranker_enabled,
    topNIn: resolvedMode.reranker_top_n_in,
    topNOut: resolvedMode.reranker_top_n_out,
    model: resolvedMode.reranker_model,
    timeoutMs: resolvedMode.reranker_timeout_ms,
  };
  const reranked = rerankerOpts.enabled
    ? await applyReranker(query, deduped, rerankerOpts as any)
    : deduped;

  // T3 — free-text alias hop. Runs AFTER rerank so a query that is a page's
  // declared chosen name reliably surfaces that page regardless of how the
  // reranker scored body chunks. Fail-open on pre-v110 brains.
  const preExact = await applyAliasHop(engine, reranked, query, {
    sourceId: opts?.sourceId,
    sourceIds: opts?.sourceIds,
    excludePrivate: opts?.excludePrivate,
  });

  // #1663 — structural exact-lookup tier: a query that IS a page identity
  // (slug / exact normalized title) gets that page at rank-1 regardless of
  // how the scorers ranked body chunks. Supersession-filtered inside; reuses
  // the already-fetched title arm (no extra queries); pure no-op for
  // non-lookup-shaped queries. Runs after the alias hop so all three
  // identity surfaces (alias, slug, title) share the same injection shape.
  const aliasHopped = await applyExactLookupTier(engine, preExact, query, {
    sourceId: opts?.sourceId,
    sourceIds: opts?.sourceIds,
    titleCandidates: titleResults,
    // #4480: gate tier injections on the caller's shape filters.
    type: opts?.type,
    types: opts?.types,
    excludeSlugs: opts?.exclude_slugs,
  });

  // T4 — stamp evidence + create_safety so the agent's don't-duplicate
  // decision keys off WHY a page matched, not a raw blended score. Stamp on
  // the full alias-hopped set before any adaptive trim so the kept results
  // carry evidence regardless of where the cap lands.
  stampEvidence(aliasHopped, { cosineFloor: resolvedMode.evidence_cosine_floor });

  // v0.42 — intent-aware adaptive return-sizing (opt-in, default off). Trim
  // the ranked candidate set to an intent-driven cap BEFORE the limit slice,
  // and only on the first page (offset===0) — paginating a confidence-gated
  // set is incoherent, so paginated calls fall through to the fixed limit.
  // Runs on the alias-hopped set so an alias-injected page (top-of-organic)
  // survives the trim.
  const adaptiveCfg = resolveAdaptiveReturn(
    opts?.adaptiveReturn,
    adaptiveReturnFromConfig(cfgForColumn as Record<string, unknown> | null),
  );
  let returnPool = aliasHopped;
  let adaptiveDecision: AdaptiveReturnDecision | undefined;
  if (adaptiveCfg.enabled && offset === 0) {
    // v0.46.15: 'concept' maps to the recall-preserving 'general' cap for
    // adaptive return — the narrower AdaptiveQueryIntent union predates the
    // concept intent, and concept queries are exactly the ones that want
    // breadth (widening the union is the adaptive-ablation wave's call).
    const adaptiveIntent = suggestions.intent === 'concept' ? 'general' : suggestions.intent;
    const r = applyAdaptiveReturn(aliasHopped, adaptiveIntent, adaptiveCfg);
    returnPool = r.kept;
    adaptiveDecision = r.decision;
  }

  // v0.42.3.0 — autocut (score-discontinuity result-sizing). The floor:
  // default-ON in reranked modes (resolvedMode.autocut, resolved per-call >
  // config > bundle like every other knob). Cuts the ranked set at the largest
  // cross-encoder rerank-score cliff, BEFORE the limit slice, first page only.
  // Runs AFTER adaptive-return so an agent-forced intent cap composes (both are
  // trim-only with never-empty failsafes). The reranker scored the full
  // returned set (mode.ts D4: top_n_in = searchLimit), so there is no un-scored
  // tail to wrongly drop; applyAutocut additionally no-ops when <2 items carry
  // a finite rerank_score (covers the fail-open reranker path, where
  // applyReranker returns RRF order with no scores). jumpRatio + minKeep come
  // from the resolved mode (config `search.autocut_jump` /
  // `search.autocut_min_keep` > bundle); minKeep stays the never-empty
  // failsafe (default 1 — raising it floors the cut for operators whose
  // reranker score curves decay without a dramatic cliff).
  let autocutDecision: AutocutDecision | undefined;
  if (resolvedMode.autocut && offset === 0) {
    const r = applyAutocut(
      returnPool,
      (x) => x.rerank_score,
      // v0.46.15 (#1863): minTopScore is the weak-top floor — below it the
      // cliff signal is untrustworthy and autocut no-ops. #3621: minKeep is
      // now the configured floor instead of the hardcoded 1.
      {
        enabled: true,
        jumpRatio: resolvedMode.autocut_jump,
        minKeep: resolvedMode.autocut_min_keep,
        minTopScore: resolvedMode.autocut_min_top,
      },
      // Preserve alias-hop exact matches: applyAliasHop injects the canonical
      // page AFTER reranking, so it has no rerank_score. Without this it would
      // be dropped whenever autocut cuts on the scored set (Codex P1).
      // #1663: same guarantee for structural exact-lookup tier hits (slug /
      // exact-title identity matches also arrive post-rerank, unscored).
      (x) => x.alias_hit === true || x.exact_lookup !== undefined,
    );
    returnPool = r.kept;
    autocutDecision = r.decision;
  }

  // #3995 — guaranteed page-1 relational evidence. A fired arm's answer is
  // often lexically unrecoverable (unverified entity stub, single-arm RRF
  // score), so its fused row can land beyond the limit slice on multi-arm
  // corpora, and autocut's preserve predicate only covers alias hits — the
  // relational row (no rerank_score) is exactly what a cut drops. Promote the
  // fused row into the page-1 window, or re-inject the arm's top candidate
  // when it was dropped entirely. First page only; pure no-op otherwise.
  let relationalSlotDecision: RelationalEvidenceSlotDecision | undefined;
  if (relationalList.length > 0 && effectiveModality !== 'image') {
    const r = ensureRelationalEvidenceSlot(returnPool, relationalList, limit, offset, {
      cosineFloor: resolvedMode.evidence_cosine_floor,
    });
    returnPool = r.pool;
    relationalSlotDecision = r.decision;
  }

  const sliced = returnPool.slice(offset, offset + limit);
  // v0.32.3 search-lite: budget enforcement at the main return path.
  // hybridSearchCached used to be the only place this fired; now bare
  // hybridSearch enforces it too so eval-replay + eval-longmemeval see
  // the same budget behavior as the production query op.
  const { results: budgeted, meta: budgetMeta } = enforceTokenBudget(sliced, resolvedMode.tokenBudget);
  await stampContentFlags(engine, budgeted);
  lastResultsCount = budgeted.length;
  lastRank1Score = budgeted[0] ? (budgeted[0].base_score ?? budgeted[0].score) : undefined;
  stampBudgetStage(degraded, budgetMeta);
  emitMeta({
    vector_enabled: true,
    detail_resolved: detailResolved,
    expansion_applied: expansionApplied,
    intent: suggestions.intent,
    mode: resolvedMode.resolved_mode,
    embedding_column: resolvedCol.name,
    degraded: [...degraded],
    retrieved_count: sliced.length,
    ...(resolvedMode.tokenBudget && resolvedMode.tokenBudget > 0
      ? { token_budget: budgetMeta }
      : {}),
    ...(vectorPoolUnderfill ? { vector_pool_underfilled: vectorPoolUnderfill } : {}),
    ...(adaptiveDecision ? { adaptive_return: adaptiveDecision } : {}),
    ...(autocutDecision ? { autocut: autocutDecision } : {}),
    ...(relationalSlotDecision ? { relational_evidence_slot: relationalSlotDecision } : {}),
  });
  return budgeted;
}

// ----------------------------------------------------------------------
// v0.32.x (search-lite) — cached + budgeted public wrapper
// ----------------------------------------------------------------------

/**
 * wave-g (#4415 knobs-hash fold) — the ONE salience resolution chain, shared
 * by bare hybridSearch (post-fusion boost) and hybridSearchCached (the
 * `sal=` cache-key part). Explicit per-call opt wins; otherwise the
 * classifier's pattern-aware suggestion.
 */
function resolveEffectiveSalience(
  opts: HybridSearchOpts | undefined,
  suggestions: QuerySuggestions,
): 'off' | 'on' | 'strong' {
  return opts?.salience ?? suggestions.suggestedSalience;
}

/**
 * wave-g (#4415 knobs-hash fold) — the ONE recency resolution chain, shared
 * by bare hybridSearch and hybridSearchCached (the `rec=` cache-key part).
 *
 * Back-compat: recencyBoost: 1|2 → 'on'|'strong'; 0 → 'off'.
 * Intent-weighting recency suggestion is a NUDGE — it only fires when the
 * caller left recency unspecified AND the classifier's own suggestedRecency
 * (v0.29.1) didn't fire; it stays null when intent weighting is off.
 */
function resolveEffectiveRecency(
  opts: HybridSearchOpts | undefined,
  suggestions: QuerySuggestions,
  intentWeightingOn: boolean,
): 'off' | 'on' | 'strong' {
  const legacyRecency: 'off' | 'on' | 'strong' | undefined =
    opts?.recencyBoost === 2 ? 'strong' :
    opts?.recencyBoost === 1 ? 'on' :
    opts?.recencyBoost === 0 ? 'off' :
    undefined;
  const intentRecency = intentWeightingOn
    ? (weightsForIntent(suggestions.intent).suggestedRecency ?? null)
    : null;
  return (
    opts?.recency
    ?? legacyRecency
    ?? (suggestions.suggestedRecency !== 'off'
        ? suggestions.suggestedRecency
        : (intentRecency ?? suggestions.suggestedRecency))
  );
}

/**
 * Public wrapper around hybridSearch that adds the v0.32.x search-lite
 * features: semantic query cache + token budget enforcement. Both are
 * additive and backward-compatible; callers that don't opt in see the
 * same behavior as plain hybridSearch.
 *
 * Pipeline:
 *   1. Cache lookup (if enabled + we can produce a query embedding).
 *   2. On miss: run hybridSearch normally.
 *   3. Apply token budget (no-op when budget is undefined).
 *   4. On miss + successful search: write back to cache (best-effort).
 *
 * The cache uses the same embedding the search pipeline would compute,
 * so an extra embed() call only happens when hybridSearch would have
 * skipped vector search entirely (no embedding provider configured). In
 * that case the cache is also skipped — there's no embedding to key on.
 */
export async function hybridSearchCached(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts,
): Promise<SearchResult[]> {
  // v0.32.3 search-lite mode: resolve mode + per-key overrides once. The
  // resolved knob set drives cache enable/threshold/TTL AND the knobs_hash
  // that scopes the cache row so a tokenmax write can't be served to a
  // conservative read. See [CDX-4] in the plan.
  const { loadSearchModeConfig, resolveSearchMode, knobsHash } = await import('./mode.ts');
  const modeInputForCache = await loadSearchModeConfig(engine);
  const resolvedForCache = resolveSearchMode({
    // T4/D5 — per-call mode folds into the cache key (resolved_mode is part
    // of knobsHash) so a per-call `--mode tokenmax` read can't be served a
    // server-default-mode cache row.
    mode: opts?.mode ?? modeInputForCache.mode,
    overrides: modeInputForCache.overrides,
    perCall: {
      cache_enabled: opts?.useCache,
      tokenBudget: opts?.tokenBudget,
      expansion: opts?.expansion,
      intentWeighting: opts?.intentWeighting,
      searchLimit: opts?.limit,
      // v0.35.6.0 — floor-ratio threaded through cache resolver too so
      // knobsHash() differentiates floor-on vs floor-off cache rows.
      // Without this, a no-floor write would be served to a floor-enabled
      // read (ranking-correctness leak, codex T1).
      floor_ratio: opts?.floorRatio,
      // v0.40.4 — graph_signals threaded through cache resolver too so
      // knobsHash() includes the per-call override (KNOBS_HASH_VERSION=4
      // folds gs= into the hash). Without this thread, a per-call
      // override would write to one cache row but read from a different
      // one on the next call.
      graph_signals: opts?.graph_signals,
      // v0.42.3.0 — autocut threaded through the cache resolver so the
      // knobsHash `ac=` bit reflects the per-call ceiling override. Without
      // this, an `autocut:false` (full top-K) call could be served a trimmed
      // autocut-on cache row, or vice versa.
      autocut: typeof opts?.autocut === 'boolean' ? opts.autocut : undefined,
      // v0.43 — relational recall per-call thread-through. Per-call wins over
      // config override wins over mode bundle; without this the A/B eval gate
      // would be a no-op (both branches resolve to the same mode default).
      relationalRetrieval: opts?.relationalRetrieval,
      relational_retrieval_depth: opts?.relationalRetrievalDepth,
    },
  });
  // v0.36 (D8 / CDX-2 + codex /ship #4): resolve column for the cache
  // decision. The query_cache.embedding column has one fixed pgvector dim
  // sized at brain init; storing a 1024d Voyage or 2560d ZE cache
  // embedding fails or corrupts results. Name-based check ("is it the
  // default `embedding` column?") is insufficient — the registry
  // explicitly allows overriding builtin `embedding` to a different
  // provider/dim. isCacheSafe compares the resolved column's full
  // embedding space (name + dim + model) against cfg and returns true
  // only when ALL match. Otherwise skip.
  const mergedCfgCached = await loadConfigWithEngine(engine).catch(() => null);
  const cfgCached = mergedCfgCached ?? ((await import('../config.ts')).loadConfig()) ?? { engine: 'pglite' as const };
  const resolvedColCached = resolveEmbeddingColumn(opts, cfgCached);
  const isNonDefaultColumn = !isCacheSafe(resolvedColCached, cfgCached);

  // wave-g (#4415): classify ONCE with the brain's `search.intent_patterns`
  // applied (loadEngineIntentPatterns is per-engine + TTL-cached) so the
  // det=/sal=/rec= key parts reflect the SAME classification bare
  // hybridSearch resolves. Pre-fix, det= was computed via the pattern-less
  // global classifier, so a fresh process keyed its first cache row under a
  // pattern-less detail while the stored results used the pattern-aware one.
  const intentStateForCache = await loadEngineIntentPatterns(engine);
  const cacheSuggestions = classifyQuery(query, intentStateForCache.banks);

  // Cache key carries the column + provider so different embedding spaces
  // never collide on the same `(source_id, query_text)` row.
  const cacheKnobsHash = knobsHash(resolvedForCache, {
    embeddingColumn: resolvedColCached.name,
    embeddingModel: resolvedColCached.embeddingModel,
    // #2825 — fold the resolved hard-exclude prefix list (defaults ∪
    // GBRAIN_SEARCH_EXCLUDE ∪ per-call exclude_slug_prefixes, minus
    // include_slug_prefixes — exactly what the engines' query-build path
    // resolves) into the cache key so a row written under one exclude
    // policy can't be served to a lookup under another.
    hardExcludes: resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes),
    // #3515 — fold the EFFECTIVE detail level into the cache key. detail
    // gates dedup, chunk-source filtering, and the compiled_truth boost, so
    // a `--detail low` write (compiled-truth-only result set) must never be
    // served to a default `medium` lookup. Resolve auto-detect the same way
    // bare hybridSearch does (opts.detail ?? pattern-aware suggestion) so an
    // auto-detected `high` query keys like an explicit `high` one.
    detail: opts?.detail ?? cacheSuggestions.suggestedDetail,
    // #4415 (wave-g, v=24) — fold the EFFECTIVE salience/recency modes.
    // Both reorder the post-fusion result set, and #4415 put the per-call
    // overrides on the default MCP `search` surface, so a salience:'strong'
    // write must never serve a salience:'off' lookup of the same query.
    // Resolved by the SAME chain bare hybridSearch uses (helpers above).
    salience: resolveEffectiveSalience(opts, cacheSuggestions),
    recency: resolveEffectiveRecency(opts, cacheSuggestions, resolvedForCache.intentWeighting),
    // #4415 (wave-g, v=24) — fold the applied intent-pattern config
    // fingerprint: a `search.intent_patterns` edit changes classification
    // (and thus results), so it must change the key immediately instead of
    // serving old-classification rows for the rest of the cache TTL.
    intentPatterns: intentStateForCache.fingerprint,
    // #4352 follow-up — fold the private-visibility posture into the key
    // (xp=, v=23) for BOTH the lookup and the write below (they share this
    // one hash), instead of the original wholesale skipCache bypass. A
    // remote-default (excludePrivate=true) caller now caches normally, on
    // rows that can never be served to (or written by) a trusted
    // private-included call.
    excludePrivate: opts?.excludePrivate === true,
  });

  // Cache decision: opts.useCache (explicit) wins over global config; global
  // config wins over mode bundle default. Mode bundle is on for all 3 modes
  // today; the resolver already folded everything through.
  const cacheCfg = await loadCacheConfig(engine);
  const cacheEnabled = resolvedForCache.cache_enabled;
  const cache = new SemanticQueryCache(engine, {
    ...cacheCfg,
    enabled: cacheEnabled,
    similarityThreshold: resolvedForCache.cache_similarity_threshold,
    ttlSeconds: resolvedForCache.cache_ttl_seconds,
  });

  // Skip cache entirely when the request asks for two-pass walks, has
  // a non-default embedding column (per-call or via config default —
  // D8 closes the silent-corruption bug class), or near-symbol mode
  // (structural state that the cache can't safely express).
  // v0.42 — when adaptive return-sizing is on, skip the cache: a gated
  // (trimmed) result set must not be served to a gate-off lookup, and vice
  // versa. Folding the gate params into knobsHash is the v0.42+ follow-up
  // (TODO) that lets adaptive-on calls cache safely; until then, skip.
  const adaptiveReturnOn = adaptiveReturnEnabled(
    opts?.adaptiveReturn,
    cfgCached as unknown as Record<string, unknown> | null,
  );
  // #3442: date-filtered requests skip the cache — since/until are not part
  // of knobsHash, so a filtered result set could be served to an unfiltered
  // lookup (and vice versa). Relative forms ('60d') also resolve to a
  // now-relative timestamp, which a persisted cache row can't express.
  const dateFiltered =
    Boolean(opts?.since ?? opts?.afterDate) || Boolean(opts?.until ?? opts?.beforeDate);
  // #3985: type-filtered requests skip the cache — `types` is not part of
  // knobsHash, so a filtered result set could be served to an unfiltered
  // lookup (and vice versa). Mirrors the #3442 date-filter bypass.
  const typeFiltered = (opts?.types?.length ?? 0) > 0;
  // Offset pages are cache-hostile until the pre-slice POOL itself is what's
  // stored: the cache holds the already offset/limit-sliced page (bare
  // hybridSearch slices before returning), so a hit for any other offset
  // re-slices an already-sliced page — page-2 reads after a page-1 write come
  // back wrong/empty. And innerLimit is derived from offset (D-3002 pool
  // floor), making offset a result-affecting input that sits OUTSIDE the
  // knobs hash. Bypass the cache entirely (lookup AND store — the store is
  // gated on cacheStatus === 'miss' below, so 'disabled' covers both) for
  // any nonzero offset; offset===0 semantics are unchanged. #4358 residual
  // gap (this condition landed via #4368's wave as `> 0`, which absorbed
  // the positive-offset half of the original fix but not this one): a
  // negative offset re-slices the stored page just as badly as a positive
  // one (Array.prototype.slice treats a negative start as counting from
  // the array's end) — e.g. for offset=-21/limit=9 on a 21-row pool, the
  // store-time slice correctly returns the pool's first 9 rows, but
  // re-applying that same negative offset a second time (hit path, now
  // against the already-9-row stored page) clamps both bounds to the
  // array's start and returns nothing — so `> 0` let those requests
  // read/write the cache anyway.
  const pagedRequest = (opts?.offset ?? 0) !== 0;
  // #4352 follow-up — excludePrivate no longer skips the cache: the posture
  // is folded into knobsHash (xp=, v=23), so a private-included (trusted)
  // write can never serve a private-excluding lookup and vice versa. The
  // original wholesale skip disabled the semantic cache for every remote MCP
  // caller (excludePrivate=true is their default) — exactly the
  // highest-volume beneficiaries of the ~50% cache savings.
  const skipCache =
    !cache.isEnabled() ||
    (opts?.walkDepth ?? 0) > 0 ||
    Boolean(opts?.nearSymbol) ||
    isNonDefaultColumn ||
    adaptiveReturnOn ||
    dateFiltered ||
    typeFiltered ||
    pagedRequest;

  let cacheStatus: 'hit' | 'miss' | 'disabled' = skipCache ? 'disabled' : 'miss';
  let cacheSimilarity: number | undefined;
  let cacheAge: number | undefined;

  // We need a query embedding to consult the cache. We try to embed once
  // here so the same embedding can be threaded back into the search call
  // if it misses — but the embedding helper isn't cheap, so we only
  // attempt it when the cache is enabled AND the gateway has an embedding
  // provider configured.
  let queryEmbedding: Float32Array | null = null;
  // v0.42.20.0 (Fix 3, #1775) — ONE shared query-embed deadline for the
  // cache-lookup embed below AND the inner hybridSearch embed (threaded via
  // opts._queryEmbedDeadline). On a stalled provider the cache-lookup embed
  // times out (→ cacheStatus 'disabled', fall through), then the inner embed
  // sees the already-elapsed budget and fails fast → keyword fallback. Worst
  // case ~one timeout (~6s), comfortably under the CLI 10s force-exit.
  const queryEmbedDl = makeQueryEmbedDeadline();
  if (!skipCache) {
    try {
      const { isAvailable } = await import('../ai/gateway.ts');
      // v0.36 (D10): for the cache-lookup embedding, also use the resolved
      // column's provider. The cache lookup is always against the default
      // 'embedding' column (skipCache short-circuits non-default above),
      // so this is the default embeddingModel — but threading it keeps
      // the provider probe consistent with the bare hybridSearch path.
      const providerProbeCached = resolvedColCached.embeddingModel || undefined;
      if (isAvailable('embedding', providerProbeCached)) {
        // v0.35.0.0+: query-side embedding (cache lookup path).
        // v0.42.20.0 (Fix 3) — bounded by the shared deadline; on timeout this
        // throws → caught below → cacheStatus 'disabled' → falls through to the
        // inner hybridSearch (which reuses the same elapsed deadline).
        queryEmbedding = await embedQueryBounded(query, undefined, queryEmbedDl);
      } else {
        cacheStatus = 'disabled';
      }
    } catch {
      cacheStatus = 'disabled';
      queryEmbedding = null;
    }
  }

  if (!skipCache && queryEmbedding && cacheStatus !== 'disabled') {
    const hit = await cache.lookup(queryEmbedding, { sourceId: cacheScopeKey(opts), knobsHash: cacheKnobsHash, queryText: query }); // queryText → #1469 text guard
    if (hit.hit && hit.results) {
      cacheStatus = 'hit';
      cacheSimilarity = hit.similarity;
      cacheAge = hit.ageSeconds;

      // #3871 defense-in-depth: re-filter the stored rows by the CALLER's
      // scope BEFORE paging. A legacy row written under the pre-fix key
      // scheme (unscoped all-sources writes keyed 'default') can carry rows
      // from other sources; the filter guarantees a scoped read never pages
      // a foreign row — and filtering first means foreign rows can't
      // displace legitimate ones off the offset/limit window either.
      const scopedResults = filterResultsByCallerScope(hit.results, opts);

      // #4356 — was a hard `|| 20`, independent of the mode-resolution the
      // miss path uses (`opts?.limit || resolvedMode.searchLimit` above, in
      // bare hybridSearch): a balanced-mode miss could cache 25 results,
      // then the next identical-shape hit sliced that row down to 20.
      // `resolvedForCache` (resolved once, above, at the top of this
      // function) already folds `opts?.limit` through the same per-call
      // resolver bare hybridSearch's own `resolvedMode` uses (including 0 —
      // see mode.ts `resolveSearchMode`'s `pick()`), so mirroring it here
      // keeps hit/miss consistent for the common case without a second
      // config round-trip. Caveat: this is a SEPARATE `resolveSearchMode`
      // call from the one bare hybridSearch performs internally on a miss
      // (hybrid.ts's inner `resolvedMode`, computed when `hybridSearch` is
      // invoked below) — not literally the same object — so a `search.mode`
      // / `search.searchLimit` config change landing between these two
      // resolutions within one request could theoretically desync the
      // stored row's actual size from what its own `knobsHash` (built from
      // `resolvedForCache`) implies. Narrow and pre-existing (the double
      // resolution itself predates this PR); tracked as #4359, not fixed
      // here — closing it would mean threading one resolved snapshot into
      // the inner `hybridSearch` call, a larger change than this PR's
      // `|| 20` → `|| resolvedMode.searchLimit` substitution.
      const limit = opts?.limit || resolvedForCache.searchLimit;
      const offset = opts?.offset || 0;
      const sliced = scopedResults.slice(offset, offset + limit);

      // Budget enforcement — same pipeline tail as fresh path.
      const { results: budgeted, meta: budgetMeta } = enforceTokenBudget(sliced, opts?.tokenBudget);

      // Emit meta describing the cache path. WP2/T3 (ENG-5): spread-carry
      // the STORED meta so every key the bare hybridSearch emitted at write
      // time (intent, mode, embedding_column, adaptive_return, autocut,
      // degraded, token_budget, future additions) survives the hit without
      // a hand-copied rebuild — the class of drop Codex P2 caught for
      // adaptive_return can't recur. Explicit fields BELOW the spread are
      // the hit-time overrides.
      const cachedMeta: HybridSearchMeta = {
        ...(hit.meta ?? {}),
        vector_enabled: hit.meta?.vector_enabled ?? true,
        detail_resolved: hit.meta?.detail_resolved ?? null,
        expansion_applied: hit.meta?.expansion_applied ?? false,
        // A row stored before the degradation stamp existed (no `degraded`
        // key, not even []) can't prove it was a clean run — surface that
        // honestly instead of claiming clean (cache_prestamp). Post-bump
        // rows always carry the stamp (knobsHash v-bump makes pre-stamp
        // rows unreachable in production; this is the belt-and-braces).
        degraded: hit.meta?.degraded ?? [{ stage: 'cache_prestamp' }],
        // Pre-budget count for THIS response's page (offset/limit applied).
        retrieved_count: sliced.length,
        cache: {
          status: 'hit',
          similarity: cacheSimilarity,
          age_seconds: cacheAge,
        },
        // Per-call budget: prefer the STORED budget record, which carries
        // the true dropped count from the write-time cut — the
        // re-application above ran on an already-cut set and reads
        // dropped=0 (same masking as the miss path's finalMeta). Safe
        // unconditionally: tokenBudget is folded into knobsHash (`tb=`),
        // so a hit only ever serves a lookup with the identical resolved
        // budget as the write — the outer pass can never cut further.
        // budgetMeta stays as the fallback for legacy rows stored without
        // a budget record.
        ...(opts?.tokenBudget && opts.tokenBudget > 0
          ? { token_budget: hit.meta?.token_budget ?? budgetMeta }
          : {}),
      };
      try {
        opts?.onMeta?.(cachedMeta);
      } catch {
        // swallow — telemetry is best-effort
      }
      // #2952 — a cache hit never reaches the inner hybridSearch (the only
      // other telemetry site), so record the search HERE or it vanishes from
      // stats entirely (count, results, tokens, rank-1 — not just the hit
      // counter). Same rank-1 rule as the inner return paths. Tokens are
      // gated on the MODE-resolved budget, mirroring the inner paths' `if
      // (resolvedMode.tokenBudget > 0)` meta condition — otherwise a
      // tokenmax (budget-off) brain would record real tokens on hits but 0
      // on misses, skewing avg-tokens upward as the hit rate rises (codex).
      recordSearchTelemetry(engine, cachedMeta, {
        results_count: budgeted.length,
        ...(resolvedForCache.tokenBudget && resolvedForCache.tokenBudget > 0
          ? { tokens_estimate: budgetMeta.used }
          : {}),
        rank1_score: budgeted[0] ? (budgeted[0].base_score ?? budgeted[0].score) : undefined,
      });
      return budgeted;
    }
  }

  // Cache miss (or disabled): run the normal search. We capture meta so
  // we can write back to the cache + emit the merged meta to the caller.
  // The closure-write pattern trips TS's narrowing (it infers `never`), so
  // we use a single-element box to keep the type stable.
  const innerMetaBox: { current: HybridSearchMeta | null } = { current: null };
  const userOnMeta = opts?.onMeta;
  const results = await hybridSearch(engine, query, {
    ...opts,
    // v0.42.20.0 (Fix 3) — share the query-embed deadline so the inner embed
    // doesn't start a fresh 6s budget after the cache-lookup already spent it.
    _queryEmbedDeadline: queryEmbedDl,
    // #2952 — classify this search's telemetry record (emitted by the inner
    // function) with the cache-consult outcome. 'hit' already returned above,
    // so only miss/disabled reach this call.
    _telemetryCacheStatus: cacheStatus === 'disabled' ? 'disabled' : 'miss',
    onMeta: (m) => {
      innerMetaBox.current = m;
      // Do NOT call userOnMeta here — we'll emit a merged meta below
      // that also carries cache + budget info.
    },
  });
  const innerMeta = innerMetaBox.current;

  // Token budget pass (no-op when not set).
  const { results: budgeted, meta: budgetMeta } = enforceTokenBudget(results, opts?.tokenBudget);

  // Compose the final meta and emit. v0.42.3.0 (Codex #5) + WP2/T3 (ENG-5):
  // spread-carry the inner meta so every field the bare hybridSearch emitted
  // (intent, mode, embedding_column, adaptive_return, autocut, degraded,
  // retrieved_count, token_budget, future additions) survives the wrapper —
  // the manual-rebuild drop class (adaptive_return, Codex #5) can't recur.
  // Explicit fields below the spread are the wrapper's own overrides.
  const finalMeta: HybridSearchMeta = {
    ...(innerMeta ?? {}),
    vector_enabled: innerMeta?.vector_enabled ?? false,
    detail_resolved: innerMeta?.detail_resolved ?? null,
    expansion_applied: innerMeta?.expansion_applied ?? false,
    // Always stamp: a stored row must be able to prove it was clean
    // (cache_prestamp posture on the hit path above).
    degraded: innerMeta?.degraded ?? [],
    retrieved_count: innerMeta?.retrieved_count ?? results.length,
    cache: { status: cacheStatus },
    // Per-call budget: prefer the INNER meta's budget record. The inner
    // hybridSearch already enforced the same resolved budget (per-call wins
    // in resolveSearchMode), so the re-application above sees an
    // already-cut set and its meta reads dropped=0 — masking the real cut
    // from onMeta consumers (the `dropped` under-report the restored
    // search-lite test caught). The outer pass stays as the enforcement
    // for the cache-HIT path, where no inner run exists.
    ...(opts?.tokenBudget && opts.tokenBudget > 0
      ? { token_budget: innerMeta?.token_budget ?? budgetMeta }
      : {}),
  };
  try {
    userOnMeta?.(finalMeta);
  } catch {
    // swallow
  }

  // Best-effort writeback (skip when search returned empty so we don't
  // cache zero-result queries forever — they often indicate a typo).
  //
  // WP2/T3 (D14.2 revised per ENG-6): a DEGRADED result set is still cached
  // — full exclusion would amplify load exactly when a provider is limping —
  // but only for a short TTL (~60s) and stamped with its degradation, so a
  // salvaged set is never served as clean for the full TTL. Only embeddable
  // degradations reach this write: a total embed outage has no
  // queryEmbedding (store() no-ops on null) and vector_enabled=false, so it
  // is uncacheable by construction.
  if (
    cacheStatus === 'miss' &&
    queryEmbedding &&
    results.length > 0 &&
    (innerMeta?.vector_enabled ?? false)
  ) {
    const isDegraded = (finalMeta.degraded?.length ?? 0) > 0;
    trackCacheWrite(
      cache
        .store(query, queryEmbedding, results, finalMeta, {
          sourceId: cacheScopeKey(opts),
          knobsHash: cacheKnobsHash,
          ...(isDegraded ? { ttlSeconds: DEGRADED_CACHE_TTL_SECONDS } : {}),
        })
        .catch(() => { /* swallow */ }),
    );
  }

  return budgeted;
}

/**
 * WP2/T3 (D14.2) — TTL for cache rows written from a degraded run. Long
 * enough to absorb a burst against a limping provider, short enough that a
 * salvaged (partial) result set can't shadow the recovered pipeline for the
 * normal cache TTL.
 */
export const DEGRADED_CACHE_TTL_SECONDS = 60;

/**
 * RRF/dedup identity for a result row, at chunk granularity.
 *
 * Includes `source_id` so two same-slug pages in different federated sources
 * don't collapse into one fusion entry (the same composite-key discipline
 * `dedup.ts:pageKey` already uses at page granularity). Pre-fix the key was
 * `slug:chunk_id`, which silently merged cross-source rows and let a
 * synthetic chunkless row (chunk_id null) key on a text prefix; the
 * `(source_id, slug, chunk_id)` shape is collision-safe for both.
 */
function rrfKey(r: SearchResult): string {
  const source = r.source_id ?? 'default';
  return `${source}:${r.slug}:${r.chunk_id ?? r.chunk_text.slice(0, 50)}`;
}

/**
 * Canonical query-cache scope key.
 *
 * The semantic cache stores results keyed by `(scope, query, knobs_hash)`.
 * A federated search (`sourceIds`) reads a different graph than a
 * single-source one, so the two must never share a cache row. Pre-fix the
 * cache only saw scalar `sourceId`; a federated query fell through to
 * `'default'` and could cross-serve an unrelated scope.
 *
 *   - federated (sourceIds set) → `__set__:` + sorted, comma-joined ids
 *     (order-independent; two different source-sets get distinct keys)
 *   - scalar sourceId           → the id itself (single-source unchanged)
 *   - unscoped                  → `'__unscoped__'` sentinel (#3871)
 *
 * #3871: an UNSCOPED search reads ALL sources, so its cached result set can
 * carry rows from every source. It used to key to `'default'` — the same
 * key a scalar `sourceId: 'default'` read uses — so a default-source-scoped
 * read could be served an all-sources row (cross-source leak). The
 * `'__unscoped__'` sentinel keeps the two populations on distinct rows;
 * `filterResultsByCallerScope` on the hit path is the belt-and-braces for
 * legacy rows written under the old scheme.
 */
export function cacheScopeKey(opts?: { sourceId?: string; sourceIds?: string[] }): string {
  if (opts?.sourceIds && opts.sourceIds.length > 0) {
    return '__set__:' + [...opts.sourceIds].sort().join(',');
  }
  return opts?.sourceId ?? '__unscoped__';
}

/**
 * #3871 — re-filter cached results by the CALLER's scope (hit-path
 * defense-in-depth). A cache row written under the pre-fix key scheme
 * (unscoped all-sources writes keyed `'default'`) can hold rows from ANY
 * source; serving it verbatim to a scoped read is a cross-source leak.
 * The `'__unscoped__'` key split stops NEW contamination; this filter
 * guarantees even a legacy/poisoned row can never page foreign rows into
 * a scoped response. Runs BEFORE offset/limit so foreign rows can't
 * displace legitimate ones off the page either.
 *
 *   - federated (sourceIds set) → set membership on (source_id ?? 'default')
 *   - scalar sourceId           → (source_id ?? 'default') === sourceId
 *   - unscoped                  → no filter (caller reads all sources)
 */
export function filterResultsByCallerScope(
  results: SearchResult[],
  opts?: { sourceId?: string; sourceIds?: string[] },
): SearchResult[] {
  if (opts?.sourceIds && opts.sourceIds.length > 0) {
    const allowed = new Set(opts.sourceIds);
    return results.filter((r) => allowed.has(r.source_id ?? 'default'));
  }
  if (opts?.sourceId != null) {
    return results.filter((r) => (r.source_id ?? 'default') === opts.sourceId);
  }
  return results;
}

/**
 * v0.32.x search-lite — weighted RRF. Each list contributes with its own
 * effective k value, which lets intent weighting bias keyword vs vector
 * lists without re-weighting individual scores. Wraps rrfFusion internally
 * by computing weighted contributions in a single pass.
 */
export function rrfFusionWeighted(
  lists: Array<{ list: SearchResult[]; k: number }>,
  applyBoost = true,
): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number; keywordHit: boolean }>();

  for (const { list, k } of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = rrfKey(r);
      const existing = scores.get(key);
      const rrfScore = 1 / (k + rank);

      if (existing) {
        existing.score += rrfScore;
        // #3783 — OR-propagate lexical-arm membership: a row that fusion
        // first saw via a vector list must still read keyword_hit when the
        // keyword arm ALSO surfaced it.
        if (r.keyword_hit === true) existing.keywordHit = true;
      } else {
        scores.set(key, { result: r, score: rrfScore, keywordHit: r.keyword_hit === true });
      }
    }
  }

  const entries = Array.from(scores.values());
  if (entries.length === 0) return [];

  const maxScore = Math.max(...entries.map(e => e.score));
  if (maxScore > 0) {
    for (const e of entries) {
      e.score = e.score / maxScore;
      // issue #160: unverified auto-extracted stubs (stamped pre-fusion by
      // stampUnverifiedExtractions) never get the compiled-truth authority boost.
      const boost = applyBoost && e.result.chunk_source === 'compiled_truth' && e.result.unverified !== true ? COMPILED_TRUTH_BOOST : 1.0;
      e.score *= boost;
    }
  }

  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score, keywordHit }) =>
      keywordHit && result.keyword_hit !== true
        ? { ...result, score, keyword_hit: true }
        : { ...result, score });
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * Each result gets score = sum(1 / (K + rank)) across all lists it appears in.
 * After accumulation: normalize to 0-1, then boost compiled_truth chunks.
 */
export function rrfFusion(lists: SearchResult[][], k: number, applyBoost = true): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number; keywordHit: boolean }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = rrfKey(r);
      const existing = scores.get(key);
      const rrfScore = 1 / (k + rank);

      if (existing) {
        existing.score += rrfScore;
        // #3783 — OR-propagate lexical-arm membership across merge order.
        if (r.keyword_hit === true) existing.keywordHit = true;
      } else {
        scores.set(key, { result: r, score: rrfScore, keywordHit: r.keyword_hit === true });
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

      // Apply compiled truth boost after normalization (skip for detail=high;
      // skip for unverified auto-extracted stubs — issue #160)
      const boost = applyBoost && e.result.chunk_source === 'compiled_truth' && e.result.unverified !== true ? COMPILED_TRUTH_BOOST : 1.0;
      e.score *= boost;

      if (DEBUG) {
        console.error(`[search-debug] ${e.result.slug}:${e.result.chunk_id} rrf_raw=${rawScore.toFixed(4)} rrf_norm=${(rawScore / maxScore).toFixed(4)} boost=${boost} boosted=${e.score.toFixed(4)} source=${e.result.chunk_source}`);
      }
    }
  }

  // Sort by boosted score descending
  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score, keywordHit }) =>
      keywordHit && result.keyword_hit !== true
        ? { ...result, score, keyword_hit: true }
        : { ...result, score });
}

/**
 * Cosine re-scoring: blend RRF score with query-chunk cosine similarity.
 * Runs before dedup so semantically better chunks survive.
 *
 * Exported (only) for direct unit testing of the chunkless-row blend fix
 * (#3695) — not part of the public search API surface.
 */
export async function cosineReScore(
  engine: BrainEngine,
  results: SearchResult[],
  queryEmbedding: Float32Array,
  column: string = 'embedding',
): Promise<SearchResult[]> {
  const chunkIds = results
    .map(r => r.chunk_id)
    .filter((id): id is number => id != null);

  if (chunkIds.length === 0) return results;

  let embeddingMap: Map<number, Float32Array>;
  try {
    // v0.36 (D9): hydrate from the active column so rescore happens in
    // the same embedding space the HNSW just ranked in. Without this,
    // a Voyage HNSW retrieval would HNSW-rank against Voyage vectors but
    // rescore against OpenAI vectors → NaN or wrong rankings.
    embeddingMap = await engine.getEmbeddingsByChunkIds(chunkIds, column);
  } catch {
    // DB error is non-fatal, return results without re-scoring
    return results;
  }

  if (embeddingMap.size === 0) return results;

  // Normalize RRF scores to 0-1 for blending
  const maxRrf = Math.max(...results.map(r => r.score));

  return results.map(r => {
    // v0.46.28.0 (#3695): a row with no hydratable chunk embedding (the
    // synthetic chunkless row for an embed_skip'd oversized page, or a
    // chunk_id whose embedding didn't hydrate) used to return `r` untouched
    // — keeping its RAW post-RRF score on a [0, ~2.0] scale while every
    // other row got compressed onto the [0, 1.0] blended scale below. That
    // gave chunkless rows a structural 2x head start (#3695's reported
    // symptom: an empty-snippet embed_skip page outranking on-point
    // results). Route it through the SAME blend with cosine=0 instead of
    // excluding it — excluding would make embed_skip pages unsearchable,
    // a different (undesired) behavior change.
    const chunkEmb = r.chunk_id != null ? embeddingMap.get(r.chunk_id) : undefined;
    const cosine = chunkEmb ? cosineSimilarity(queryEmbedding, chunkEmb) : 0;
    const normRrf = maxRrf > 0 ? r.score / maxRrf : 0;
    const blended = 0.7 * normRrf + 0.3 * cosine;

    if (DEBUG) {
      console.error(`[search-debug] ${r.slug}:${r.chunk_id} cosine=${cosine.toFixed(4)} norm_rrf=${normRrf.toFixed(4)} blended=${blended.toFixed(4)}`);
    }

    // v0.46.15: stamp the raw cosine — evidence + --explain read it (the
    // hydration map is already paid for; zero extra probes).
    return { ...r, score: blended, cosine };
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
