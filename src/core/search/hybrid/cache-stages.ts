/**
 * hybridSearchCached stages (refactor wave 1, W4 hybrid): mode resolution for
 * the cache key, the semantic-cache handle, the skip gate and the hit path.
 * The semantic result cache stays hard-disabled (semanticResultCacheAvailable
 * returns false), so on the production path only resolveCacheSearchMode and
 * semanticCacheSkipped run.
 */
import type { BrainEngine } from '../../engine.ts';
import type { HybridSearchMeta, SearchResult } from '../../types.ts';
import { type HybridSearchOpts, cacheScopeKey, filterResultsByCallerScope } from '../hybrid.ts';
import type { knobsHash as KnobsHashFn, ResolvedSearchKnobs } from '../mode.ts';
import { SemanticQueryCache, loadCacheConfig } from '../query-cache.ts';
import { adaptiveReturnFromConfig, resolveAdaptiveReturn } from '../return-policy.ts';
import { classifyQuery, loadEngineIntentPatterns } from '../query-intent.ts';
import { enforceTokenBudget } from '../token-budget.ts';
import { isCacheSafe, resolveEmbeddingColumn } from '../embedding-column.ts';
import { loadConfigWithEngine } from '../../config.ts';
import { normalizeExpansionVariantBudget } from '../fusion-lists.ts';
import { normalizeKeywordArmConfidenceFloor } from '../arm-confidence.ts';
import { normalizeMetadataBoostGate } from '../metadata-boost-gate.ts';
import { normalizeRelationalRerankPin } from '../relational-rerank-pin.ts';
import { recordSearchTelemetry } from '../telemetry.ts';
import { resolveEffectiveRecency, resolveEffectiveSalience } from './effective-modes.ts';
import { resolveHardExcludes } from '../source-boost.ts';

/** What prepareSemanticCache hands the wrapper when result caching is available. */
export interface SemanticCacheHandle {
  cache: SemanticQueryCache;
  cacheKnobsHash: string;
  isNonDefaultColumn: boolean;
  providerProbe: string | undefined;
}

export async function resolveCacheSearchMode(engine: BrainEngine, opts: HybridSearchOpts | undefined) {
  // v0.32.3 search-lite mode: resolve mode + per-key overrides once. The
  // resolved knob set drives cache enable/threshold/TTL AND the knobs_hash
  // that scopes the cache row so a tokenmax write can't be served to a
  // conservative read. See [CDX-4] in the plan.
  const { loadSearchModeConfig, resolveSearchMode, knobsHash } = await import('../mode.ts');
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
      // ranker wave — threaded here too so knobsHash's `evb=` part reflects
      // the per-call budget (a 0.5 write must never serve a legacy read).
      // Same normalizer as the inner search so both resolutions agree
      // (an invalid per-call value must hash as legacy, never as `evb=NaN`).
      expansion_variant_budget: normalizeExpansionVariantBudget(opts?.expansionVariantBudget),
      // Ranker wave — threaded here too so knobsHash's `rrp=` part reflects the per-call pin.
      relational_rerank_pin: normalizeRelationalRerankPin(opts?.relationalRerankPin),
      // Ranker wave (Phase E2) — threaded here too so knobsHash's `kacf=` part reflects the per-call floor.
      keyword_arm_confidence_floor: normalizeKeywordArmConfidenceFloor(opts?.keywordArmConfidenceFloor),
      // Ranker wave (Phase E3) — threaded here too so knobsHash's `mbg=` part reflects the per-call gate.
      metadata_boost_gate: normalizeMetadataBoostGate(opts?.metadataBoostGate),
    },
  });
  return { modeInputForCache, resolvedForCache, knobsHash };
}

