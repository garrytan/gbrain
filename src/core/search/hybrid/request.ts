/**
 * hybridSearch pipeline stages (refactor wave 1, W4 hybrid): request resolution, identity boosts and meta emission.
 * Each stage reads the resolved request (HybridRequest, request.ts) and
 * writes its per-request accumulators only as `req.<field>`.
 */
import { type BrainEngine, MAX_SEARCH_LIMIT } from '../../engine.ts';
import type { DegradedStageEntry, HybridSearchMeta, SearchOpts, SearchResult } from '../../types.ts';
import { type GBrainConfig, loadConfigWithEngine } from '../../config.ts';
import { type HybridSearchOpts, PRE_FUSION_POOL_FLOOR, compiledTruthFusionBoost } from '../hybrid.ts';
import type { IdentityTierOpts } from '../alias-hop.ts';
import { type IntentWeights, applyAliasMentionBoost, applyExactMatchBoost, applyTitleMentionBoost, weightsForIntent } from '../intent-weights.ts';
import { type QuerySuggestions, classifyQueryWithBrainPatterns } from '../query-intent.ts';
import type { ResolveSearchModeInput, ResolvedSearchKnobs } from '../mode.ts';
import { normalizeExpansionVariantBudget } from '../fusion-lists.ts';
import { normalizeKeywordArmConfidenceFloor } from '../arm-confidence.ts';
import { normalizeMetadataBoostGate } from '../metadata-boost-gate.ts';
import { normalizeRelationalRerankPin } from '../relational-rerank-pin.ts';
import { parseRelationalQuery } from '../relational-intent.ts';
import { pushDegraded } from './degraded.ts';
import { recordSearchTelemetry } from '../telemetry.ts';
import { resolveBoostMap, resolveHardExcludes } from '../source-boost.ts';
import { resolveEmbeddingColumn } from '../embedding-column.ts';
import { resolveSearchDateBounds } from '../date-bounds.ts';

/**
 * Everything the stages read, resolved once at hybridSearch entry, plus the
 * per-request accumulators they write (vectorPoolUnderfill, expansionApplied,
 * lastResultsCount, lastRank1Score — read by emitHybridMeta at each return).
 */
export interface HybridRequest {
  engine: BrainEngine;
  query: string;
  opts: HybridSearchOpts | undefined;
  modeInput: ResolveSearchModeInput;
  resolvedMode: ResolvedSearchKnobs;
  cfgForColumn: GBrainConfig | null;
  resolvedCol: ReturnType<typeof resolveEmbeddingColumn>;
  limit: number;
  offset: number;
  suggestions: QuerySuggestions;
  intentWeightingOn: boolean;
  intentWeights: IntentWeights;
  detail: HybridSearchOpts['detail'];
  detailResolved: 'low' | 'medium' | 'high' | null;
  ctBoost: boolean | number;
  searchOpts: SearchOpts;
  identityTierOpts: IdentityTierOpts;
  aliasHopOpts: IdentityTierOpts & { tokenHop: boolean };
  /** WP2/T3 degradation stamp, appended by every stage. */
  degraded: DegradedStageEntry[];
  /** v0.46.15: max-escalations searchVector exhaustion event, accumulated across vector calls. */
  vectorPoolUnderfill: HybridSearchMeta['vector_pool_underfilled'];
  /** v0.25.0: whether query expansion actually produced variants (onMeta). */
  expansionApplied: boolean;
  /** Telemetry counters set at each return path before emitHybridMeta. */
  lastResultsCount: number;
  /** T7 — rank-1 base_score for the telemetry drift signal; undefined when there are no results. */
  lastRank1Score: number | undefined;
}

const DEBUG = process.env.GBRAIN_SEARCH_DEBUG === '1';

