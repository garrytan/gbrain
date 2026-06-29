/**
 * v0.32.3 search-lite mode bundles.
 *
 * Three named modes that bundle the search-lite knobs from PR #897 into a
 * single config key so users pick once at install time and stop thinking
 * about it. Each mode resolves to a complete knob set; per-call SearchOpts
 * and per-key config overrides still win — mode just supplies the default.
 *
 * The resolution chain matches the v0.31.12 model-tier pattern at
 * `src/core/model-config.ts:resolveModel`:
 *   per-call opts → per-key config → MODE_BUNDLES[cfg.search.mode] → MODE_BUNDLES.balanced
 *
 * `resolveSearchMode` is called at the top of bare `hybridSearch`, NOT just
 * inside the `hybridSearchCached` wrapper. Eval commands (`eval replay`,
 * `eval longmemeval`) call bare hybridSearch and must test the same
 * mode-affected behavior as production. See `[CDX-5+6]` in the plan.
 *
 * `knobsHash` produces the SHA-256 the query cache uses to prevent
 * cross-mode contamination. The PR #897 cache keyed only on
 * (source_id, query_text) — a tokenmax run with expansion+limit=50 would
 * populate a row that a subsequent conservative call reads back. Migration
 * v56 adds `knobs_hash` column; lookup filters by knobs_hash equality AND
 * embedding similarity. See `[CDX-4]` in the plan.
 */

import { createHash } from 'crypto';
import { CR_MODES, type CRMode } from '../types.ts';
import { getRecipe } from '../ai/recipes/index.ts';

/**
 * Look up the `reranker.default_timeout_ms` declared by the resolved
 * reranker model's recipe touchpoint. Returns undefined when:
 *   - modelStr is empty/null,
 *   - the provider id doesn't resolve to a registered recipe,
 *   - the recipe has no reranker touchpoint, or
 *   - the touchpoint doesn't declare a default_timeout_ms.
 *
 * Used by `resolveSearchMode()` to slot the recipe default between the
 * config-key override and the mode-bundle fallback for `reranker_timeout_ms`.
 * Local rerankers (CPU-only llama.cpp + 4B+ cross-encoder) need >5s for
 * first-call warmup; without this, the recipe field is dead because
 * hybridSearch always passes the bundle's 5000ms value to gateway.rerank().
 *
 * Crosses a layer boundary (mode → recipes) deliberately and bounded:
 * only the touchpoint timeout. Other touchpoint fields stay on the recipe.
 */
function lookupRerankerRecipeDefaultTimeout(modelStr: string | undefined): number | undefined {
  if (!modelStr) return undefined;
  const colon = modelStr.indexOf(':');
  const providerId = colon === -1 ? modelStr : modelStr.slice(0, colon);
  const recipe = getRecipe(providerId);
  return recipe?.touchpoints?.reranker?.default_timeout_ms;
}

export type SearchMode = 'conservative' | 'balanced' | 'tokenmax';

export const SEARCH_MODES: ReadonlyArray<SearchMode> = Object.freeze([
  'conservative',
  'balanced',
  'tokenmax',
]);

/**
 * A complete knob set for one mode. Every field is required so the bundle
 * is self-contained and per-key overrides are obvious diffs.
 */
export interface ModeBundle {
  /** Semantic query cache (PR #897). Free win; on for everyone. */
  cache_enabled: boolean;
  cache_similarity_threshold: number;
  cache_ttl_seconds: number;
  /** Zero-LLM intent classifier weight adjustments (PR #897). On for everyone. */
  intentWeighting: boolean;
  /**
   * Per-call token budget cap (PR #897). undefined = no-op (tokenmax).
   * 4000 = tight (conservative, fits Haiku context loop).
   * 12000 = balanced (sweet-spot for Sonnet).
   */
  tokenBudget: number | undefined;
  /**
   * LLM multi-query expansion (Haiku call per search).
   * Per CLAUDE.md TODOS the corpus eval shows ~97.6% lift relative to no
   * expansion — barely measurable. Off for conservative/balanced;
   * on for tokenmax to preserve power-user retrieval ceiling.
   */
  expansion: boolean;
  /**
   * Default `limit` for the operation layer (`src/core/operations.ts:1087`).
   * Note: production `query` op TODAY defaults to 20. Mode bundle becomes
   * the default ONLY when the caller omits the field — same chain semantics
   * as model-tier resolution. See `[CDX-1+2+3]` in the plan: the original
   * "tokenmax preserves Garry's setup" framing is wrong; tokenmax is an
   * EXPANSION from the implicit current default (limit 20).
   */
  searchLimit: number;
  /**
   * v0.35.0.0+ — cross-encoder reranker. Off for conservative/balanced,
   * on for tokenmax. ZeroEntropy zerank-2 by default; can be overridden
   * via `search.reranker.model`. Slots between dedup and token-budget
   * enforcement in hybrid.ts; fail-open on any RerankError (audit-logged).
   * Cost anchor: ~$0.0003/query at tokenmax topNIn=30 × ~400 tokens/chunk
   * (rounding error vs Opus, meaningful vs Haiku).
   */
  reranker_enabled: boolean;
  /**
   * Provider:model for the reranker. Default `'zeroentropyai:zerank-2'`.
   * Other ZE rerankers (`zerank-1`, `zerank-1-small`) work via the same
   * recipe; future Cohere/Voyage rerankers drop in as new recipes
   * declaring `touchpoints.reranker`.
   */
  reranker_model: string;
  /** Candidates to send upstream (default 30). The full result list always
   *  reaches the user — topNIn just caps API spend on the rerank call. */
  reranker_top_n_in: number;
  /**
   * Truncate the reranked output to this many. `null` = no truncate; the
   * caller's `limit` is what trims final output. Distinct from undefined
   * (which would fall through to mode bundle) — `null` is the explicit
   * "don't truncate" signal, see CDX2-F15+F16.
   */
  reranker_top_n_out: number | null;
  /** HTTP timeout in ms (default 5000). Threaded into gateway.rerank. */
  reranker_timeout_ms: number;

  /**
   * v0.35.6.0 — floor-ratio gate for metadata-axis boost stages (backlink,
   * salience, recency). `undefined` = no gate (default for all three modes;
   * preserves prior behavior bit-for-bit). When set to a number in [0, 1],
   * each gated stage skips results whose score is below
   * `floorRatio * topScore`, where topScore is computed ONCE at
   * runPostFusionStages entry from the post-cosine-rescore snapshot.
   *
   * Sensible operator override values for dense-embedder corpora: 0.85-0.95.
   * Default stays undefined until per-corpus ablation evidence supports a
   * mode-level default. See `TODOS.md` floor-ratio ablation entry.
   *
   * Scoped to the three metadata boost stages — exact-match boost
   * (intent-weights.applyExactMatchBoost) runs independently as a lexical
   * relevance signal and is NOT gated.
   */
  floor_ratio: number | undefined;