/** Cache key + SemanticQueryCache for this request (only built when result caching is available). */
export async function prepareSemanticCache(
  engine: BrainEngine,
  query: string,
  opts: HybridSearchOpts | undefined,
  resolvedForCache: ResolvedSearchKnobs,
  knobsHash: typeof KnobsHashFn,
): Promise<SemanticCacheHandle> {
  const mergedCfgCached = await loadConfigWithEngine(engine).catch(() => null);
  const cfgCached = mergedCfgCached ?? ((await import('../../config.ts')).loadConfig()) ?? { engine: 'pglite' as const };
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

  // 2026-08 fix wave (E5b): resolve the adaptive-return gate ONCE for both
  // the cache key and the (former) skip decision. Adaptive-on calls now
  // cache — the gate params + the query's resolved intent class fold into
  // knobsHash (v=27) so gate-off/-on and cross-intent rows never cross-serve.
  // Known-narrow residual (adversarial review, 2026-09): bare hybridSearch
  // re-classifies intent for the applied trim, so a `search.intent_patterns`
  // write (or bank-TTL expiry) landing BETWEEN the two loads can store a set
  // trimmed under intent X beneath a key claiming intent Y for up to
  // ttl_seconds — same class as the documented #4356 double-resolution
  // caveat: cache-only, self-healing, accepted.
  const adaptiveResolvedForCache = resolveAdaptiveReturn(
    opts?.adaptiveReturn,
    adaptiveReturnFromConfig(cfgCached as unknown as Record<string, unknown> | null),
  );

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
    // Retained storage-key shape; semantic response reuse is disabled below.
    excludePrivate: opts?.excludePrivate === true,
    // v=27 (E5b) — the resolved gate + this query's intent class, classified
    // by the SAME pattern-aware banks bare hybridSearch resolves (above).
    adaptiveReturn: {
      enabled: adaptiveResolvedForCache.enabled,
      entityMax: adaptiveResolvedForCache.entityMax,
      otherMax: adaptiveResolvedForCache.otherMax,
      minKeep: adaptiveResolvedForCache.minKeep,
      intent: cacheSuggestions.intent,
    },
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
  return { cache, cacheKnobsHash, isNonDefaultColumn, providerProbe: resolvedColCached.embeddingModel || undefined };
}

export function semanticCacheSkipped(opts: HybridSearchOpts | undefined, semanticCache: SemanticCacheHandle | null): boolean {
  // Skip cache entirely when the request asks for two-pass walks, has
  // a non-default embedding column (per-call or via config default —
  // D8 closes the silent-corruption bug class), or near-symbol mode
  // (structural state that the cache can't safely express).
  // 2026-08 fix wave (E5b): adaptive-on no longer skips — the gate params +
  // intent class are folded into knobsHash (v=27) above, so adaptive-on
  // calls cache safely within same-config same-intent matches.
  // Per-call dedupOpts DOES skip (CEO review D8 adjunct): it is
  // result-affecting (maxPerPage/cosine/type-ratio overrides) but not part
  // of the hash — a maxPerPage:1 caller must never be served a stored
  // maxPerPage:2 page (and vice versa). Fold-into-hash is only warranted if
  // a config-plane dedup key ships later.
  // #3442: date-filtered requests skip the cache — since/until are not part
  // of knobsHash, so a filtered result set could be served to an unfiltered
  // lookup (and vice versa). Relative forms ('60d') also resolve to a
  // now-relative timestamp, which a persisted cache row can't express.
  const dateFiltered =
    Boolean(opts?.since ?? opts?.afterDate) || Boolean(opts?.until ?? opts?.beforeDate);
  // #3985: type-filtered requests skip the cache — `types` is not part of
  // knobsHash, so a filtered result set could be served to an unfiltered
  // lookup (and vice versa). Mirrors the #3442 date-filter bypass.
  const typeFiltered = Boolean(opts?.type) || (opts?.types?.length ?? 0) > 0;
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
  // Hard availability gate: no persisted result is read or written until
  // every response dependency can be authorized at reuse time.
  const skipCache =
    !semanticCache ||
    !semanticCache.cache.isEnabled() ||
    (opts?.walkDepth ?? 0) > 0 ||
    Boolean(opts?.nearSymbol) ||
    semanticCache.isNonDefaultColumn ||
    opts?.dedupOpts !== undefined ||
    dateFiltered ||
    typeFiltered ||
    pagedRequest;
  return skipCache;
}

/** Cache lookup: the budgeted page on a hit (meta + telemetry emitted here), null on a miss. */
export async function serveSemanticCacheHit(
  engine: BrainEngine,
  query: string,
  opts: HybridSearchOpts | undefined,
  semanticCache: SemanticCacheHandle,
  queryEmbedding: Float32Array,
  resolvedForCache: ResolvedSearchKnobs,
): Promise<SearchResult[] | null> {
  let cacheSimilarity: number | undefined;
  let cacheAge: number | undefined;
  const hit = await semanticCache.cache.lookup(queryEmbedding, { sourceId: cacheScopeKey(opts), knobsHash: semanticCache.cacheKnobsHash, queryText: query }); // queryText → #1469 text guard
  if (hit.hit && hit.results) {
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
    // config round-trip. This is still a SEPARATE `resolveSearchMode` call
    // from the inner one (the wrapper folds in a `cache_enabled` perCall
    // knob), but both now resolve from the SAME loaded snapshot — the miss
    // path threads it via `_searchModeInput` (#4359).
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
  return null;
}