export async function resolveHybridRequest(
  engine: BrainEngine,
  query: string,
  opts: HybridSearchOpts | undefined,
): Promise<HybridRequest> {
  // v0.32.3 search-lite mode: resolve the active mode + per-key overrides
  // once at entry. Mode supplies DEFAULTS for intentWeighting, tokenBudget,
  // expansion, and searchLimit when the caller leaves those undefined.
  // Per-call opts and per-key config overrides still win.
  //
  // This MUST live in bare hybridSearch (NOT just in hybridSearchCached)
  // because eval-replay and eval-longmemeval call bare hybridSearch — and
  // per-mode evals would not test production search if modes lived only in
  // the wrapper. See `[CDX-5+6]` in the plan.
  // (#4359) hybridSearchCached threads its already-loaded snapshot; reuse it.
  const { loadSearchModeConfig, resolveSearchMode } = await import('../mode.ts');
  const modeInput = opts?._searchModeInput ?? await loadSearchModeConfig(engine);
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
      // ranker wave — expansion variant budget per-call thread-through (eval
      // budget sweeps); `null` pins legacy weighting, undefined → config/bundle.
      // Normalized through the ONE range contract (fusion-lists.ts): 0 /
      // negative / >4 / NaN per-call values become undefined (fall through)
      // instead of reaching fusion — and the cache key — unvalidated.
      expansion_variant_budget: normalizeExpansionVariantBudget(opts?.expansionVariantBudget),
      // Ranker wave (R1) — relational rerank pin per-call thread-through (eval
      // A/B); normalized through the ONE range contract (relational-rerank-pin.ts).
      relational_rerank_pin: normalizeRelationalRerankPin(opts?.relationalRerankPin),
      // Ranker wave (Phase E2) — keyword-arm confidence floor per-call thread-through.
      keyword_arm_confidence_floor: normalizeKeywordArmConfidenceFloor(opts?.keywordArmConfidenceFloor),
      // Ranker wave (Phase E3) — metadata boost gate per-call thread-through (eval A/B).
      metadata_boost_gate: normalizeMetadataBoostGate(opts?.metadataBoostGate),
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
  const cfgForColumn = mergedCfg ?? ((await import('../../config.ts')).loadConfig()) ?? null;
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
  const ctBoost = compiledTruthFusionBoost(detail, opts?.detail);
  const searchOpts: SearchOpts = {
    limit: innerLimit,
    // Only an EXPLICIT `low` hard-filters to compiled truth in SQL; an
    // auto-detected one is the soft tilt in `ctBoost`.
    detail: detail === 'low' && opts?.detail !== 'low' ? undefined : detail,
    // v0.20.0 Cathedral II Layer 10 — thread language + symbolKind through so
    // per-engine searchKeyword / searchVector apply the filters at SQL level.
    language: opts?.language,
    symbolKind: opts?.symbolKind,
    // v0.33: multi-type filter for whoknows ('person','company'). Pushes
    // type filter to SQL level so the limit budget goes to candidate-typed
    // pages instead of being eaten by note/transcript/article pages.
    types: opts?.types,
    // Exact-slug and prefix exclusions are caller contract too (grade-takes
    // passes exclude_slugs; SDK callers pass prefix excludes); dropping them
    // here silently ignored them on every arm.
    exclude_slugs: opts?.exclude_slugs,
    exclude_slug_prefixes: opts?.exclude_slug_prefixes,
    include_slug_prefixes: opts?.include_slug_prefixes,
    // Per-brain `search.source_boosts` (read in the mode snapshot) over the
    // defaults; the env override still wins inside resolveBoostMap.
    source_boosts: resolveBoostMap(undefined, modeInput.sourceBoosts),
    // v0.29.1: since/until take precedence over deprecated afterDate/beforeDate.
    // The engine still consumes the legacy field names; this aliasing keeps
    // PR #618 callers compiling while the new names are the public surface.
    // #3442: resolveDateBoundary implements the documented contract (relative
    // durations + end-of-day for plain-date `until`) at this single seam.
    ...resolveSearchDateBounds(opts),
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
    requireSafeChunks: opts?.requireSafeChunks,
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
      if (!m.underfilled) return;
      pushDegraded(degraded, 'vector_candidates_incomplete', m.reason === 'deadline' ? 'timeout' : m.reason ?? 'candidate_budget');
      if (!req.vectorPoolUnderfill || m.escalations >= req.vectorPoolUnderfill.escalations) {
        const { underfilled, ...detail } = m;
        req.vectorPoolUnderfill = { ...detail, incomplete: true };
      }
    },
  };
  // Post-arm identity injections re-apply the arms' exclude contract.
  const identityTierOpts: IdentityTierOpts = {
    sourceId: opts?.sourceId,
    sourceIds: opts?.sourceIds,
    excludePrivate: opts?.excludePrivate,
    requireSafeChunks: opts?.requireSafeChunks,
    excludeSlugs: opts?.exclude_slugs,
    excludeSlugPrefixes: resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes),
  };
  const aliasHopOpts = {
    ...identityTierOpts,
    tokenHop: opts?.aliasTokenHop ?? modeInput.aliasTokenHop === 'true',
  };
  // WP2/T3 — degradation stamp accumulated across stages. Emitted on EVERY
  // return path (empty array = clean run) so cache rows always carry the
  // stamp and a served row can prove its cleanliness (ENG-5/cache_prestamp).
  const degraded: DegradedStageEntry[] = [];
  if (DEBUG && detail) {
    console.error(`[search-debug] auto-detail=${detail} for query="${query}"`);
  }

  const req: HybridRequest = {
    engine, query, opts, modeInput, resolvedMode, cfgForColumn, resolvedCol, limit, offset,
    suggestions, intentWeightingOn, intentWeights, detail, detailResolved, ctBoost,
    searchOpts, identityTierOpts, aliasHopOpts, degraded,
    vectorPoolUnderfill: undefined,
    expansionApplied: false,
    lastResultsCount: 0,
    lastRank1Score: undefined,
  };
  return req;
}

  // Intent identity boosts (exact/mentioned title or slug, mentioned alias),
  // shared by the fused path and both keyword-only paths. Caller re-sorts.
