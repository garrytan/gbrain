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
// Type-only (erased at compile time — mode.ts stays a runtime dynamic import
// at each call site below): the loaded snapshot shape for _searchModeInput.
import type { ResolveSearchModeInput } from './mode.ts';
import type {
  SearchResult,
  PageReadPolicy,
  SearchOpts,
  HybridSearchMeta,
} from '../types.ts';
import { affectsRecall } from '../types.ts';
export { resolveDateBoundary, resolveSearchDateBounds } from './date-bounds.ts';
import { hasReadPolicy, pageReadFilter } from './read-policy-sql.ts';
import { embedQuery } from '../embedding.ts';
import { loadEmbeddingQueryPrefix } from './query-prefix.ts';
import { registerBackgroundWorkDrainer } from '../background-work.ts';
import { applyAliasHop, isExcludedIdentity, type IdentityTierOpts } from './alias-hop.ts';
export { applyAliasHop, isExcludedIdentity, type IdentityTierOpts };
import { dedupResults } from './dedup.ts';
import { accumulateRrf } from './rrf-page-fusion.ts';
import {
  isAmbiguousModalityQuery,
} from './query-intent.ts';
import { isTitlePhraseMatch } from './title-match.ts';
import {
  textArmsNonEmpty,
  type VectorArm,
  type FusionListEntry,
} from './fusion-lists.ts';
import { type MetadataBoostGate } from './metadata-boost-gate.ts';
import { enforceTokenBudget } from './token-budget.ts';
import {
  semanticResultCacheAvailable,
} from './query-cache.ts';
import { resolveHybridRequest } from './hybrid/request.ts';
import { prepareSemanticCache, resolveCacheSearchMode, semanticCacheSkipped, serveSemanticCacheHit } from './hybrid/cache-stages.ts';
import { buildPostFusionOpts, buildRelationalList, resolveModalityAndQueries, runLexicalArms, runVectorArms } from './hybrid/arms.ts';
import { searchVectorFallback, searchWithoutEmbeddings } from './hybrid/keyword-only.ts';
import { expandStructuralNeighbors, finalizeHybridResults, fuseArms, rerankAndPin, sizeReturnPool } from './hybrid/rank.ts';

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

/**
 * Compiled-truth tilt for an AUTO-detected `low` (entity intent, never an
 * explicit `detail: 'low'`). Auto intent is a guess from framing words ("who
 * is", "tell me about"), so it must not hide timeline evidence: no SQL
 * filter, and a soft preference instead of the categorical 2x boost.
 */
export const AUTO_LOW_COMPILED_TRUTH_TILT = 1.2;

/**
 * The fusion-boost argument for `rrfFusionWeighted`: `true` (full 2x) only for
 * an explicit `low`, the soft tilt for an auto-detected `low`, `false` otherwise.
 */
export function compiledTruthFusionBoost(
  detail: string | null | undefined,
  explicitDetail: string | null | undefined,
): boolean | number {
  if (!shouldBoostCompiledTruth(detail)) return false;
  return explicitDetail === 'low' ? true : AUTO_LOW_COMPILED_TRUTH_TILT;
}

/**
 * #3695 — the boost multiplier for one fused row. The title arm COALESCEs a
 * page with no text chunk into a synthetic row (chunk_id 0 + empty chunk_text,
 * both engines' searchTitles); it has no real compiled_truth chunk and must
 * not gain chunk authority — pre-fix the 2x boost let an embed_skip page ride
 * to #1 with an empty snippet on the keyword-only / no-provider paths where
 * cosineReScore never runs. Unverified auto-extracted stubs stay excluded
 * (issue #160, stamped pre-fusion by stampUnverifiedExtractions).
 */
