/**
 * The search options a page-policy read is handed but never reads.
 *
 * Hybrid search passes its caller's whole `HybridSearchOpts` as the read policy of the reads it runs after fusion
 * (search/hybrid.ts `stampContentFlags`, `stampUnverifiedExtractions`), and whoknows passes its options the same
 * way. The search arms already applied the type, slug, date and ranking options, and the shared SQL of those reads
 * (`pageReadFilter`) reads only the page policy, so a store member ignores them as well.
 */
import type { HybridSearchOpts } from '../../search/hybrid.ts';
import type { PageReadPolicy } from '../../types.ts';

/** Every `HybridSearchOpts` key outside `PageReadPolicy`. A Record, so a new search option fails typecheck until it is listed. */
const SEARCH_ONLY: Record<Exclude<keyof HybridSearchOpts, keyof PageReadPolicy>, true> = {
  limit: true, offset: true, onVectorPoolMeta: true, vectorLegacyGuard: true, hnswIterativeScan: true, cjkKeyword: true,
  onKeywordIncomplete: true, adaptiveReturn: true, autocut: true, type: true, types: true, where: true, exclude_slugs: true,
  exclude_slug_prefixes: true, source_boosts: true, include_slug_prefixes: true, detail: true, language: true,
  symbolKind: true, nearSymbol: true, walkDepth: true, orFallback: true, orFill: true, keywordTimeoutCache: true,
  rankQuery: true, keywordPhrase: true, embeddingColumn: true, afterDate: true, afterDateInclusive: true, beforeDate: true,
  beforeDateInclusive: true, recencyBoost: true, salience: true, recency: true, since: true, until: true, tokenBudget: true,
  useCache: true, intentWeighting: true, reranker: true, floorRatio: true, crossModal: true, graph_signals: true,
  relationalRetrieval: true, relationalRetrievalDepth: true, relationalRerankPin: true, relationalPlanner: true,
  relationalOrientOneHop: true, relationalChainSlots: true,
  expansion: true, anyWordFill: true, decide: true, aliasTokenHop: true, onRelationalMeta: true, mode: true, expandFn: true,
  expansionVariantBudget: true, keywordArmConfidenceFloor: true, metadataBoostGate: true, rerankGate: true,
  pageRankCut: true, explainTarget: true, explain: true, rrfK: true, dedupOpts: true, onMeta: true, onRerankPool: true,
  _queryEmbedDeadline: true, _queryPrefix: true, _embeddingOptedOut: true, _timings: true, queryEmbedFn: true,
  onQueryEmbedding: true, _telemetryCacheStatus: true, _searchModeInput: true,
};

/** The `HybridSearchOpts` keys a page-policy read ignores; the read policy keys stay each member's own choice. */
export const SEARCH_OPTION_KEYS: readonly string[] = Object.freeze(Object.keys(SEARCH_ONLY));