export async function applyIdentityBoosts(req: HybridRequest, list: SearchResult[]): Promise<void> {
  const { engine, query, opts, suggestions, intentWeightingOn, intentWeights } = req;
  if (intentWeights.exactMatchBoost === 1.0) {
    // #4694: general and temporal questions still honor a multi-token
    // title that is the query's subject. Not concept intent (Cat 13: a
    // lexical title decoy is exactly what paraphrase probes must not
    // reward) and not a relational question ("who invested in <title>"),
    // whose answer is the pages linked to that title, not the title page.
    if (intentWeightingOn && suggestions.intent !== 'concept' && parseRelationalQuery(query) === null) {
      applyTitleMentionBoost(list, query);
    }
    return;
  }
  applyExactMatchBoost(list, query, intentWeights);
  await applyAliasMentionBoost(list, query, intentWeights, (aliases) => engine.resolveAliases(aliases, {
    sourceId: opts?.sourceId, sourceIds: opts?.sourceIds, excludePrivate: opts?.excludePrivate,
  }));
}

  // A throwing user callback must never break the search hot path — onMeta
  // is a public surface (gbrain/search/hybrid) so a third-party closure bug
  // shouldn't take down query/search responses.
  //
  // v0.32.3 search-lite: every emitMeta call ALSO records to the in-process
  // search_telemetry rollup. Telemetry write is sync (bumps a bucket map),
  // flush is fire-and-forget on 60s / 100-call thresholds. The hot path
  // never waits.
export function emitHybridMeta(req: HybridRequest, meta: HybridSearchMeta): void {
  const { engine, opts } = req;
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
    recordSearchTelemetry(engine, recordedMeta, { results_count: req.lastResultsCount, rank1_score: req.lastRank1Score });
  } catch {
    // swallow — telemetry must never break the search hot path.
  }
}
