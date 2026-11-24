/**
 * Vector search members (BrainEngine searchVector, searchTakesVector). The store answers with an exact flat scan of
 * the stored vectors (rust/docs/store/vectors.md): every candidate the filters admit is scored, so there is no HNSW
 * candidate pool and the pool callbacks and planner knobs change nothing. Scores are pgvector's cosine in float64
 * from the stored float32 vectors. This shell resolves what the shared statement resolves in TypeScript (limit clamp
 * and its warning, the boost map, hard excludes, source scope, the model guard's model) and sends plain values.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served.
 */
import { clampSearchLimit } from '../../engine.ts';
import type { TakeHit } from '../../engine.ts';
import type { ReadEligibility } from '../../eligibility/policy.ts';
import { normalizeEngineColumn } from '../../search/embedding-column.ts';
import { searchLimitCap } from '../../search/eval-pool-depth.ts';
import { requiresSafeChunks } from '../../search/safe-chunks.ts';
import { resolveBoostMap, resolveHardExcludes } from '../../search/source-boost.ts';
import type { SearchOpts, SearchResult } from '../../types.ts';
import { rowToSearchResult } from '../../utils.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';
import { dateMicros, whereFields } from './search-filters.ts';

/** The `SearchOpts` keys the vector statement reads and the store applies. */
const VECTOR_FILTERS = [
  'limit', 'offset', 'type', 'types', 'exclude_slugs', 'exclude_slug_prefixes', 'include_slug_prefixes', 'detail',
  'language', 'symbolKind', 'sourceId', 'sourceIds', 'source_boosts', 'embeddingColumn', 'requireSafeChunks', 'excludePrivate',
  'where', 'afterDate', 'afterDateInclusive', 'beforeDate', 'beforeDateInclusive', 'minTrust',
  'suppressFlagged',
] as const;

/**
 * Keys the vector statement never reads, or reads only to steer its HNSW candidate pool (`vectorLegacyGuard`,
 * `hnswIterativeScan`, `onVectorPoolMeta`), which an exact scan does not have. `excludePrivate` is served as the page
 * policy (private-provenance.ts).
 */
const VECTOR_IGNORED = [
  'onVectorPoolMeta', 'vectorLegacyGuard', 'hnswIterativeScan', 'cjkKeyword', 'onKeywordIncomplete', 'adaptiveReturn',
  'autocut', 'nearSymbol', 'walkDepth', 'orFallback', 'orFill', 'keywordTimeoutCache', 'rankQuery', 'keywordPhrase',
  'recencyBoost', 'salience', 'recency', 'since', 'until', 'tokenBudget',
  'useCache', 'intentWeighting', 'reranker', 'floorRatio', 'crossModal', 'graph_signals', 'relationalRetrieval',
  'relationalRetrievalDepth', 'relationalRerankPin', 'relationalPlanner', 'relationalOrientOneHop',
  'relationalChainSlots', 'takesHoldersAllowList',
] as const;

/** `SearchOpts` keys that do not change which takes `searchTakesVector` returns (its SQL never reads them). */
const TAKES_IGNORED = [
  'minTrust', 'suppressFlagged', 'requireSafeChunks', 'offset', 'type', 'types', 'where', 'exclude_slugs',
  'exclude_slug_prefixes', 'source_boosts', 'include_slug_prefixes', 'detail', 'language', 'symbolKind',
  'embeddingColumn', 'afterDate', 'afterDateInclusive', 'beforeDate', 'beforeDateInclusive', ...VECTOR_IGNORED.filter((key) => key !== 'takesHoldersAllowList'),
] as const;

/** The SQL module's source filter: a non-empty `sourceIds` wins over a truthy `sourceId`; neither is no scope. */
function sourceScope(opts: { sourceId?: unknown; sourceIds?: unknown }): unknown[] | null {
  if (Array.isArray(opts.sourceIds) && opts.sourceIds.length > 0) return opts.sourceIds;
  if (opts.sourceId) return [opts.sourceId];
  return null;
}

/** A finite number as is; Postgres reads a non-finite one as text, so the store gets the same text. */
function jsNumber(value: number): number | string {
  return Number.isFinite(value) ? value : String(value);
}

/**
 * `buildSourceFactorCase`'s entries as data: none when detail is high; otherwise the non-empty prefixes with a finite,
 * non-negative factor, longest prefix first.
 */
function sourceFactors(boosts: Record<string, number>, detail: unknown): Array<[string, number]> {
  const normalized = typeof detail === 'string' ? detail.trim().toLowerCase() : detail;
  if (normalized === 'high') return [];
  return Object.entries(boosts)
    .filter(([prefix, factor]) => prefix.length > 0 && Number.isFinite(factor) && factor >= 0)
    .sort((a, b) => b[0].length - a[0].length);
}