  /**
   * T2 (retrieval-maxpool incident) — title-phrase boost multiplier. When a
   * query is a contiguous token-run inside a page's title (or an exact full-
   * title match), multiply that result's score by this factor. <= 1.0 or
   * undefined disables. Floor-ratio-gated so a title hit can't bury a strong
   * semantic match. Correctness fix (cheap, in-memory) — ON in all bundles.
   * Override: per-call SearchOpts → `search.title_boost` config → bundle.
   */
  title_boost: number | undefined;

  // v0.36 cross-modal wave knobs (D2 + D3 + D6 + D8 + D13 + LLM-intent).
  // All three mode bundles default these to the same values — cross-modal
  // is opt-in per-call (D6 weighting), opt-in per-brain (D8 unified flags),
  // and opt-in per-feature-flag (LLM intent). The mode bundle just gives
  // resolveSearchMode a default to return.

  /**
   * D6 'both'-mode RRF weight for text-vector results when merging
   * text + image searches in parallel. Defaults to 0.6 — biases toward
   * text recall because most queries with ambiguous modality are still
   * text-leaning. Pair with cross_modal_both_image_weight.
   */
  cross_modal_both_text_weight: number;
  /**
   * D6 'both'-mode RRF weight for image-vector results. Defaults to 0.4.
   * Sum with text weight does NOT need to be 1.0 — RRF is rank-based, so
   * weights normalize internally; the ratio is what matters.
   */
  cross_modal_both_image_weight: number;
  /**
   * D13 image-query text-refinement RRF weight for the TEXT branch of
   * searchByImage when the caller provides an optional `query` refinement.
   * Defaults to 0.4 (image-dominant since the caller chose image-first).
   */
  image_query_text_refinement_weight: number;
  /**
   * D13 image-query refinement RRF weight for the IMAGE branch. Defaults to 0.6.
   */
  image_query_image_refinement_weight: number;
  /**
   * D8 Phase 3 flag: route ALL queries through the multimodal query embed
   * + `embedding_multimodal` column. Default false. Operator opt-in after
   * `gbrain reindex --multimodal` populates the unified column.
   */
  unified_multimodal: boolean;
  /**
   * D8 Phase 3 strict mode: when true, the dual-column fallback path is
   * bypassed entirely. Used by operators who finished re-embedding and
   * want to commit to the unified space. Doctor surface errors when this
   * is on and coverage < 99%.
   */
  unified_multimodal_only: boolean;
  /**
   * Commit 4: opt-in LLM tie-break for ambiguous modality classification.
   * Default false. When true, queries where regex returns 'text' but the
   * ambiguity heuristic fires get a Haiku call to refine the classification.
   * Fires for <1% of queries when on; ~$0.0001 per escalation.
   */
  cross_modal_llm_intent: boolean;
  /**
   * v0.40.4 — gate for the graph-signals stage (4th post-fusion stage).
   * Default: off for conservative, on for balanced + tokenmax. When on,
   * applyGraphSignals fires inside runPostFusionStages with three sub-
   * signals (adjacency hub, cross-source hub, session diversification).
   *
   * Magnitudes (graph-signals.ts constants): 1.05 / 1.10 / 0.95.
   * Conservative-by-construction (D14=B); calibration wave T-todo-2
   * tunes them against real production data after 30 days.
   *
   * Override path: per-call SearchOpts → `search.graph_signals` config
   * key → mode bundle default.
   */
  graph_signals: boolean;

  /**
   * v0.40.3.0 — contextual retrieval tier per mode. Wraps chunks at embed
   * time so the embedder sees document-level orientation alongside the
   * chunk. Wrapper is built JUST IN TIME and never persisted as
   * `content_chunks.chunk_text` (D20-T1 — search snippets, FTS, reranker,
   * debug all read the canonical chunk_text).
   *
   * Per-mode defaults (D1+D2):
   *   conservative → 'none' (minimum surface)
   *   balanced     → 'title' (free at runtime — pure string concat)
   *   tokenmax     → 'per_chunk_synopsis' (Anthropic's published method)
   *
   * Override resolution chain (D5+D6+D15): page frontmatter > source row >
   * global mode bundle. Mount-frontmatter overrides honored only when
   * `sources.trust_frontmatter_overrides` is true (host id='default' is
   * always trusted). See `src/core/contextual-retrieval-resolver.ts`.
   */
  contextual_retrieval: CRMode;

  /**
   * v0.40.3.0 — soft kill switch (D18). When true, `hybridSearch` treats
   * all tiers as 'none' at query time AND `import-file.ts` skips wrapper
   * resolution entirely. Existing wrapped vectors in `content_chunks`
   * keep serving queries (cosine similarity is preserved between wrapped
   * documents and raw queries). Single config-key rollback if quality
   * regresses post-deploy.
   */
  contextual_retrieval_disabled: boolean;

  /**
   * v0.42.3.0 — autocut (score-discontinuity result-sizing). Default OFF for
   * conservative (no reranker → no trustworthy cliff signal; would no-op
   * anyway), ON for balanced + tokenmax. When on AND a reranker scored ≥2
   * items, hybridSearch cuts the ranked set at the largest cross-encoder
   * rerank-score gap (instead of returning the full top-K). No-op without a
   * reranker. Override path: per-call SearchOpts.autocut → `search.autocut`
   * config → mode bundle. See src/core/search/autocut.ts.
   */
  autocut: boolean;
  /**
   * v0.42.3.0 — autocut sensitivity: the minimum normalized score gap (as a
   * fraction of the top score) that counts as a cliff. Default 0.20. Lower =
   * cuts more aggressively (tighter sets); higher = only cuts on dramatic
   * cliffs. Eval-derived starting point, calibrated by the PrecisionMemBench
   * run. Override: `search.autocut_jump` config → mode bundle.
   */
  autocut_jump: number;
  /**
   * v0.43 — relational recall arm. When on, a relational query ("who invested
   * in widget-co", "what connects fund-a and fund-b") resolves its seed
   * entity and walks the typed-edge graph, injecting edge-derived candidates
   * as a fourth RRF arm. Pure no-op for non-relational queries. Default OFF
   * for conservative; ON for balanced/tokenmax. Override path: per-call
   * SearchOpts.relationalRetrieval → `search.relational_retrieval` config →
   * mode bundle. See src/core/search/relational-recall.ts.
   */
  relationalRetrieval: boolean;
  /** v0.43 — max hops for relational traversal. Default 2, hard-capped at 3. */
  relational_retrieval_depth: number;
}

/**
 * The three mode bundles. Frozen at import time so a typo can't redefine
 * "conservative" to mean different things on different installs — the
 * public eval table depends on these being canonical. Power-user
 * customization happens via per-key config overrides; if there's real
 * demand for a custom bundle, that's a v0.34 conversation.
 */
