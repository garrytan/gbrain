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
import { embed, embedQuery } from '../embedding.ts';
import { resolveEmbeddingColumn, isCacheSafe } from './embedding-column.ts';
import {
  resolveAdaptiveReturn,
  applyAdaptiveReturn,
  adaptiveReturnFromConfig,
  adaptiveReturnEnabled,
  type AdaptiveReturnDecision,
} from './return-policy.ts';
import { loadConfigWithEngine } from '../config.ts';
import { dedupResults } from './dedup.ts';
import { applyReranker } from './rerank.ts';
import { autoDetectDetail, classifyQuery, isAmbiguousModalityQuery } from './query-intent.ts';
import { isTitlePhraseMatch } from './title-match.ts';
import { normalizeAlias } from './alias-normalize.ts';
import { stampEvidence } from './evidence.ts';
import { expandAnchors, hydrateChunks } from './two-pass.ts';
import { enforceTokenBudget } from './token-budget.ts';
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
const pendingCacheWrites = new Set<Promise<unknown>>();

export async function awaitPendingSearchCacheWrites(): Promise<void> {
  if (pendingCacheWrites.size === 0) return;
  await Promise.allSettled([...pendingCacheWrites]);
}

function trackCacheWrite(promise: Promise<unknown>): void {
  pendingCacheWrites.add(promise);
  promise.finally(() => pendingCacheWrites.delete(promise)).catch(() => { /* swallow */ });
}
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
      const { DEFAULT_RECENCY_DECAY, DEFAULT_FALLBACK } = await import('./recency-decay.ts');
      applyRecencyBoost(
        results,
        dates,
        opts.recency,
        opts.decayMap ?? DEFAULT_RECENCY_DECAY,
        opts.fallback ?? DEFAULT_FALLBACK,
        Date.now(),
        floorThreshold,
      );
    } catch {
      // Non-fatal.
    }
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
  opts: { sourceId?: string; sourceIds?: string[] },
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
    injectScore += 1e-6;
    out.push({
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
  const innerLimit = Math.min(limit * 2, MAX_SEARCH_LIMIT);

  // v0.32.x search-lite: classify intent once up front. Drives BOTH the
  // legacy auto-detail / salience / recency suggestions AND the new
  // weight-adjustment path. Intent weighting is on by default and can
  // be disabled via `opts.intentWeighting = false`. The mode bundle
  // supplies the default when neither per-call nor per-key sets it.
  const suggestions = classifyQuery(query);
  const intentWeightingOn = resolvedMode.intentWeighting;
  const intentWeights = intentWeightingOn
    ? weightsForIntent(suggestions.intent)
    : weightsForIntent('general');

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
    // v0.36 (D11): pass the pre-validated descriptor into the engine so
    // it never has to read config. Engines normalize string-or-descriptor
    // via normalizeEngineColumn; the descriptor path is the strict one.
    embeddingColumn: resolvedCol,
  };
  // Track what actually ran for the optional onMeta callback (v0.25.0).
  // Caller leaves onMeta undefined → these flags are computed but never
  // surfaced. Capture wrapper passes a closure to receive the meta and
  // threads it into the eval_candidates row.
  let expansionApplied = false;

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
      recordSearchTelemetry(engine, meta, { results_count: lastResultsCount, rank1_score: lastRank1Score });
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
  const keywordResults: SearchResult[] =
    earlyModality === 'image' ? [] : await engine.searchKeyword(query, searchOpts);

  // v0.29.1: resolve salience/recency from caller (back-compat aliases for
  // PR #618's `recencyBoost` numeric scale) or fall back to the heuristic.
  // The wrapper fires from ALL THREE return paths (codex pass-1 #2 + pass-2 #4).
  //
  // v0.32.x search-lite: when caller hasn't set recency and the intent
  // classifier suggests one, prefer that (suggestedRecency on temporal /
  // event intents). The legacy heuristic still wins when intent weighting
  // is off.
  // Back-compat: recencyBoost: 1|2 → 'on'|'strong'; 0 → 'off'.
  const legacyRecency: 'off' | 'on' | 'strong' | undefined =
    opts?.recencyBoost === 2 ? 'strong' :
    opts?.recencyBoost === 1 ? 'on' :
    opts?.recencyBoost === 0 ? 'off' :
    undefined;
  const salienceMode: 'off' | 'on' | 'strong' = opts?.salience ?? suggestions.suggestedSalience;
  // Intent-weighting recency suggestion is a NUDGE — it only fires when
  // the caller left recency unspecified AND the legacy heuristic also
  // didn't fire. The classifier's own suggestedRecency (from v0.29.1)
  // still wins when it's set; the new intent suggestion is a fallback.
  const intentRecency =
    intentWeightingOn && intentWeights.suggestedRecency != null
      ? intentWeights.suggestedRecency
      : null;
  const recencyMode: 'off' | 'on' | 'strong' =
    opts?.recency
    ?? legacyRecency
    ?? (suggestions.suggestedRecency !== 'off'
        ? suggestions.suggestedRecency
        : (intentRecency ?? suggestions.suggestedRecency));
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

  // Skip vector search entirely if the gateway has no embedding provider configured (Codex C3).
  // v0.36 (D10): ask "is the RESOLVED column's provider reachable?" rather
  // than "is the global default reachable?" — otherwise an unreachable
  // global default disables vector search even when the active column's
  // provider (Voyage, ZE) works fine.
  const { isAvailable } = await import('../ai/gateway.ts');
  const providerProbe = resolvedCol.embeddingModel || undefined;
  if (!isAvailable('embedding', providerProbe)) {
    if (keywordResults.length > 0) {
      await runPostFusionStages(engine, keywordResults, postFusionOpts);
      keywordResults.sort((a, b) => b.score - a.score);
    }
    // T3/T4 — alias hop + evidence stamp even without an embedding provider
    // (the named-thing fix is most valuable exactly when vector is unavailable).
    const noEmbedHopped = await applyAliasHop(engine, dedupResults(keywordResults), query, {
      sourceId: opts?.sourceId,
      sourceIds: opts?.sourceIds,
    });
    stampEvidence(noEmbedHopped);
    const noEmbedSliced = noEmbedHopped.slice(offset, offset + limit);
    // v0.32.3 search-lite: budget enforcement on the no-embedding-provider path.
    const { results: noEmbedBudgeted, meta: noEmbedBudgetMeta } = enforceTokenBudget(noEmbedSliced, resolvedMode.tokenBudget);
    lastResultsCount = noEmbedBudgeted.length;
    lastRank1Score = noEmbedBudgeted[0] ? (noEmbedBudgeted[0].base_score ?? noEmbedBudgeted[0].score) : undefined;
    emitMeta({
      vector_enabled: false,
      detail_resolved: detailResolved,
      expansion_applied: false,
      intent: suggestions.intent,
      mode: resolvedMode.resolved_mode,
      embedding_column: resolvedCol.name,
      ...(resolvedMode.tokenBudget && resolvedMode.tokenBudget > 0
        ? { token_budget: noEmbedBudgetMeta }
        : {}),
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
    } catch {
      // Expansion failure is non-fatal
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
      if (!aiIsAvailable('embedding')) {
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
    }
  }

  if (!unifiedDone && (effectiveModality === 'image' || effectiveModality === 'both')) {
    // Attempt image-side embedding. Fail-open: if multimodal is unconfigured
    // OR the embed throws, log a structured warning and fall through to text.
    try {
      const { isAvailable: aiIsAvailable, embedQueryMultimodal } = await import('../ai/gateway.ts');
      if (!aiIsAvailable('embedding')) {
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
    try {
      const embedOpts = resolvedCol.embeddingModel
        ? { embeddingModel: resolvedCol.embeddingModel, dimensions: resolvedCol.dimensions }
        : undefined;
      const embeddings = await Promise.all(queries.map(q => embedQuery(q, embedOpts)));
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
    } catch {
      // Embedding failure is non-fatal, fall back to keyword-only
    }
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
    const kwHopped = await applyAliasHop(engine, dedupResults(keywordResults), query, {
      sourceId: opts?.sourceId,
      sourceIds: opts?.sourceIds,
    });
    stampEvidence(kwHopped);
    const kwSliced = kwHopped.slice(offset, offset + limit);
    // v0.32.3 search-lite: budget enforcement on the keyword-fallback path too.
    const { results: kwBudgeted, meta: kwBudgetMeta } = enforceTokenBudget(kwSliced, resolvedMode.tokenBudget);
    lastResultsCount = kwBudgeted.length;
    lastRank1Score = kwBudgeted[0] ? (kwBudgeted[0].base_score ?? kwBudgeted[0].score) : undefined;
    emitMeta({
      vector_enabled: false,
      detail_resolved: detailResolved,
      expansion_applied: expansionApplied,
      intent: suggestions.intent,
      mode: resolvedMode.resolved_mode,
      embedding_column: resolvedCol.name,
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
  let fused = rrfFusionWeighted(allLists, detail !== 'high');

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
  const aliasHopped = await applyAliasHop(engine, reranked, query, {
    sourceId: opts?.sourceId,
    sourceIds: opts?.sourceIds,
  });

  // T4 — stamp evidence + create_safety so the agent's don't-duplicate
  // decision keys off WHY a page matched, not a raw blended score. Stamp on
  // the full alias-hopped set before any adaptive trim so the kept results
  // carry evidence regardless of where the cap lands.
  stampEvidence(aliasHopped);

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
    const r = applyAdaptiveReturn(aliasHopped, suggestions.intent, adaptiveCfg);
    returnPool = r.kept;
    adaptiveDecision = r.decision;
  }

  const sliced = returnPool.slice(offset, offset + limit);
  // v0.32.3 search-lite: budget enforcement at the main return path.
  // hybridSearchCached used to be the only place this fired; now bare
  // hybridSearch enforces it too so eval-replay + eval-longmemeval see
  // the same budget behavior as the production query op.
  const { results: budgeted, meta: budgetMeta } = enforceTokenBudget(sliced, resolvedMode.tokenBudget);
  lastResultsCount = budgeted.length;
  lastRank1Score = budgeted[0] ? (budgeted[0].base_score ?? budgeted[0].score) : undefined;
  emitMeta({
    vector_enabled: true,
    detail_resolved: detailResolved,
    expansion_applied: expansionApplied,
    intent: suggestions.intent,
    mode: resolvedMode.resolved_mode,
    embedding_column: resolvedCol.name,
    ...(resolvedMode.tokenBudget && resolvedMode.tokenBudget > 0
      ? { token_budget: budgetMeta }
      : {}),
    ...(adaptiveDecision ? { adaptive_return: adaptiveDecision } : {}),
  });
  return budgeted;
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

  // Cache key carries the column + provider so different embedding spaces
  // never collide on the same `(source_id, query_text)` row.
  const cacheKnobsHash = knobsHash(resolvedForCache, {
    embeddingColumn: resolvedColCached.name,
    embeddingModel: resolvedColCached.embeddingModel,
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
  const skipCache =
    !cache.isEnabled() ||
    (opts?.walkDepth ?? 0) > 0 ||
    Boolean(opts?.nearSymbol) ||
    isNonDefaultColumn ||
    adaptiveReturnOn;

  let cacheStatus: 'hit' | 'miss' | 'disabled' = skipCache ? 'disabled' : 'miss';
  let cacheSimilarity: number | undefined;
  let cacheAge: number | undefined;

  // We need a query embedding to consult the cache. We try to embed once
  // here so the same embedding can be threaded back into the search call
  // if it misses — but the embedding helper isn't cheap, so we only
  // attempt it when the cache is enabled AND the gateway has an embedding
  // provider configured.
  let queryEmbedding: Float32Array | null = null;
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
        queryEmbedding = await embedQuery(query);
      } else {
        cacheStatus = 'disabled';
      }
    } catch {
      cacheStatus = 'disabled';
      queryEmbedding = null;
    }
  }

  if (!skipCache && queryEmbedding && cacheStatus !== 'disabled') {
    const hit = await cache.lookup(queryEmbedding, { sourceId: opts?.sourceId, knobsHash: cacheKnobsHash });
    if (hit.hit && hit.results) {
      cacheStatus = 'hit';
      cacheSimilarity = hit.similarity;
      cacheAge = hit.ageSeconds;

      const limit = opts?.limit || 20;
      const offset = opts?.offset || 0;
      const sliced = hit.results.slice(offset, offset + limit);

      // Budget enforcement — same pipeline tail as fresh path.
      const { results: budgeted, meta: budgetMeta } = enforceTokenBudget(sliced, opts?.tokenBudget);

      // Emit meta describing the cache path.
      const cachedMeta: HybridSearchMeta = {
        vector_enabled: hit.meta?.vector_enabled ?? true,
        detail_resolved: hit.meta?.detail_resolved ?? null,
        expansion_applied: hit.meta?.expansion_applied ?? false,
        intent: hit.meta?.intent,
        cache: {
          status: 'hit',
          similarity: cacheSimilarity,
          age_seconds: cacheAge,
        },
        ...(opts?.tokenBudget && opts.tokenBudget > 0
          ? { token_budget: budgetMeta }
          : {}),
      };
      try {
        opts?.onMeta?.(cachedMeta);
      } catch {
        // swallow — telemetry is best-effort
      }
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
    onMeta: (m) => {
      innerMetaBox.current = m;
      // Do NOT call userOnMeta here — we'll emit a merged meta below
      // that also carries cache + budget info.
    },
  });
  const innerMeta = innerMetaBox.current;

  // Token budget pass (no-op when not set).
  const { results: budgeted, meta: budgetMeta } = enforceTokenBudget(results, opts?.tokenBudget);

  // Compose the final meta and emit.
  const finalMeta: HybridSearchMeta = {
    vector_enabled: innerMeta?.vector_enabled ?? false,
    detail_resolved: innerMeta?.detail_resolved ?? null,
    expansion_applied: innerMeta?.expansion_applied ?? false,
    intent: innerMeta?.intent,
    cache: { status: cacheStatus },
    ...(opts?.tokenBudget && opts.tokenBudget > 0
      ? { token_budget: budgetMeta }
      : {}),
  };
  try {
    userOnMeta?.(finalMeta);
  } catch {
    // swallow
  }

  // Best-effort writeback (skip when search returned empty so we don't
  // cache zero-result queries forever — they often indicate a typo).
  if (
    cacheStatus === 'miss' &&
    queryEmbedding &&
    results.length > 0 &&
    (innerMeta?.vector_enabled ?? false)
  ) {
    trackCacheWrite(
      cache
        .store(query, queryEmbedding, results, finalMeta, { sourceId: opts?.sourceId, knobsHash: cacheKnobsHash })
        .catch(() => { /* swallow */ }),
    );
  }

  return budgeted;
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
  const scores = new Map<string, { result: SearchResult; score: number }>();

  for (const { list, k } of lists) {
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

  const maxScore = Math.max(...entries.map(e => e.score));
  if (maxScore > 0) {
    for (const e of entries) {
      e.score = e.score / maxScore;
      const boost = applyBoost && e.result.chunk_source === 'compiled_truth' ? COMPILED_TRUTH_BOOST : 1.0;
      e.score *= boost;
    }
  }

  return entries
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
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
