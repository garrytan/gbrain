/**
 * Page operations over the store's page_ops family (rust/docs/store/page_ops.md).
 *
 * Served: getContentFlagsByPageIds, getUnverifiedExtractionPageIds, getEffectiveDates. The other page operations are not
 * built yet and refuse with `engine_capability_missing` (docs/designs/RUST_ENGINE_INTERFACES.md).
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import type { HybridSearchOpts, PostFusionOpts } from '../../search/hybrid.ts';
import type { PageReadScope } from '../../types.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

/**
 * Every key hybridSearch's option bag carries that does not decide which pages a marker read may see: the search's own
 * settings, callbacks and internal flags, and `takesHoldersAllowList`, which only the takes reads honour. hybridSearch
 * hands the page-marker reads (stampContentFlags, stampUnverifiedExtractions) that whole bag as their policy, and PGLite
 * reads only the page policy out of it (src/core/search/read-policy-sql.ts), so these change nothing here. The list is
 * checked against the two option types below: a new key in either one fails the type check until it is listed.
 */
const HYBRID_BAG_KEYS = [
  'expansion', 'anyWordFill', 'decide', 'aliasTokenHop', 'onRelationalMeta', 'mode', 'expandFn', 'expansionVariantBudget',
  'keywordArmConfidenceFloor', 'metadataBoostGate', 'rerankGate', 'pageRankCut', 'explainTarget', 'explain', 'rrfK', 'dedupOpts',
  'onMeta', 'onRerankPool', '_queryEmbedDeadline', '_queryPrefix', '_embeddingOptedOut', '_timings', 'queryEmbedFn',
  'onQueryEmbedding', '_telemetryCacheStatus', '_searchModeInput', 'limit', 'offset', 'onVectorPoolMeta', 'vectorLegacyGuard',
  'hnswIterativeScan', 'cjkKeyword', 'onKeywordIncomplete', 'adaptiveReturn', 'autocut', 'type', 'types', 'where',
  'exclude_slugs', 'exclude_slug_prefixes', 'source_boosts', 'include_slug_prefixes', 'detail', 'language', 'symbolKind',
  'nearSymbol', 'walkDepth', 'orFallback', 'orFill', 'keywordTimeoutCache', 'rankQuery', 'keywordPhrase', 'embeddingColumn',
  'afterDate', 'afterDateInclusive', 'beforeDate', 'beforeDateInclusive', 'recencyBoost', 'salience', 'recency', 'since',
  'until', 'tokenBudget', 'useCache', 'intentWeighting', 'reranker', 'floorRatio', 'crossModal', 'graph_signals',
  'relationalRetrieval', 'relationalRetrievalDepth', 'relationalRerankPin', 'relationalPlanner', 'relationalOrientOneHop',
  'relationalChainSlots', 'takesHoldersAllowList', 'applyBacklinks', 'decayMap', 'fallback', 'graphSignalsEnabled',
  'onGraphMeta', 'onScoreDistribution', 'query', 'titleBoost', 'skipMetadataBoosts',
] as const;
type BagKey = Exclude<keyof HybridSearchOpts | keyof PostFusionOpts, keyof PageReadScope>;
// Both directions: every listed key is a key of the bag, and every key of the bag that is not a page policy key is listed.
const HYBRID_BAG_KEYS_CHECKED: readonly BagKey[] = HYBRID_BAG_KEYS;
const HYBRID_BAG_KEYS_COMPLETE: [Exclude<BagKey, (typeof HYBRID_BAG_KEYS)[number]>] extends [never] ? true : never = true;
void HYBRID_BAG_KEYS_CHECKED;
void HYBRID_BAG_KEYS_COMPLETE;

/**
 * A `PageReadScope` as the store reads it. Any scope object turns on PGLite's live filter (not deleted, not quarantined,
 * source not archived), so `live` says one was passed. The trust filters refuse when set: the store keeps no trust tiers.
 * `requireSafeChunks` changes nothing on these reads. `markerRead` is for the marker reads hybridSearch hands its whole
 * option bag: they also accept and ignore the bag's own keys (any other key still refuses) and serve `excludePrivate`
 * as the page policy `pageReadFilter` adds (private-provenance.ts `storePagePolicy`, which refuses a caller whose policy
 * is wider than the store's). getEffectiveDates still refuses `excludePrivate`.
 */
function readScope(member: string, opts: PageReadScope | undefined, markerRead = false): Record<string, unknown> {
  if (opts === undefined || opts === null) return {};
  for (const key of markerRead ? (['minTrust', 'suppressFlagged'] as const) : (['excludePrivate', 'minTrust', 'suppressFlagged'] as const)) {
    if (opts[key]) refuseMember(member, `option ${key}`);
  }
  const ignored = ['requireSafeChunks', 'excludePrivate', 'minTrust', 'suppressFlagged', ...(markerRead ? HYBRID_BAG_KEYS : [])];
  const taken = takeOptions(member, opts, ['sourceId', 'sourceIds'], ignored);
  const excludePrivate = markerRead ? storePagePolicy(member, opts.excludePrivate) : undefined;
  return { ...taken, live: true, ...(excludePrivate ? { excludePrivate } : {}) };
}

const reviveDate = (value: unknown): Date => new Date(String(value));

/** Page ids as the store reads them: integers only, as Postgres's `int[]` cast requires. */
function pageIds(member: string, ids: number[]): number[] {
  for (const id of ids) if (!Number.isSafeInteger(id)) throw new TypeError(`${member}: page id ${String(id)} is not an integer`);
  return ids;
}

export const getContentFlagsByPageIds: StoreMember<[pageIds: number[], opts?: PageReadScope], Map<number, { reason: string; detail: string }>> = async (
  brain,
  ids,
  opts,
) => {
  if (!ids.length) return new Map();
  const scope = readScope('getContentFlagsByPageIds', opts, true);
  const rows: Array<{ id: number; reason: string; detail: string }> = await storeCall({ member: 'getContentFlagsByPageIds' }, () =>
    brain.getContentFlagsByPageIds(pageIds('getContentFlagsByPageIds', ids), scope));
  return new Map(rows.map((r) => [Number(r.id), { reason: r.reason, detail: r.detail }]));
};

export const getUnverifiedExtractionPageIds: StoreMember<[pageIds: number[], opts?: PageReadScope], Map<number, { unverified: boolean; status: string }>> = async (
  brain,
  ids,
  opts,
) => {
  if (!ids.length) return new Map();
  const scope = readScope('getUnverifiedExtractionPageIds', opts, true);
  const rows: Array<{ id: number; status: string; unverified: boolean }> = await storeCall({ member: 'getUnverifiedExtractionPageIds' }, () =>
    brain.getUnverifiedExtractionPageIds(pageIds('getUnverifiedExtractionPageIds', ids), scope));
  return new Map(rows.map((r) => [Number(r.id), { unverified: r.unverified === true, status: r.status }]));
};

export const getEffectiveDates: StoreMember<[refs: Array<{ slug: string; source_id: string }>, opts?: PageReadScope], Map<string, Date>> = async (
  brain,
  refs,
  opts,
) => {
  if (!refs.length) return new Map();
  const scope = readScope('getEffectiveDates', opts);
  const rows: Array<{ slug: string; source_id: string; ts: string }> = await storeCall({ member: 'getEffectiveDates' }, () =>
    brain.getEffectiveDates(refs.map((r) => ({ slug: r.slug, source_id: r.source_id })), scope));
  return new Map(rows.map((r) => [`${r.source_id}::${r.slug}`, reviveDate(r.ts)]));
};