export const MODE_BUNDLES: Readonly<Record<SearchMode, Readonly<ModeBundle>>> = Object.freeze({
  conservative: Object.freeze({
    cache_enabled: true,
    cache_similarity_threshold: 0.92,
    cache_ttl_seconds: 3600,
    intentWeighting: true,
    tokenBudget: 4000,
    expansion: false,
    searchLimit: 10,
    // v0.35.0.0+: reranker off — conservative is cost-sensitive; reranker
    // spend doesn't fit the tier's value prop.
    reranker_enabled: false,
    reranker_model: 'zeroentropyai:zerank-2',
    reranker_top_n_in: 30,
    reranker_top_n_out: null,
    reranker_timeout_ms: 5000,
    // v0.35.6.0 — undefined for all three bundles; the per-corpus ablation
    // (TODOS.md) gates any default flip.
    floor_ratio: undefined,
    // T2 — title-phrase boost ON by default (correctness fix, cheap + gated).
    title_boost: 1.25,
    // v0.36 cross-modal defaults (same across all modes — opt-in)
    cross_modal_both_text_weight: 0.6,
    cross_modal_both_image_weight: 0.4,
    image_query_text_refinement_weight: 0.4,
    image_query_image_refinement_weight: 0.6,
    unified_multimodal: false,
    unified_multimodal_only: false,
    cross_modal_llm_intent: false,
    // v0.40.4 — graph signals OFF for conservative (cost-sensitive tier,
    // matches the "minimize per-query overhead" posture). Signal still
    // useful for power users via per-call SearchOpts.graph_signals = true.
    graph_signals: false,
    // v0.40.3.0 contextual retrieval — none for conservative (minimum surface).
    contextual_retrieval: 'none' as CRMode,
    contextual_retrieval_disabled: false,
    // v0.42.3.0 — autocut OFF: conservative has no reranker, so no trustworthy
    // cliff signal exists (autocut would no-op). Explicit for clarity.
    autocut: false,
    // v0.43 — relational recall OFF for conservative (cost-sensitive tier,
    // matches graph_signals posture). Power users opt in per-call.
    relationalRetrieval: false,
    relational_retrieval_depth: 2,
    autocut_jump: 0.2,
  }),
  balanced: Object.freeze({
    cache_enabled: true,
    cache_similarity_threshold: 0.92,
    cache_ttl_seconds: 3600,
    intentWeighting: true,
    tokenBudget: 12000,
    expansion: false,
    searchLimit: 25,
    // v0.36.0.0 (D6): reranker flipped ON for `balanced` mode bundle. The
    // real-corpus benchmark shows zerank-2 reshuffles 60% of top-1 results
    // — the headline ZE quality story reaches the 80% of installs that
    // stay on `balanced`. Per-query rerank cost ~$0.025/M tokens, ~150ms
    // p50 added latency. Missing ZEROENTROPY_API_KEY is handled via
    // src/core/search/rerank.ts fail-open contract: log to audit JSONL,
    // return input order unchanged. Opt out with
    // `gbrain config set search.reranker.enabled false`.
    reranker_enabled: true,
    reranker_model: 'zeroentropyai:zerank-2',
    // v0.42.3.0 D4: topNIn = searchLimit (25) so the cross-encoder scores
    // every result the limit slice will return — no unscored tail for autocut
    // to wrongly drop (Codex #2). Was 30; tracking searchLimit is the
    // correctness precondition for autocut.
    reranker_top_n_in: 25,
    reranker_top_n_out: null,
    reranker_timeout_ms: 5000,
    // v0.35.6.0 — undefined for all three bundles; the per-corpus ablation
    // (TODOS.md) gates any default flip.
    floor_ratio: undefined,
    // T2 — title-phrase boost ON by default (correctness fix, cheap + gated).
    title_boost: 1.25,
    // v0.36 cross-modal defaults (same across all modes — opt-in)
    cross_modal_both_text_weight: 0.6,
    cross_modal_both_image_weight: 0.4,
    image_query_text_refinement_weight: 0.4,
    image_query_image_refinement_weight: 0.6,
    unified_multimodal: false,
    unified_multimodal_only: false,
    cross_modal_llm_intent: false,
    // v0.40.4 — graph signals ON for balanced. Adjacency + cross-source
    // signals exploit the link graph the brain already has; session
    // diversification stops same-session weak chunks from competing
    // with strong hits for token budget. Conservative magnitudes
    // (1.05/1.10/0.95) with floor-gate inheritance keep regression risk
    // bounded. Opt out with `gbrain config set search.graph_signals false`.
    graph_signals: true,
    // v0.40.3.0 contextual retrieval — title-only for balanced (free at
    // runtime; pure string concat, no Haiku). Default mode for most users
    // per the cost-tier philosophy.
    contextual_retrieval: 'title' as CRMode,
    contextual_retrieval_disabled: false,
    // v0.42.3.0 — autocut ON (reranker fires; cliff signal is trustworthy).
    autocut: true,
    // v0.43 — relational recall ON (contingent on the no-regression gate;
    // ships default-false everywhere if the gate flags any regression).
    relationalRetrieval: true,
    relational_retrieval_depth: 2,
    autocut_jump: 0.2,
  }),
  tokenmax: Object.freeze({
    cache_enabled: true,
    cache_similarity_threshold: 0.92,
    cache_ttl_seconds: 3600,
    intentWeighting: true,
    tokenBudget: undefined,
    expansion: true,
    searchLimit: 50,
    // tokenmax is the high-cost-tolerant tier that already pays for LLM
    // expansion + 50-result payloads. Reranker is the natural capstone:
    // better ordering of a large candidate set is where rerankers earn
    // their fee. ~$0.0003/query at this shape; rounding error vs the
    // tier's $700/mo @ Opus pairing per CLAUDE.md cost matrix.
    reranker_enabled: true,
    reranker_model: 'zeroentropyai:zerank-2',
    // v0.42.3.0 D4: topNIn = searchLimit (50) so every returned result is
    // cross-encoder scored — closes the Codex #2 recall gap where autocut
    // would drop the deliberately-preserved un-reranked tail (results 31-50).
    // Was 30. Reranking 50 docs vs 30 is cheap vs the downstream LLM.
    reranker_top_n_in: 50,
    reranker_top_n_out: null,
    reranker_timeout_ms: 5000,
    // v0.35.6.0 — undefined for all three bundles; the per-corpus ablation
    // (TODOS.md) gates any default flip.
    floor_ratio: undefined,
    // T2 — title-phrase boost ON by default (correctness fix, cheap + gated).
    title_boost: 1.25,
    // v0.36 cross-modal defaults (same across all modes — opt-in)
    cross_modal_both_text_weight: 0.6,
    cross_modal_both_image_weight: 0.4,
    image_query_text_refinement_weight: 0.4,
    image_query_image_refinement_weight: 0.6,
    unified_multimodal: false,
    unified_multimodal_only: false,
    cross_modal_llm_intent: false,
    // v0.40.4 — graph signals ON for tokenmax (power-user tier). Same
    // rationale as balanced. The score-distribution probe collects data
    // for T-todo-2 magnitude calibration wave.
    graph_signals: true,
    // v0.40.3.0 contextual retrieval — per-chunk Haiku synopsis for tokenmax
    // (Anthropic's published method). One-time backfill cost ~$5-50 for a
    // 10K-page brain; documented in the post-upgrade cost prompt.
    contextual_retrieval: 'per_chunk_synopsis' as CRMode,
    contextual_retrieval_disabled: false,
    // v0.42.3.0 — autocut ON.
    autocut: true,
    // v0.43 — relational recall ON for tokenmax (max-recall tier).
    relationalRetrieval: true,
    relational_retrieval_depth: 2,
    autocut_jump: 0.2,
  }),
});