/** The model the statement's guard binds: the column's embedding model, or none (`embeddingModel || null`). */
function guardModel(column: SearchOpts['embeddingColumn']): string | null {
  const resolved = normalizeEngineColumn(column);
  if (resolved.name !== 'embedding') refuseMember('searchVector', `embedding column ${resolved.name}`);
  return resolved.embeddingModel || null;
}

export const searchVector: StoreMember<[embedding: Float32Array, opts?: SearchOpts], SearchResult[]> = async (brain, embedding, opts = {}) => {
  const o = takeOptions('searchVector', opts, VECTOR_FILTERS, VECTOR_IGNORED) as SearchOpts;
  const model = guardModel(o.embeddingColumn);
  // The store keeps one vector column, `embedding`; a brain whose config routes vectors to another column is refused
  // as the embedding members refuse it, not answered from the wrong space.
  for (const key of ['search_embedding_column', 'embedding_columns']) {
    if (await storeCall({ member: 'searchVector' }, () => brain.getConfig(key))) {
      refuseMember('searchVector', `config ${key} selects another embedding column`);
    }
  }
  const cap = searchLimitCap();
  const limit = clampSearchLimit(o.limit, 20, cap);
  if (o.limit && o.limit > cap) {
    console.warn(`[gbrain] Warning: search limit clamped from ${o.limit} to ${cap}`);
  }
  // `excludePrivate` is the page policy `buildVisibilityClause` adds; a caller whose policy is wider refuses.
  const policy = storePagePolicy('searchVector', o.excludePrivate, { callerReaders: true });
  const options = {
    limit,
    offset: jsNumber(Number(o.offset || 0)),
    type: o.type || null,
    types: o.types?.length ? o.types : null,
    exclude_slugs: o.exclude_slugs?.length ? o.exclude_slugs : null,
    // `frontmatterWhereClauses`: an absent or empty `where` adds no clause.
    where: o.where ? whereFields('searchVector', o.where) : [],
    // `dateBound`: a truthy bound read as `timestamptz`, strict unless its `*Inclusive` flag is set.
    after_date: o.afterDate ? { micros: dateMicros('searchVector', o.afterDate), inclusive: Boolean(o.afterDateInclusive) } : null,
    // `pageEligibleSql`'s floor: a truthy `minTrust` (an empty one adds no clause).
    min_trust: o.minTrust ? String(o.minTrust) : null,
    // `pageEligibleSql`'s `activationSuppressedSql`: only a truthy `suppressFlagged` adds it.
    suppress_flagged: Boolean(o.suppressFlagged),
    before_date: o.beforeDate ? { micros: dateMicros('searchVector', o.beforeDate), inclusive: Boolean(o.beforeDateInclusive) } : null,
    hard_excludes: resolveHardExcludes(o.exclude_slug_prefixes, o.include_slug_prefixes),
    detail: o.detail === 'low' ? 'low' : null,
    language: o.language || null,
    symbolKind: o.symbolKind || null,
    source_ids: sourceScope(o),
    model,
    source_factors: sourceFactors(o.source_boosts ?? resolveBoostMap(), o.detail),
    require_safe_chunks: requiresSafeChunks(o),
    exclude_private: policy ?? null,
  };
  const query = Array.from(embedding);
  const rows: Record<string, unknown>[] = await storeCall({ member: 'searchVector' }, () => brain.searchVector(query, options));
  // PGLite's undated hit carries both date keys as null; a zero vector's score is NaN, which JSON carries as null.
  return rows.map((row) => rowToSearchResult({
    effective_date: null, effective_date_source: null, ...row, score: row.score ?? Number.NaN,
  }));
};

export const searchTakesVector: StoreMember<
  [embedding: Float32Array, opts?: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[]; eligibility?: ReadEligibility }],
  TakeHit[]
> = async (brain, embedding, opts = {}) => {
  const o = takeOptions('searchTakesVector', opts, ['limit', 'takesHoldersAllowList', 'sourceId', 'sourceIds', 'eligibility', 'excludePrivate'], TAKES_IGNORED) as
    { limit?: number; takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[]; eligibility?: ReadEligibility; excludePrivate?: boolean };
  const policy = o.eligibility;
  // The store applies the whole read-eligibility policy (the trust floor over each take's stamped tier and flag
  // suppression) and the caller's page policy, as the SQL's projectionEligibleSql and privacy predicate do.
  const options = {
    limit: clampSearchLimit(o.limit, 30, 100),
    allow_list: o.takesHoldersAllowList ?? null,
    source_ids: sourceScope(o),
    eligible_only: !!policy,
    min_trust: policy?.floor ?? null,
    suppress_flagged: policy?.suppressFlagged === true,
    exclude_private: storePagePolicy('searchTakesVector', o.excludePrivate, { callerReaders: true }) ?? null,
  };
  const query = Array.from(embedding);
  const rows: TakeHit[] = await storeCall({ member: 'searchTakesVector' }, () => brain.searchTakesVector(query, options));
  return rows.map((row) => ({ ...row, score: row.score ?? Number.NaN }));
};