export function compiledTruthBoost(result: SearchResult, applyBoost: boolean, boost: number = COMPILED_TRUTH_BOOST): number {
  const syntheticTitleRow = result.chunk_id === 0 && (result.chunk_text ?? '').trim().length === 0;
  return applyBoost &&
    result.chunk_source === 'compiled_truth' &&
    result.unverified !== true &&
    !syntheticTitleRow
    ? boost
    : 1.0;
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
export async function stampContentFlags(engine: BrainEngine, results: SearchResult[], policy?: PageReadPolicy): Promise<void> {
  if (results.length === 0) return;
  try {
    const ids = [...new Set(
      results.map((r) => r.page_id).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
    )];
    if (ids.length === 0) return;
    const flags = await engine.getContentFlagsByPageIds(ids, policy);
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
  policy?: PageReadPolicy,
): Promise<void> {
  if (results.length === 0) return;
  try {
    const ids = [...new Set(
      results.map((r) => r.page_id).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
    )];
    if (ids.length === 0) return;
    const marks = await engine.getUnverifiedExtractionPageIds(ids, policy);
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
 * Caller fetches counts via engine.getBacklinkCounts. Counts are keyed by
 * page_id, not slug, so namesake slugs across sources never share a boost
 * (#4380).
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
  counts: Map<number, number>,
  floorThreshold?: number,
): void {
  for (const r of results) {
    if (!Number.isFinite(r.score)) continue;
    if (floorThreshold !== undefined && r.score < floorThreshold) continue;
    const count = counts.get(r.page_id) ?? 0;
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
export interface PostFusionOpts extends PageReadPolicy {
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
  /**
   * Ranker wave (Phase E3, Cat 13) — `search.metadata_boost_gate = lexical`
   * resolved to "the vector arm was the only voter" (metadata-boost-gate.ts).
   * True skips the metadata-axis stages — backlink, salience, recency (+ the
   * chronicle type boost inside it), graph signals (incl. its telemetry
   * sinks), alias-resolved — so hub pages cannot re-order a pure vector
   * ranking. The title-phrase boost (lexical signal) and the supersede
   * downrank (correctness) still run. Undefined / false → every stage as before.
   */
  skipMetadataBoosts?: boolean;
}

export async function runPostFusionStages(
  engine: import('../engine.ts').BrainEngine,
  results: SearchResult[],
  opts: PostFusionOpts,
): Promise<void> {
  if (results.length === 0) return;
  const policy = hasReadPolicy(opts) ? opts : undefined;

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
  // Phase E3 — metadata-axis stages gated as ONE block (see PostFusionOpts).
  const metadata = opts.skipMetadataBoosts !== true;

  // Backlink stage (existing behavior, preserved).
  if (metadata && opts.applyBacklinks) {
    try {
      const pageIds = Array.from(new Set(results.map(r => r.page_id)));
      const counts = await engine.getBacklinkCounts(pageIds, policy);
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
  if (metadata && opts.salience !== 'off') {
    try {
      const scores = await engine.getSalienceScores(refs, policy);
      applySalienceBoost(results, scores, opts.salience, floorThreshold);
    } catch {
      // Non-fatal.
    }
  }

  // Recency stage (per-prefix decay, no mattering).
  if (metadata && opts.recency !== 'off') {
    try {
      const dates = await engine.getEffectiveDates(refs, policy);
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
  if (metadata && opts.graphSignalsEnabled) {
    try {
      const { applyGraphSignals } = await import('./graph-signals.ts');
      await applyGraphSignals(results, engine, {
        ...policy,
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
  if (metadata) {
    try {
      await applyAliasResolvedBoost(results, engine, policy);
    } catch {
      // Non-fatal; preserves the per-stage contract.
    }
  }

  // supersession stage — runs LAST so the penalty applies to the fully-boosted
  // score. Down-ranks results whose page is the target of a `supersedes` link
  // (a newer/canon page supersedes it) and stamps `superseded`/`superseded_by`
  // for --explain, the contradiction probe, and agent renderers. The page-level
  // analogue of the superseded_by/expired_at awareness recall.ts applies to
  // facts. Fail-open per the per-stage contract: a brain with no `supersedes`
  // edges (or a pre-links schema) finds 0 rows / throws and no-ops.
  try {
    await applySupersedeDownrank(results, engine, policy);
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
  policy?: PageReadPolicy,
): Promise<void> {
  if (results.length === 0) return;
  const pageIds = Array.from(
    new Set(results.map(r => r.page_id).filter((id): id is number => typeof id === 'number')),
  );
  if (pageIds.length === 0) return;
  if (!(await hasAnySupersedeEdges(engine))) return;
  const params: unknown[] = [pageIds];
  const fromFilter = pageReadFilter('pf', policy, params, !!policy);
  const toFilter = pageReadFilter('pt', policy, params, !!policy);
  const originFilter = policy ? `(l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages origin WHERE origin.id = l.origin_page_id AND ${pageReadFilter('origin', policy, params, true)}))` : 'TRUE';
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
          AND l.to_page_id = ANY($1::bigint[])
          AND ${fromFilter} AND ${toFilter} AND ${originFilter}`,
      params,
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
  policy?: PageReadPolicy,
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
  const params: unknown[] = [sourceIds, slugs];
  const filter = pageReadFilter('p', policy, params, !!policy);
  let rows: Array<{ source_id: string; canonical_slug: string }> = [];
  try {
    rows = await engine.executeRaw<{ source_id: string; canonical_slug: string }>(
      `SELECT DISTINCT a.source_id, a.canonical_slug
       FROM slug_aliases a JOIN pages p ON p.source_id = a.source_id AND p.slug = a.canonical_slug
       WHERE (a.source_id, a.canonical_slug) IN (
         SELECT * FROM unnest($1::text[], $2::text[])
       ) AND ${filter}`,
      params,
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

export interface HybridSearchOpts extends SearchOpts {
  expansion?: boolean;
  /**
   * #5428 — opt-in single-token alias hop (see applyAliasTokenHop). Per-call
   * wins; otherwise brain config `search.alias_token_hop=true`. Default off.
   */
  aliasTokenHop?: boolean;
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
  /**
   * Per-call override for `search.expansion_variant_budget` — the total RRF
   * weight shared by all expansion variant/clause lists (fusion-lists.ts).
   * `undefined` → config/bundle; `null` forces legacy weighting (weight 1).
   * Valid range is (0, 4]; anything else (0, negative, > 4, NaN) is treated
   * as unset via `normalizeExpansionVariantBudget` (fusion-lists.ts — the one
   * range contract shared with the config-key parser). Threaded through
   * resolveSearchMode in BOTH the inner search and the cache resolver (knobs
   * hash reflects it); eval budget sweeps drive it here.
   */
  expansionVariantBudget?: number | null;
  /**
   * Per-call override for `search.keyword_arm_confidence_floor` — below this
   * scale-free keyword-arm confidence the keyword + title lists fuse at half
   * weight (arm-confidence.ts). `undefined` → config/bundle; `null` forces
   * off. Range (0, 1]; anything else is unset via the ONE contract
   * `normalizeKeywordArmConfidenceFloor`. Threaded through resolveSearchMode
   * in BOTH the inner search and the cache resolver (knobs hash `kacf=`).
   */
  keywordArmConfidenceFloor?: number | null;
  /**
   * Per-call override for `search.metadata_boost_gate` (metadata-boost-gate.ts):
   * `lexical` skips the post-fusion metadata boosts when the vector arm was the
   * only voter; `always` = today's pipeline. `undefined` → config/bundle;
   * anything else is unset via the ONE contract `normalizeMetadataBoostGate`.
   * Threaded through resolveSearchMode in BOTH the inner search and the cache
   * resolver (knobs hash `mbg=`); eval A/B runs drive it here.
   */
  metadataBoostGate?: MetadataBoostGate;
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
   * Eval capture (ranker wave, plan D24) — fires immediately before
   * `applyAutocut` with `pool` = the pre-autocut `returnPool`, byte-identical
   * to applyAutocut's input: post-rerank AND post alias-hop / exact-lookup /
   * adaptive-return, INCLUDING unscored injected rows (alias / exact-lookup
   * hits carry no `rerank_score`), BEFORE the autocut / limit slice. Fires
   * even when autocut itself is off (the replay's "off" cell reads the same
   * capture). `preRerank` is the deduped pre-rerank RRF order, for rank
   * attribution. Best-effort: a throwing callback never breaks the search.
   * Never set on production paths.
   */
  onRerankPool?: (pool: readonly SearchResult[], preRerank: readonly SearchResult[]) => void;
  /**
   * v0.42.20.0 (Fix 3, #1775) INTERNAL — shared query-embed deadline threaded
   * from `hybridSearchCached` into the inner `hybridSearch` so the cache-lookup
   * embed and the inner embed share ONE wall-clock budget (worst case ~one
   * timeout, not two). Direct `hybridSearch` callers leave it undefined and get
   * a fresh per-call deadline. Not part of the public contract.
   */
  _queryEmbedDeadline?: QueryEmbedDeadline;
  /**
   * #5691 INTERNAL — the brain's `embedding_query_prefix`, read once per
   * request (by `hybridSearchCached`, or by `hybridSearch` when undefined) and
   * prepended to the text vector arm's query embeddings only.
   */
  _queryPrefix?: string;

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

  /**
   * INTERNAL (#4359) — the LOADED search-mode config snapshot (the return
   * value of `loadSearchModeConfig`), threaded from `hybridSearchCached`
   * into the inner `hybridSearch` so the cached path reads the config table
   * once and both sides resolve from the SAME snapshot (two independent
   * reads let a mid-request config change key the cache row from a stale
   * snapshot). Only the LOADED snapshot is shared — each site still calls
   * `resolveSearchMode` itself (the wrapper folds in cache-only knobs), so
   * bare `hybridSearch` keeps resolving on its own for direct callers
   * (`[CDX-5+6]`), which leave this undefined. Not part of the public contract.
   */
  _searchModeInput?: ResolveSearchModeInput;
}

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
  embedOpts: { embeddingModel?: string; dimensions?: number; queryPrefix?: string } | undefined,
  dl: QueryEmbedDeadline,
): Promise<Float32Array> {
  // Floor the budget so a healthy embed isn't starved when the shared absolute
  // deadline was mostly consumed by prior work (codex). Still bounded overall.
  const remaining = Math.max(MIN_QUERY_EMBED_BUDGET_MS, dl.deadlineAt - Date.now());
  const signal = AbortSignal.timeout(remaining);
  const p = embedQuery(text, { ...(embedOpts ?? {}), abortSignal: signal }).catch(error => {
    throw signal.aborted ? signal.reason : error;
  });
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


export async function hybridSearch(
  engine: BrainEngine,
  query: string,
  opts?: HybridSearchOpts,
): Promise<SearchResult[]> {
  if (opts?.types?.length === 0) return [];
  if (opts?.type || opts?.types?.length) {
    const { expandEngineTypeFilters } = await import('../schema-pack/query-types.ts');
    const filters = await expandEngineTypeFilters(engine, opts);
    if (filters.types?.length === 0) return [];
    opts = { ...opts, ...filters };
  }
  if (opts?._queryPrefix === undefined) opts = { ...opts, _queryPrefix: await loadEmbeddingQueryPrefix(engine) };
  // Named stages (src/core/search/hybrid/): request -> lexical arms ->
  // relational arm -> [keyword-only return] -> modality + expansion ->
  // vector arms -> [keyword fallback return] -> fusion + post-fusion boosts
  // -> structural expansion -> dedup -> rerank + pin -> identity tiers +
  // return sizing -> main return. Same order of every engine/provider call.
  const req = await resolveHybridRequest(engine, query, opts);
  const { resolvedMode, resolvedCol, cfgForColumn } = req;
  const lexical = await runLexicalArms(req);
  const { earlyModality } = lexical;
  const postFusionOpts = buildPostFusionOpts(req);
  const relationalList = await buildRelationalList(req);

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
    return searchWithoutEmbeddings(req, lexical, relationalList, postFusionOpts, providerProbe);
  }

  const { effectiveModality, unifiedRouting, queries } = await resolveModalityAndQueries(req);
  const { vectorArms, queryEmbedding, imageQueryEmbedding, unifiedDone } =
    await runVectorArms(req, { effectiveModality, unifiedRouting, queries, multimodalProviderProbe });
  if (vectorArms.length === 0) {
    return searchVectorFallback(req, lexical, relationalList, postFusionOpts);
  }

  const { fused, relaxedDropped, keywordArmConfidence, metadataBoostGate } = await fuseArms(req, {
    vectorArms, keywordResults: lexical.keywordResults, titleResults: lexical.titleResults, relationalList,
    effectiveModality, queryEmbedding, imageQueryEmbedding, unifiedDone, postFusionOpts,
  });
  const dedupOpts = await expandStructuralNeighbors(req, fused);

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

  const { rerankPinned, relationalRerankPin } = await rerankAndPin(req, deduped, relationalList, effectiveModality);
  const { returnPool, adaptiveDecision, autocutDecision, relationalSlotDecision } = await sizeReturnPool(req, {
    rerankPinned, deduped, exactLookupOpts: lexical.exactLookupOpts, relationalList, effectiveModality,
  });
  return finalizeHybridResults(req, returnPool, {
    relaxedDropped, adaptiveDecision, autocutDecision, relationalSlotDecision,
    relationalRerankPin, keywordArmConfidence, metadataBoostGate,
  });
}

// ----------------------------------------------------------------------
// v0.32.x (search-lite) — cached + budgeted public wrapper
// ----------------------------------------------------------------------


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
  if (opts?.types?.length === 0) return [];
  const { modeInputForCache, resolvedForCache, knobsHash } = await resolveCacheSearchMode(engine, opts);
  const queryPrefix = opts?._queryPrefix ?? await loadEmbeddingQueryPrefix(engine);
  // Result caching is off (semanticResultCacheAvailable() === false): skip the
  // key/config setup entirely so the wrapper costs no round-trips of its own.
  const semanticCache = semanticResultCacheAvailable()
    ? await prepareSemanticCache(engine, query, opts, resolvedForCache, knobsHash, queryPrefix)
    : null;
  const skipCache = semanticCacheSkipped(opts, semanticCache);

  let cacheStatus: 'hit' | 'miss' | 'disabled' = skipCache ? 'disabled' : 'miss';

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
  if (semanticCache && !skipCache) {
    try {
      const { isAvailable } = await import('../ai/gateway.ts');
      // v0.36 (D10): for the cache-lookup embedding, also use the resolved
      // column's provider. The cache lookup is always against the default
      // 'embedding' column (skipCache short-circuits non-default above),
      // so this is the default embeddingModel — but threading it keeps
      // the provider probe consistent with the bare hybridSearch path.
      if (isAvailable('embedding', semanticCache.providerProbe)) {
        // v0.35.0.0+: query-side embedding (cache lookup path).
        // v0.42.20.0 (Fix 3) — bounded by the shared deadline; on timeout this
        // throws → caught below → cacheStatus 'disabled' → falls through to the
        // inner hybridSearch (which reuses the same elapsed deadline).
        queryEmbedding = await embedQueryBounded(query, queryPrefix ? { queryPrefix } : undefined, queryEmbedDl);
      } else {
        cacheStatus = 'disabled';
      }
    } catch {
      cacheStatus = 'disabled';
      queryEmbedding = null;
    }
  }

  if (semanticCache && !skipCache && queryEmbedding && cacheStatus !== 'disabled') {
    const served = await serveSemanticCacheHit(engine, query, opts, semanticCache, queryEmbedding, resolvedForCache);
    if (served) return served;
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
    _queryPrefix: queryPrefix,
    // #2952 — classify this search's telemetry record (emitted by the inner
    // function) with the cache-consult outcome. 'hit' already returned above,
    // so only miss/disabled reach this call.
    _telemetryCacheStatus: cacheStatus === 'disabled' ? 'disabled' : 'miss',
    // (#4359) one config read per call: thread the snapshot loaded above.
    _searchModeInput: modeInputForCache,
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
    semanticCache &&
    cacheStatus === 'miss' &&
    queryEmbedding &&
    results.length > 0 &&
    (innerMeta?.vector_enabled ?? false)
  ) {
    // v0.48.2: `reranker_skipped` is a CONFIG state (no provider key / dead
    // provider), not a transient provider limp — the result set is complete,
    // just unreranked, and will stay that way until the operator acts. It
    // keeps the full TTL (a keyless balanced brain must not churn its cache
    // every 60s); the stamp still rides the stored meta so a hit is honest.
    // Stale unreranked rows after a key appears expire within one TTL.
    const isDegraded = (finalMeta.degraded ?? []).some(affectsRecall);
    trackCacheWrite(
      semanticCache.cache
        .store(query, queryEmbedding, results, finalMeta, {
          sourceId: cacheScopeKey(opts),
          knobsHash: semanticCache.cacheKnobsHash,
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
 * 2026-09 fix wave — pure gate for the OR-relaxed lexical demotion: is the
 * TEXT vector arm healthy? ROLE-based (fusion-lists.ts): only arms whose
 * role is not `image` count, so in 'both' cross-modal mode the image arm
 * can't veto the lexical rescue — image evidence can't substitute for the
 * text-side rescue the relaxed rows exist to provide — and a fell-open
 * image branch with several text lists can't mis-tag a text list as the
 * image (the old positional "last list is the image" rule). Exported for
 * direct unit-testing (simulating the both-mode mixed state needs no engine).
 */
export function textVectorArmNonEmpty(arms: readonly VectorArm[]): boolean {
  return textArmsNonEmpty(arms);
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
 *
 * Each entry may also carry `weight` (default 1): the literature weighted-RRF
 * form `weight / (k + rank)` — a list-level vote multiplier that holds at
 * every rank (a k-penalty would fade at deep ranks). `weight` omitted or 1
 * is byte-identical to the unweighted formula. fusion-lists.ts sets it on
 * expansion variant/clause lists from `search.expansion_variant_budget`.
 */
export function rrfFusionWeighted(
  lists: FusionListEntry[],
  applyBoost: boolean | number = true,
): SearchResult[] {
  const entries = accumulateRrf(lists);
  if (entries.length === 0) return [];

  const maxScore = Math.max(...entries.map(e => e.score));
  if (maxScore > 0) {
    for (const e of entries) {
      e.score = e.score / maxScore;
      // issue #160 + #3695: unverified stubs and synthetic chunkless title
      // rows never get the compiled-truth authority boost. Numeric = factor.
      const boost = typeof applyBoost === 'number'
        ? compiledTruthBoost(e.result, true, applyBoost)
        : compiledTruthBoost(e.result, applyBoost);
      e.score *= boost;
    }
  }

  return entries
    .sort((a, b) => b.score - a.score || b.own - a.own)
    .map(({ result, score, keywordHit }) =>
      keywordHit && result.keyword_hit !== true
        ? { ...result, score, keyword_hit: true }
        : { ...result, score });
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * Each PAGE gets score = sum(1 / (K + rank)) across the lists it appears in
 * (its best rank per list), carried by the page's lead chunk; other chunks keep their own vote.
 * After accumulation: normalize to 0-1, then boost compiled_truth chunks.
 */
/**
 * CEO review D8 (2026-08 wave): the two-pass walk's widened per-page dedup
 * cap must never LOOSEN an EXPLICIT per-call maxPerPage — tightest wins in
 * both directions (an explicit 1 survives the walk's widening; an explicit
 * 15 is tightened to the walk cap). Pure + exported so the precedence rule
 * is unit-testable without a graph-walk fixture (the walk path itself is
 * engine-bound and default-off).
 */
export function resolveWalkDedupCap(explicitCap: number | undefined, capFromWalk: number): number {
  return explicitCap === undefined ? capFromWalk : Math.min(explicitCap, capFromWalk);
}

export function rrfFusion(lists: SearchResult[][], k: number, applyBoost = true): SearchResult[] {
  const entries = accumulateRrf(lists.map(list => ({ list, k })));
  if (entries.length === 0) return [];

  // Normalize to 0-1 by dividing by observed max
  const maxScore = Math.max(...entries.map(e => e.score));
  if (maxScore > 0) {
    for (const e of entries) {
      const rawScore = e.score;
      e.score = e.score / maxScore;

      // Apply compiled truth boost after normalization (skip for detail=high;
      // skip for unverified auto-extracted stubs — issue #160; skip for
      // synthetic chunkless title rows — #3695)
      const boost = compiledTruthBoost(e.result, applyBoost);
      e.score *= boost;

      if (DEBUG) {
        console.error(`[search-debug] ${e.result.slug}:${e.result.chunk_id} rrf_raw=${rawScore.toFixed(4)} rrf_norm=${(rawScore / maxScore).toFixed(4)} boost=${boost} boosted=${e.score.toFixed(4)} source=${e.result.chunk_source}`);
      }
    }
  }

  // Sort by boosted score descending; a page's own-vote leader breaks ties
  return entries
    .sort((a, b) => b.score - a.score || b.own - a.own)
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
  imageSpace?: { queryEmbedding: Float32Array; column: string },
): Promise<SearchResult[]> {
  // 'both' mode: image-arm rows live in the image space (image column,
  // multimodal query vector); everything else in the text space.
  const inImageSpace = (r: SearchResult): boolean => imageSpace !== undefined && r.modality === 'image';
  const idsFor = (image: boolean) => results
    .filter(r => inImageSpace(r) === image)
    .map(r => r.chunk_id)
    .filter((id): id is number => id != null);
  const chunkIds = idsFor(false);
  const imageChunkIds = idsFor(true);

  if (chunkIds.length === 0 && imageChunkIds.length === 0) return results;

  let embeddingMap: Map<number, Float32Array>;
  let imageEmbeddingMap = new Map<number, Float32Array>();
  try {
    // v0.36 (D9): hydrate from the active column so rescore happens in
    // the same embedding space the HNSW just ranked in. Without this,
    // a Voyage HNSW retrieval would HNSW-rank against Voyage vectors but
    // rescore against OpenAI vectors → NaN or wrong rankings.
    embeddingMap = chunkIds.length > 0 ? await engine.getEmbeddingsByChunkIds(chunkIds, column) : new Map();
    if (imageSpace && imageChunkIds.length > 0) {
      imageEmbeddingMap = await engine.getEmbeddingsByChunkIds(imageChunkIds, imageSpace.column);
    }
  } catch {
    // DB error is non-fatal, return results without re-scoring
    return results;
  }

  if (embeddingMap.size === 0 && imageEmbeddingMap.size === 0) return results;

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
    const image = inImageSpace(r);
    const chunkEmb = r.chunk_id != null ? (image ? imageEmbeddingMap : embeddingMap).get(r.chunk_id) : undefined;
    const cosine = chunkEmb ? cosineSimilarity(image ? imageSpace!.queryEmbedding : queryEmbedding, chunkEmb) : 0;
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
  // Vectors from different embedding spaces are incomparable: a length
  // mismatch used to yield a truncated dot product or NaN.
  if (a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