export const DEFAULT_SEARCH_MODE: SearchMode = 'balanced';

export function isSearchMode(x: unknown): x is SearchMode {
  return typeof x === 'string' && (SEARCH_MODES as ReadonlyArray<string>).includes(x);
}

/**
 * Per-key config overrides. Read at search-time from the `config` table.
 * Every field is optional; an undefined field means "fall through to the
 * mode bundle default."
 */
export interface SearchKeyOverrides {
  cache_enabled?: boolean;
  cache_similarity_threshold?: number;
  cache_ttl_seconds?: number;
  intentWeighting?: boolean;
  tokenBudget?: number;
  expansion?: boolean;
  searchLimit?: number;
  // v0.35.0.0+ reranker overrides
  reranker_enabled?: boolean;
  reranker_model?: string;
  reranker_top_n_in?: number;
  // CDX2-F16: null is the explicit "don't truncate" signal; undefined
  // means "fall through to mode bundle". Use number | null, not
  // number | undefined.
  reranker_top_n_out?: number | null;
  reranker_timeout_ms?: number;
  // v0.35.6.0 — floor-ratio gate override.
  floor_ratio?: number;
  // T2 — title-phrase boost override.
  title_boost?: number;
  // v0.36 cross-modal overrides
  cross_modal_both_text_weight?: number;
  cross_modal_both_image_weight?: number;
  image_query_text_refinement_weight?: number;
  image_query_image_refinement_weight?: number;
  unified_multimodal?: boolean;
  unified_multimodal_only?: boolean;
  cross_modal_llm_intent?: boolean;
  // v0.40.4 — graph_signals override (boolean).
  graph_signals?: boolean;
  // v0.40.3.0 contextual retrieval. CRMode override + soft kill switch.
  contextual_retrieval?: CRMode;
  contextual_retrieval_disabled?: boolean;
  // v0.42.3.0 — autocut overrides.
  autocut?: boolean;
  // v0.43 — relational recall overrides.
  relationalRetrieval?: boolean;
  relational_retrieval_depth?: number;
  autocut_jump?: number;
}

/**
 * Per-call opts that can override the bundle for this single search.
 * Same shape as ModeBundle but every field is optional. These are passed
 * through from `SearchOpts` / `HybridSearchOpts` so the existing per-call
 * surface continues to work — mode just provides the default that the
 * caller's explicit field overrides.
 */
export interface SearchPerCallOpts {
  cache_enabled?: boolean;
  cache_similarity_threshold?: number;
  cache_ttl_seconds?: number;
  intentWeighting?: boolean;
  tokenBudget?: number;
  expansion?: boolean;
  searchLimit?: number;
  // v0.35.0.0+ reranker per-call overrides (same shape as SearchKeyOverrides).
  reranker_enabled?: boolean;
  reranker_model?: string;
  reranker_top_n_in?: number;
  reranker_top_n_out?: number | null;
  reranker_timeout_ms?: number;
  // v0.35.6.0 — floor-ratio per-call override.
  floor_ratio?: number;
  // T2 — title-phrase boost per-call override.
  title_boost?: number;
  // v0.36 cross-modal per-call overrides
  cross_modal_both_text_weight?: number;
  cross_modal_both_image_weight?: number;
  image_query_text_refinement_weight?: number;
  image_query_image_refinement_weight?: number;
  unified_multimodal?: boolean;
  unified_multimodal_only?: boolean;
  cross_modal_llm_intent?: boolean;
  // v0.40.4 — graph_signals per-call override (boolean).
  graph_signals?: boolean;
  // v0.40.3.0 contextual retrieval per-call overrides.
  contextual_retrieval?: CRMode;
  contextual_retrieval_disabled?: boolean;
  // v0.42.3.0 — autocut per-call overrides. NOTE: the boolean per-call
  // autocut toggle from SearchOpts is handled at the hybrid.ts boundary
  // (it's an AutocutInput, not a plain bool here); autocut_jump is the
  // numeric per-call knob threaded through the bundle.
  autocut?: boolean;
  autocut_jump?: number;
  // v0.43 — relational recall per-call overrides.
  relationalRetrieval?: boolean;
  relational_retrieval_depth?: number;
}

/**
 * Resolve the active search knob set for one search call.
 *
 * Resolution chain (matches v0.31.12 model-tier semantics):
 *   1. perCallOpts.<key> if defined → wins
 *   2. config.search.<key> if defined → wins
 *   3. MODE_BUNDLES[config.search.mode].<key> → mode default
 *   4. MODE_BUNDLES.balanced.<key> → safety fallback when config.search.mode is invalid/unset
 *
 * Pure function: no DB calls, no env reads. Caller pre-loads the relevant
 * config rows (one SELECT for the whole batch of keys, not one per key).
 */
export interface ResolveSearchModeInput {
  /** Resolved value of `config.search.mode`. Undefined → fallback to balanced. */
  mode?: string;
  /** Resolved per-key overrides from config table. */
  overrides?: SearchKeyOverrides;
  /** Per-call opts (SearchOpts / HybridSearchOpts). */
  perCall?: SearchPerCallOpts;
}

export interface ResolvedSearchKnobs extends ModeBundle {
  /** Which mode bundle supplied the defaults (after fallback). */
  resolved_mode: SearchMode;
  /** True if the caller's `mode` input was a recognized SearchMode. */
  mode_valid: boolean;
}

export function resolveSearchMode(input: ResolveSearchModeInput): ResolvedSearchKnobs {
  const requested = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : '';
  const valid = isSearchMode(requested);
  const resolved_mode: SearchMode = valid ? (requested as SearchMode) : DEFAULT_SEARCH_MODE;
  const bundle = MODE_BUNDLES[resolved_mode];

  const ov = input.overrides ?? {};
  const pc = input.perCall ?? {};

  const pick = <K extends keyof ModeBundle>(key: K): ModeBundle[K] => {
    if (pc[key] !== undefined) return pc[key] as ModeBundle[K];
    if (ov[key] !== undefined) return ov[key] as ModeBundle[K];
    return bundle[key];
  };

  // v0.40.6.1: `reranker_timeout_ms` resolution slots the resolved recipe's
  // touchpoint default between override and bundle, so local rerankers
  // (llama.cpp serving Qwen3-Reranker / self-hosted ZE on CPU) inherit
  // their cold-start headroom without forcing users to discover the
  // `search.reranker.timeout_ms` config key.
  // Precedence: per-call > config override > recipe.touchpoints.reranker.default_timeout_ms > mode bundle.
  const resolvedRerankerModel = pick('reranker_model');
  const pickRerankerTimeoutMs = (): number => {
    if (pc.reranker_timeout_ms !== undefined) return pc.reranker_timeout_ms;
    if (ov.reranker_timeout_ms !== undefined) return ov.reranker_timeout_ms;
    const recipeDefault = lookupRerankerRecipeDefaultTimeout(resolvedRerankerModel);
    if (recipeDefault !== undefined) return recipeDefault;
    return bundle.reranker_timeout_ms;
  };

  return {
    cache_enabled: pick('cache_enabled'),
    cache_similarity_threshold: pick('cache_similarity_threshold'),
    cache_ttl_seconds: pick('cache_ttl_seconds'),
    intentWeighting: pick('intentWeighting'),
    tokenBudget: pick('tokenBudget'),
    expansion: pick('expansion'),
    searchLimit: pick('searchLimit'),
    reranker_enabled: pick('reranker_enabled'),
    reranker_model: resolvedRerankerModel,
    reranker_top_n_in: pick('reranker_top_n_in'),
    reranker_top_n_out: pick('reranker_top_n_out'),
    reranker_timeout_ms: pickRerankerTimeoutMs(),
    // v0.35.6.0 — floor-ratio resolved via the same pick chain.
    floor_ratio: pick('floor_ratio'),
    title_boost: pick('title_boost'),
    // v0.36 cross-modal knobs
    cross_modal_both_text_weight: pick('cross_modal_both_text_weight'),
    cross_modal_both_image_weight: pick('cross_modal_both_image_weight'),
    image_query_text_refinement_weight: pick('image_query_text_refinement_weight'),
    image_query_image_refinement_weight: pick('image_query_image_refinement_weight'),
    unified_multimodal: pick('unified_multimodal'),
    unified_multimodal_only: pick('unified_multimodal_only'),
    cross_modal_llm_intent: pick('cross_modal_llm_intent'),
    // v0.40.4
    graph_signals: pick('graph_signals'),
    // v0.40.3.0 contextual retrieval — resolved via the same pick chain.
    contextual_retrieval: pick('contextual_retrieval'),
    contextual_retrieval_disabled: pick('contextual_retrieval_disabled'),
    // v0.42.3.0 — autocut resolved via the same pick chain.
    autocut: pick('autocut'),
    autocut_jump: pick('autocut_jump'),
    // v0.43 — relational recall resolved via the same pick chain.
    relationalRetrieval: pick('relationalRetrieval'),
    relational_retrieval_depth: pick('relational_retrieval_depth'),
    resolved_mode,
    mode_valid: valid,
  };
}

/**
 * Per-knob source attribution for `gbrain search modes` dashboard.
 * Tells the user where each resolved value came from so override drift
 * is legible. Mirrors `gbrain models` (v0.31.12) attribution shape.
 */
export type KnobSource = 'per-call' | 'override' | 'mode' | 'fallback';

export interface ResolvedKnobAttribution {
  knob: keyof ModeBundle;
  value: ModeBundle[keyof ModeBundle];
  source: KnobSource;
  // For 'override' source, the config key path; for 'mode' source, the mode name.
  source_detail: string;
}

export function attributeKnob<K extends keyof ModeBundle>(
  knob: K,
  input: ResolveSearchModeInput,
  resolved: ResolvedSearchKnobs,
): ResolvedKnobAttribution {
  const pc = input.perCall ?? {};
  const ov = input.overrides ?? {};
  if (pc[knob] !== undefined) {
    return { knob, value: resolved[knob], source: 'per-call', source_detail: 'SearchOpts' };
  }
  if (ov[knob] !== undefined) {
    return { knob, value: resolved[knob], source: 'override', source_detail: `config: search.${knob}` };
  }
  if (resolved.mode_valid) {
    return { knob, value: resolved[knob], source: 'mode', source_detail: `mode: ${resolved.resolved_mode}` };
  }
  return { knob, value: resolved[knob], source: 'fallback', source_detail: `mode: ${DEFAULT_SEARCH_MODE} (default — search.mode unset)` };
}

/**
 * Stable hash of the resolved knob set. Used as part of the query_cache
 * primary key so a tokenmax cache write can't be served to a conservative
 * lookup (cross-mode contamination, [CDX-4]).
 *
 * Knob order is FIXED so the hash is deterministic across releases. NEVER
 * reorder or add a knob without bumping a constant — a hash collision would
 * mean stale cache rows silently reading the wrong shape.
 */
// v0.35.0.0+ bump 1→2: reranker fields participate in the cache key so a
// tokenmax-with-reranker write can't be served to a reranker-off lookup.
// v0.35.6.0   bump 2→3: floor_ratio participates so a floor-on write can't
// be served to a floor-off lookup (cross-floor contamination, codex T1).
// CDX2-F13 convention: under a version bump, additions are APPEND-ONLY at
// the end of `parts[]` — reordering existing fields would silently rebuild
// the hash for every existing row.
//
// CDX2-F12 mid-deploy duplicate-row note: because `cacheRowId()` (in
// src/core/search/query-cache.ts) includes knobsHash, a v=2 process and a
// v=3 process writing the same `(source_id, query_text)` produce DISTINCT
// row IDs. Expect a temporary hit-rate dip + cache-row doubling for hot
// queries during a rolling deploy. Clears naturally within
// `cache.ttl_seconds` (default 3600s). The CHANGELOG note covers this.
//
// v0.36 wave: cross-modal knobs ALSO participate in v=3 hash (D2 cache
// contamination fix — a text-mode cache hit cannot silently serve an
// image-mode caller). v0.35.6.0's floor_ratio bump and v0.36's cross-modal
// extensions both land under v=3, with cross-modal fields appended after
// the floor_ratio entry (CDX2-F13 append-only convention).
//
// v0.40.4 bump 3→4: graph_signals participates in the cache key. A
// graph-on write must NOT be served to a graph-off lookup (ranking
// shifts when adjacency / cross-source / session-demote stamps move
// results). v0.39 T21 (master) also added schema_pack identity fields
// under v=4.
//
// v0.40.3.0 bump 4→5: contextual_retrieval and contextual_retrieval_disabled
// added under v=5 (per D8 sequencing — first to land claimed v=4; the
// contextual-retrieval wave rebased to v=5). Mid-deploy hit-rate dip is
// expected — clears within cache.ttl_seconds (3600s default).
//
// v0.42 bump 5→6: alias_resolved_boost (T19, plan D6) adds a new post-fusion
// stage. Results whose slug is a canonical_slug in slug_aliases get a
// 1.05x multiplier. Cached pre-v0.42 entries don't reflect the boost so
// must invalidate. Same one-time miss-spike pattern as prior bumps;
// fills within cache.ttl_seconds (3600s default).
//
// T2 bump 6→7: title_boost (retrieval-maxpool incident) adds a post-fusion
// stage that multiplies title-phrase-matching results. A title-boost-on write
// must NOT be served to a title-boost-off lookup (ranking shifts). Same
// one-time miss-spike pattern; fills within cache.ttl_seconds.
//
// v0.42.3.0 bump 7→8: autocut (score-discontinuity result-sizing) adds `ac`
// + `acj` parts. Default-ON in reranked modes trims the returned set, so an
// autocut-on write must NOT be served to an autocut-off lookup. ONE-TIME
// global cache cold-miss on upgrade — EVERY query_cache row invalidates,
// including conservative/no-reranker calls where autocut is a no-op (the hash
// is global, not per-mode). Refills within cache.ttl_seconds (3600s default).
//
// bump 8→9 (issue #1777): `archive/` moved from DEFAULT_HARD_EXCLUDES to a 0.5
// source-boost demote. The source-boost / hard-exclude policy is NOT part of the
// knobs hash, so without a version bump cached rows would keep returning the old
// archive-excluded result set for up to cache.ttl_seconds. Bumping forces the fix
// to take effect immediately (one-time global cache cold-miss on upgrade; refills
// within cache.ttl_seconds). Same cache-key-contamination convention as the
// autocut / title_boost / graph_signals bumps above.
//
// bump 10→11 (#1400 input_type fix): asymmetric embedding models (zembed-1
// hosted or local, Voyage v3+) had their query-side input_type stripped by
// the AI SDK before the wire, so every cached row's key embedding AND result
// set were computed with document-side query vectors. The fix changes what
// embedQuery() produces for those providers; pre-fix rows must not be served
// to post-fix lookups. Same one-time global cold-miss pattern as the bumps
// above (the hash is global, not per-provider); refills within
// cache.ttl_seconds (3600s default).
export const KNOBS_HASH_VERSION = 11;

/**
 * v0.36 (D8 / CDX-2) — second-arg context for the cache key. The
 * embedding column + provider live OUTSIDE ResolvedSearchKnobs because
 * they're orthogonal to search mode (mode bundles don't pick columns).
 * Passing them as a second argument keeps ModeBundle pure and lets the
 * hash invalidate correctly across column/provider switches.
 *
 * When undefined, the hash falls back to the legacy 'embedding' /
 * 'default' values so unrelated callers (eval-replay, telemetry) that
 * don't know the column produce a stable hash for the default case.
 */
export interface KnobsHashContext {
  /** Resolved column name, e.g. 'embedding', 'embedding_voyage'. */
  embeddingColumn?: string;
  /** Resolved provider:model, e.g. 'voyage:voyage-3-large'. */
  embeddingModel?: string;
  /**
   * v0.39 T21 + codex finding #5: cache + eval pack isolation. A cache
   * row written when pack `garry-pack@1.2` was active must NEVER be
   * served when pack `research-state@0.5` is active — they may resolve
   * different type closures for the same query. The hash folds in
   * pack name + version so cross-pack contamination is structurally
   * impossible. Undefined falls back to the literal 'none' for
   * backward compat with callers that don't yet thread pack identity.
   */
  schemaPack?: string;
  schemaPackVersion?: string;
}

export function knobsHash(
  knobs: ResolvedSearchKnobs,
  ctx?: KnobsHashContext,
): string {
  // Fixed-order key list. Adding a knob here REQUIRES bumping
  // KNOBS_HASH_VERSION and is a breaking change for any persisted cache.
  const parts = [
    `v=${KNOBS_HASH_VERSION}`,
    `mode=${knobs.resolved_mode}`,
    `cache=${knobs.cache_enabled ? 1 : 0}`,
    `sim=${knobs.cache_similarity_threshold.toFixed(4)}`,
    `ttl=${knobs.cache_ttl_seconds}`,
    `iw=${knobs.intentWeighting ? 1 : 0}`,
    `tb=${knobs.tokenBudget ?? 'none'}`,
    `exp=${knobs.expansion ? 1 : 0}`,
    `lim=${knobs.searchLimit}`,
    // v=2 additions (append-only).
    `rr=${knobs.reranker_enabled ? 1 : 0}`,
    `rrm=${knobs.reranker_model}`,
    `rri=${knobs.reranker_top_n_in}`,
    `rro=${knobs.reranker_top_n_out ?? 'none'}`,
    `rrt=${knobs.reranker_timeout_ms}`,
    // v=3 additions (append-only). Both contributions landed under v=3:
    //
    //   floor_ratio (v0.35.6.0 / codex T1): a floor-on write must not be
    //     served to a floor-off lookup. 4-decimal precision so 0.85 and
    //     0.851 produce different hashes; undefined uses literal 'none'.
    //
    //   col + prov (v0.36 / D8 / CDX-2): cross-column + cross-provider
    //     cache contamination. A query against `embedding_voyage` must
    //     NEVER be served from a cache row that ran against `embedding`
    //     — they sit in different vector spaces. ctx is optional so
    //     unrelated callers fall back to the default-column hash.
    `fr=${knobs.floor_ratio === undefined ? 'none' : knobs.floor_ratio.toFixed(4)}`,
    // v=3 cross-modal additions (append-only).
    `cmbt=${knobs.cross_modal_both_text_weight.toFixed(2)}`,
    `cmbi=${knobs.cross_modal_both_image_weight.toFixed(2)}`,
    `iqt=${knobs.image_query_text_refinement_weight.toFixed(2)}`,
    `iqi=${knobs.image_query_image_refinement_weight.toFixed(2)}`,
    `um=${knobs.unified_multimodal ? 1 : 0}`,
    `umo=${knobs.unified_multimodal_only ? 1 : 0}`,
    `lli=${knobs.cross_modal_llm_intent ? 1 : 0}`,
    // v=3 column + provider additions (D8 / CDX-2): cross-column +
    // cross-provider cache isolation. A query against `embedding_voyage`
    // must never be served from a row that ran against `embedding`.
    `col=${ctx?.embeddingColumn ?? 'embedding'}`,
    `prov=${ctx?.embeddingModel ?? 'default'}`,
    // v=4 additions (append-only).
    //   graph_signals (v0.40.4): graph-on write must not be served to a
    //     graph-off lookup.
    //   schema-pack name + version (v0.39 T21 / codex #5): cross-pack
    //     contamination is structurally impossible — a query that
    //     resolved type `researcher` against pack A cannot be served
    //     from a row that resolved against pack B.
    `gs=${knobs.graph_signals ? 1 : 0}`,
    `pack=${ctx?.schemaPack ?? 'none'}`,
    `pver=${ctx?.schemaPackVersion ?? 'none'}`,
    // v=5 contextual retrieval additions (v0.40.3.0, per D8 sequencing
    // behind salem's pending v=4 graph signals). A query against a brain
    // on tokenmax (per-chunk synopsis) must NEVER be served from a cache
    // row written when the brain was on balanced (title-only) — different
    // embedding spaces. Soft kill switch participates too so flipping it
    // neutralizes prior cache rows.
    `cr=${knobs.contextual_retrieval}`,
    `crd=${knobs.contextual_retrieval_disabled ? 1 : 0}`,
    // v=7 addition (append-only) — T2 title-phrase boost (retrieval-maxpool).
    `tib=${knobs.title_boost === undefined ? 'none' : knobs.title_boost.toFixed(4)}`,
    // v=8 additions (v0.42.3.0, append-only): autocut. An autocut-on write
    // (trimmed result set) must not be served to an autocut-off lookup, and a
    // sensitivity change (jumpRatio) shifts where the cut lands. Conservative
    // (autocut off) hashes differently from balanced/tokenmax (autocut on),
    // which is correct — the result sets differ.
    `ac=${knobs.autocut ? 1 : 0}`,
    // `?? 0.2` mirrors the module's defensive read of other knobs (graph_signals
    // etc.) so a partial-knobs caller (tests passing a minimal literal) can't
    // crash the hash. Typed callers always carry the field.
    `acj=${(knobs.autocut_jump ?? 0.2).toFixed(2)}`,
    // v=10 additions (v0.43, append-only): relational recall arm. A
    // relational-on write (edge-seeded result set) must NOT be served to a
    // relational-off lookup — same contamination class as graph_signals. The
    // depth changes the candidate set too, so it folds in as well. ONE-TIME
    // cold-miss on upgrade as v=9 rows become unreachable; pinned by
    // test/model-pricing.test.ts-style drift guards and the mode tests.
    `rel=${knobs.relationalRetrieval ? 1 : 0}`,
    `reld=${knobs.relational_retrieval_depth ?? 2}`,
  ];
  const h = createHash('sha256');
  h.update(parts.join('|'));
  return h.digest('hex').slice(0, 16);
}

/**
 * Convenience: build SearchKeyOverrides from a flat config-table snapshot.
 * Used by hybridSearch's hot path so the search code pays one round-trip
 * to load all relevant config keys rather than one per knob.
 *
 * Returns sparse overrides — only keys actually present in the config
 * map appear. Falsy/missing keys fall through to the mode bundle default.
 */
export function loadOverridesFromConfig(
  configMap: Record<string, string | undefined>,
): SearchKeyOverrides {
  const out: SearchKeyOverrides = {};
  const get = (k: string): string | undefined => configMap[k];

  const ce = get('search.cache.enabled');
  if (ce !== undefined) {
    out.cache_enabled = ce === '1' || ce.toLowerCase() === 'true';
  }
  const st = get('search.cache.similarity_threshold');
  if (st !== undefined) {
    const n = parseFloat(st);
    if (Number.isFinite(n) && n > 0 && n <= 1) out.cache_similarity_threshold = n;
  }
  const tt = get('search.cache.ttl_seconds');
  if (tt !== undefined) {
    const n = parseInt(tt, 10);
    if (Number.isFinite(n) && n > 0) out.cache_ttl_seconds = n;
  }
  const iw = get('search.intentWeighting');
  if (iw !== undefined) {
    out.intentWeighting = iw === '1' || iw.toLowerCase() === 'true';
  }
  const tb = get('search.tokenBudget');
  if (tb !== undefined) {
    const n = parseInt(tb, 10);
    if (Number.isFinite(n) && n > 0) out.tokenBudget = n;
  }
  const ex = get('search.expansion');
  if (ex !== undefined) {
    out.expansion = ex === '1' || ex.toLowerCase() === 'true';
  }
  const sl = get('search.searchLimit');
  if (sl !== undefined) {
    const n = parseInt(sl, 10);
    if (Number.isFinite(n) && n > 0) out.searchLimit = n;
  }

  // v0.35.0.0+ reranker overrides
  const re = get('search.reranker.enabled');
  if (re !== undefined) {
    out.reranker_enabled = re === '1' || re.toLowerCase() === 'true';
  }
  const rm = get('search.reranker.model');
  if (rm !== undefined && rm.trim().length > 0) {
    out.reranker_model = rm.trim();
  }
  const ri = get('search.reranker.top_n_in');
  if (ri !== undefined) {
    const n = parseInt(ri, 10);
    if (Number.isFinite(n) && n > 0) out.reranker_top_n_in = n;
  }
  // CDX2-F15 null parsing: top_n_out distinguishes three input shapes:
  //   key absent → undefined → fall through to mode bundle
  //   'null' / 'none' / '' → explicit null (no truncate)
  //   positive integer → that number
  const ro = get('search.reranker.top_n_out');
  if (ro !== undefined) {
    const trimmed = ro.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'null' || trimmed === 'none') {
      out.reranker_top_n_out = null;
    } else {
      const n = parseInt(trimmed, 10);
      if (Number.isFinite(n) && n > 0) out.reranker_top_n_out = n;
    }
  }
  const rt = get('search.reranker.timeout_ms');
  if (rt !== undefined) {
    const n = parseInt(rt, 10);
    if (Number.isFinite(n) && n > 0) out.reranker_timeout_ms = n;
  }

  // v0.35.6.0 — floor-ratio config key. Accepts a number in [0, 1]; values
  // outside that range silently fall through (no override applied). The
  // runtime computeFloorThreshold also guards against out-of-range so a
  // malformed value never gates anything — defense in depth.
  const fr = get('search.floor_ratio');
  if (fr !== undefined) {
    const n = parseFloat(fr);
    if (Number.isFinite(n) && n >= 0 && n <= 1) out.floor_ratio = n;
  }

  // T2 — title-phrase boost factor. >= 1.0 (1.0 disables). Bounded sanity cap
  // at 5.0 so a fat-fingered config can't make a title hit dominate everything.
  const tib = get('search.title_boost');
  if (tib !== undefined) {
    const n = parseFloat(tib);
    if (Number.isFinite(n) && n >= 1.0 && n <= 5.0) out.title_boost = n;
  }

  // v0.36 cross-modal overrides (D3 registry)
  const cmbt = get('search.cross_modal.both_mode_text_weight');
  if (cmbt !== undefined) {
    const n = parseFloat(cmbt);
    if (Number.isFinite(n) && n >= 0) out.cross_modal_both_text_weight = n;
  }
  const cmbi = get('search.cross_modal.both_mode_image_weight');
  if (cmbi !== undefined) {
    const n = parseFloat(cmbi);
    if (Number.isFinite(n) && n >= 0) out.cross_modal_both_image_weight = n;
  }
  const iqt = get('search.image_query.text_refinement_weight');
  if (iqt !== undefined) {
    const n = parseFloat(iqt);
    if (Number.isFinite(n) && n >= 0) out.image_query_text_refinement_weight = n;
  }
  const iqi = get('search.image_query.image_refinement_weight');
  if (iqi !== undefined) {
    const n = parseFloat(iqi);
    if (Number.isFinite(n) && n >= 0) out.image_query_image_refinement_weight = n;
  }
  const um = get('search.unified_multimodal');
  if (um !== undefined) {
    out.unified_multimodal = um === '1' || um.toLowerCase() === 'true';
  }
  const umo = get('search.unified_multimodal_only');
  if (umo !== undefined) {
    out.unified_multimodal_only = umo === '1' || umo.toLowerCase() === 'true';
  }
  const lli = get('search.cross_modal.llm_intent');
  if (lli !== undefined) {
    out.cross_modal_llm_intent = lli === '1' || lli.toLowerCase() === 'true';
  }
  // v0.40.3.0 contextual retrieval. tier override + soft kill switch.
  const cr = get('search.contextual_retrieval');
  if (cr !== undefined && (CR_MODES as readonly string[]).includes(cr.trim().toLowerCase())) {
    out.contextual_retrieval = cr.trim().toLowerCase() as CRMode;
  }
  const crd = get('search.contextual_retrieval_disabled');
  if (crd !== undefined) {
    out.contextual_retrieval_disabled = crd === '1' || crd.toLowerCase() === 'true';
  }

  // v0.40.4 — graph_signals
  const gs = get('search.graph_signals');
  if (gs !== undefined) {
    out.graph_signals = gs === '1' || gs.toLowerCase() === 'true';
  }

  // v0.42.3.0 — autocut. `search.autocut` is the master toggle (the ceiling
  // override agents use to force the full top-K); `search.autocut_jump` tunes
  // sensitivity (clamped to (0, 1] — out-of-range falls through to the bundle).
  const ac = get('search.autocut');
  if (ac !== undefined) {
    out.autocut = ac === '1' || ac.toLowerCase() === 'true';
  }
  const acj = get('search.autocut_jump');
  if (acj !== undefined) {
    const n = parseFloat(acj);
    if (Number.isFinite(n) && n > 0 && n <= 1) out.autocut_jump = n;
  }

  // v0.43 — relational recall arm.
  const rel = get('search.relational_retrieval');
  if (rel !== undefined) {
    out.relationalRetrieval = rel === '1' || rel.toLowerCase() === 'true';
  }
  const reld = get('search.relational_retrieval_depth');
  if (reld !== undefined) {
    const n = parseInt(reld, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 3) out.relational_retrieval_depth = n;
  }

  return out;
}

/** The full list of config keys this module reads. Used by `gbrain search modes --reset`. */
export const SEARCH_MODE_CONFIG_KEYS: ReadonlyArray<string> = Object.freeze([
  'search.cache.enabled',
  'search.cache.similarity_threshold',
  'search.cache.ttl_seconds',
  'search.intentWeighting',
  'search.tokenBudget',
  'search.expansion',
  'search.searchLimit',
  // v0.35.0.0+ reranker keys
  'search.reranker.enabled',
  'search.reranker.model',
  'search.reranker.top_n_in',
  'search.reranker.top_n_out',
  'search.reranker.timeout_ms',
  // v0.35.6.0 — floor-ratio gate
  'search.floor_ratio',
  'search.title_boost',
  // v0.36 cross-modal keys (D3)
  'search.cross_modal.both_mode_text_weight',
  'search.cross_modal.both_mode_image_weight',
  'search.image_query.text_refinement_weight',
  'search.image_query.image_refinement_weight',
  'search.unified_multimodal',
  'search.unified_multimodal_only',
  'search.cross_modal.llm_intent',
  // v0.40.4 graph signals
  'search.graph_signals',
  // v0.40.3.0 contextual retrieval — tier override + soft kill switch.
  // Per-mode default lives in the bundle; this key lets power users
  // override at the per-key level without flipping the global mode.
  'search.contextual_retrieval',
  'search.contextual_retrieval_disabled',
  // v0.42.3.0 autocut
  'search.autocut',
  // v0.43 relational recall
  'search.relational_retrieval',
  'search.relational_retrieval_depth',
  'search.autocut_jump',
]);

/**
 * The mode-selection config key itself. Separated from SEARCH_MODE_CONFIG_KEYS
 * because `--reset` clears OVERRIDES (the per-knob keys) but should NOT clear
 * the operator's mode choice.
 */
export const SEARCH_MODE_KEY = 'search.mode';

/**
 * Load the live mode config (mode + per-key overrides) from the brain engine.
 * Runs ONE round-trip per knob currently — the BrainEngine.getConfig interface
 * is single-key. A future v0.34 batch loader can collapse this. Volume is
 * small (~8 keys); call site is once per search.
 *
 * Errors are swallowed and fall through to mode-bundle defaults. The cache
 * config table predates v0.32.3 and may not exist on very old brains, so
 * silent fallback is the right shape.
 */
export async function loadSearchModeConfig(
  engine: { getConfig(key: string): Promise<string | null> },
): Promise<ResolveSearchModeInput> {
  const safeGet = async (k: string): Promise<string | undefined> => {
    try {
      const v = await engine.getConfig(k);
      // getConfig's contract is string | null, but guard against engines that
      // return non-string junk (e.g. arrays/booleans). A non-string value is
      // treated as "not set" so it falls through to the mode-bundle default,
      // matching the behavior of a missing key. Without this, downstream
      // parsing (e.g. ce.toLowerCase()) crashes on a non-string.
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  };

  const [mode, ...overrideValues] = await Promise.all([
    safeGet(SEARCH_MODE_KEY),
    ...SEARCH_MODE_CONFIG_KEYS.map(safeGet),
  ]);

  const configMap: Record<string, string | undefined> = {};
  SEARCH_MODE_CONFIG_KEYS.forEach((key, i) => {
    if (overrideValues[i] !== undefined) configMap[key] = overrideValues[i];
  });

  return {
    mode,
    overrides: loadOverridesFromConfig(configMap),
  };
}

