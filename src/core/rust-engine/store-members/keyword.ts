/**
 * Keyword search members of the keyword_search capability and title trigrams. findByTitleFuzzy, searchKeyword,
 * searchKeywordChunks, countKeywordPages, searchKeywordPages and searchTitles are served. searchTitles rebuilds each
 * page's keyword vector from the sanitized timeline the last seal sent (`pages::search_timeline`).
 *
 * The keyword members resolve every engine default here (the hard-exclude list, the source-boost map, the slug
 * handles, the dash-run collapse, the date bounds) and send the store only predicates; rust/docs/store/keyword.md
 * lists what each member reads, ignores and refuses. A CJK query takes PGLite's CJK fallback: searchKeyword and
 * searchKeywordChunks run `searchKeywordCjk` (engine-sql/cjk-search.ts), countKeywordPages and searchKeywordPages send
 * the match terms (`cjkTerms`), and searchTitles runs its usual statements, as both SQL engines do.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import { cjkMatchTerms, hasCJK, splitCJKQueryTerms } from '../../cjk.ts';
import { clampSearchLimit } from '../../engine.ts';
import { CJK_CANDIDATE_CAP, PGLITE_CJK_CAPPED_CHUNKS, type CjkKeywordMeta } from '../../engine-sql/cjk-search.ts';
import { rankByRarity } from '../../engine-sql/titles.ts';
import { normalizeAlias } from '../../search/alias-normalize.ts';
import { getFtsLanguage } from '../../fts-language.ts';
import { searchLimitCap } from '../../search/eval-pool-depth.ts';
import { requiresSafeChunks } from '../../search/safe-chunks.ts';
import { slugHandles } from '../../search/keyword-handles.ts';
import { holdsIdentifiers, identifierTokens, keywordArmRows } from '../../search/keyword-identifier-probe.ts';
import {
  RARE_TERM_CHUNK_CAP, RARITY_MAX_TERMS, rankOrFallbackByRarity, type RareTermPages,
} from '../../search/keyword-or-rarity.ts';
import type { KeywordPageWindow } from '../../search/keyword-statement.ts';
import type { FrontmatterWhere } from '../../search/frontmatter-where.ts';
import { resolveBoostMap, resolveHardExcludes } from '../../search/source-boost.ts';
import {
  boundWebsearchQuery, buildOrFallbackWebsearchQuery, collapseWebsearchDashRuns, orFallbackTokens,
} from '../../search/sql-ranking.ts';
import { titleNameVariants } from '../../search/title-match.ts';
import { titleWholeVectorCandidates } from '../../search/title-statement.ts';
import type { SearchOpts, SearchResult } from '../../types.ts';
import { rowToSearchResult } from '../../utils.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import type { StoreBrain } from '../store.ts';
import { storePagePolicy } from './private-provenance.ts';
import { dateMicros, whereFields } from './search-filters.ts';

type Row = Record<string, unknown>;
type FuzzyHit = { slug: string; similarity: number } | null;

export const findByTitleFuzzy: StoreMember<[name: string, dirPrefix?: string, minSimilarity?: number, sourceId?: string], FuzzyHit> =
  async (brain, name, dirPrefix, minSimilarity, sourceId) => {
    // `similarity(title, NULL)` and `>= NULL` are never true, so a null name or threshold finds nothing on the SQL
    // engines.
    if (minSimilarity === null || name === null || name === undefined) return null;
    // The SQL engines scope by `dirPrefix` and `sourceId` only when they are truthy.
    const dir = dirPrefix ? String(dirPrefix) : undefined;
    const source = sourceId ? String(sourceId) : undefined;
    return storeCall({ member: 'findByTitleFuzzy' }, () => brain.findByTitleFuzzy(String(name), dir, minSimilarity, source));
  };

/**
 * Options no keyword statement reads: hybrid-search, vector and reporting knobs. On a CJK query searchKeyword and
 * searchKeywordChunks read `orFallback` and `cjkKeyword` themselves (`searchCjk`).
 */
const NOT_READ = new Set([
  'onVectorPoolMeta', 'vectorLegacyGuard', 'hnswIterativeScan', 'cjkKeyword', 'onKeywordIncomplete', 'adaptiveReturn',
  'autocut', 'nearSymbol', 'walkDepth', 'orFallback', 'orFill', 'keywordTimeoutCache', 'rankQuery', 'embeddingColumn',
  'recencyBoost', 'salience', 'recency', 'since', 'until', 'tokenBudget', 'takesHoldersAllowList', 'useCache',
  'intentWeighting', 'reranker', 'floorRatio', 'crossModal', 'graph_signals', 'relationalRetrieval',
  'relationalRetrievalDepth', 'relationalRerankPin', 'relationalPlanner', 'relationalOrientOneHop',
  'relationalChainSlots',
]);
/** Options every keyword statement turns into a predicate or a factor. */
const SHARED = new Set([
  'detail', 'language', 'symbolKind', 'afterDate', 'afterDateInclusive', 'beforeDate', 'beforeDateInclusive', 'sourceId',
  'sourceIds', 'exclude_slug_prefixes', 'include_slug_prefixes', 'source_boosts',
]);
/** The page filters every keyword statement applies: single type, multi-type, frontmatter `where`, exact-slug excludes. */
const PAGE_FILTERS = ['type', 'types', 'where', 'exclude_slugs'] as const;
/**
 * Visibility options the store applies (`buildVisibilityClause`): the page privacy policy (storePagePolicy), the
 * chunker-version fence of a safe-chunk read (`requiresSafeChunks`, which an `excludePrivate` read asks for unless it
 * says otherwise), the trust floor and the flagged-page filter (`pageEligibleSql`) on the page's stamped trust tier.
 */
const VISIBILITY = ['excludePrivate', 'requireSafeChunks', 'minTrust', 'suppressFlagged'] as const;

type Member = 'searchKeyword' | 'searchKeywordChunks' | 'countKeywordPages' | 'searchKeywordPages' | 'searchTitles';

/** Checks every option `member` gets, refusing one it cannot answer exactly, and returns the store options. */
function keywordOptions(member: Member, query: string, opts: (SearchOpts & { timeoutMs?: number }) | undefined): Record<string, unknown> {
  if (typeof query !== 'string') refuseMember(member, 'a query that is not a string');
  if (getFtsLanguage() !== 'english') refuseMember(member, `the ${getFtsLanguage()} text search configuration`);
  const o = (opts ?? {}) as Record<string, unknown>;
  const pageGrain = member !== 'searchKeywordChunks';
  for (const [key, value] of Object.entries(o)) {
    if (value === undefined || value === false || NOT_READ.has(key) || SHARED.has(key)) continue;
    if (key === 'limit' || key === 'offset') continue;
    if ((VISIBILITY as readonly string[]).includes(key)) continue;
    if (key === 'timeoutMs' && member === 'countKeywordPages') continue;
    // keywordPhrase: searchKeywordChunks ignores it, as both SQL statements rank without the phrase factor.
    if ((PAGE_FILTERS as readonly string[]).includes(key) || key === 'keywordPhrase') continue;
    refuseMember(member, `option ${key}`);
  }

  const out: Record<string, unknown> = {};
  if (o.detail === 'low') out.detailLow = true;
  if (o.language) out.language = String(o.language);
  if (o.symbolKind) out.symbolKind = String(o.symbolKind);
  if (o.afterDate) out.afterDate = { micros: dateMicros(member, o.afterDate), inclusive: Boolean(o.afterDateInclusive) };
  if (o.beforeDate) out.beforeDate = { micros: dateMicros(member, o.beforeDate), inclusive: Boolean(o.beforeDateInclusive) };
  const sourceIds = o.sourceIds as string[] | undefined;
  if (sourceIds && sourceIds.length > 0) out.sources = sourceIds.map(String);
  else if (o.sourceId) out.sources = [String(o.sourceId)];
  out.hardExcludes = resolveHardExcludes(o.exclude_slug_prefixes as string[] | undefined, o.include_slug_prefixes as string[] | undefined);
  out.boosts = boostPairs((o.source_boosts as Record<string, number> | undefined) ?? resolveBoostMap(), o.detail);
  if (o.type) out.type = String(o.type);
  if ((o.types as string[] | undefined)?.length) out.types = (o.types as string[]).map(String);
  if (o.where) out.where = whereFields(member, o.where);
  if ((o.exclude_slugs as string[] | undefined)?.length) out.excludeSlugs = (o.exclude_slugs as string[]).map(String);
  if (pageGrain && o.keywordPhrase === true) out.phrase = true;
  const policy = storePagePolicy(member, o.excludePrivate, { callerReaders: true });
  if (policy) out.excludePrivate = policy;
  if (requiresSafeChunks(opts)) out.requireSafeChunks = true;
  if (o.minTrust) out.minTrust = String(o.minTrust);
  if (o.suppressFlagged) out.suppressFlagged = true;
  return out;
}

/** `buildSourceFactorCase`'s CASE arms in order: none for `detail` high, else longest prefix first. */
function boostPairs(map: Record<string, number>, detail: unknown): [string, number][] {
  const normalized = typeof detail === 'string' ? detail.trim().toLowerCase() : detail;
  if (normalized === 'high') return [];
  return Object.entries(map)
    .filter(([prefix, factor]) => prefix.length > 0 && Number.isFinite(factor) && factor >= 0)
    .sort((a, b) => b[0].length - a[0].length);
}

/** A row count the SQL engines bind as a bigint: refuse what Postgres would reject (fractions, negatives). */
function wholeCount(member: Member, value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) refuseMember(member, `${what} that is not a whole number of 0 or more`);
  return value;
}

/** The CJK match terms with their operator (`likeClauses`: LIKE for a term without case, else ILIKE). */
function cjkTerms(query: string): { text: string; ilike: boolean }[] {
  return cjkMatchTerms(query).map(text => ({ text, ilike: text.toLowerCase() !== text.toUpperCase() }));
}

/**
 * engine-sql/cjk-search.ts `searchKeywordCJK` as PGLite runs it, over the raw query: strict AND, the OR fallback when
 * `orFallback` applies and the strict rows fall short, and with `cjkKeyword` the bounded arm (bounded by work: the
 * store compares its chunk count with `pgliteCappedChunks`) and its `onMeta` report. `dedup` is searchKeyword.
 */
async function searchCjk(
  brain: StoreBrain, member: Member, query: string, opts: SearchOpts | undefined,
  options: Record<string, unknown>, dedup: boolean,
): Promise<SearchResult[]> {
  const terms = cjkTerms(query);
  if (query.length === 0 || terms.length === 0) return [];
  const started = performance.now();
  const bounded = opts?.cjkKeyword;
  const run = {
    terms, dedup, orFallback: opts?.orFallback === true && splitCJKQueryTerms(query).length > 1,
    ...(bounded ? {
      bounded: {
        cap: bounded.candidateCap ?? CJK_CANDIDATE_CAP, cappedChunks: bounded.pgliteCappedChunks ?? PGLITE_CJK_CAPPED_CHUNKS,
      },
    } : {}),
  };
  const out: { rows: Row[]; capped: boolean; capHit: boolean } = await storeCall({ member }, () => brain.searchKeywordCjk(query, options, run));
  if (bounded) {
    const meta: Omit<CjkKeywordMeta, 'arm_ms'> = !out.capped ? { incomplete: false, capped: false }
      : out.capHit ? { incomplete: true, reason: 'candidate_budget', capped: true } : { incomplete: false, capped: true };
    bounded.onMeta?.({ ...meta, arm_ms: Math.round(performance.now() - started) });
  }
  return out.rows.map(rowToSearchResult);
}

export const searchKeywordChunks: StoreMember<[query: string, opts?: SearchOpts], SearchResult[]> = async (brain, query, opts) => {
  const options = keywordOptions('searchKeywordChunks', query, opts);
  const cap = searchLimitCap();
  if (opts?.limit && opts.limit > cap) {
    console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${cap}`);
  }
  options.limit = clampSearchLimit(opts?.limit, 20, cap);
  options.offset = wholeCount('searchKeywordChunks', opts?.offset || 0, 'an offset');
  if (hasCJK(query)) return searchCjk(brain, 'searchKeywordChunks', query, opts, options, false);
  const rows: Record<string, unknown>[] = await storeCall({ member: 'searchKeywordChunks' },
    () => brain.searchKeywordChunks(collapseWebsearchDashRuns(query), options));
  return rows.map(rowToSearchResult);
};

/**
 * The frontmatter check on finished search rows (keepFrontmatterMatches): the store keeps the ids whose page holds
 * every `where` key, by the rule the keyword and vector `where` filters use (whereFields; `frontmatter_holds`).
 */
export const filterPageIdsByFrontmatter: StoreMember<[ids: number[], where: FrontmatterWhere], number[]> = async (brain, ids, where) => {
  if (!ids.every(id => Number.isSafeInteger(id) && id > 0)) refuseMember('filterPageIdsByFrontmatter', 'a page id that is not a positive integer');
  return storeCall({ member: 'filterPageIdsByFrontmatter' },
    () => brain.filterPageIdsByFrontmatter({ ids, where: whereFields('filterPageIdsByFrontmatter', where) })) as Promise<number[]>;
};

export const countKeywordPages: StoreMember<[query: string, opts?: SearchOpts & { timeoutMs?: number }], number> = async (brain, query, opts) => {
  const options = keywordOptions('countKeywordPages', query, opts);
  if (query.trim() === '') return 0;
  if (hasCJK(query)) {
    // buildKeywordMatch's CJK arm: the terms ANDed, no handle arm; no terms match nothing.
    options.cjkTerms = cjkTerms(query);
    if ((options.cjkTerms as unknown[]).length === 0) return 0;
  } else {
    options.handles = slugHandles(query, true) ?? [];
  }
  return Number(await storeCall({ member: 'countKeywordPages' }, () => brain.countKeywordPages(query, options)));
};

export const searchKeywordPages: StoreMember<[query: string, opts: SearchOpts | undefined, page: KeywordPageWindow], SearchResult[]> =
  async (brain, query, opts, page) => {
    const options = keywordOptions('searchKeywordPages', query, opts);
    if (query.trim() === '') return [];
    if (hasCJK(query)) {
      options.cjkTerms = cjkTerms(query);
      if ((options.cjkTerms as unknown[]).length === 0) return [];
    } else {
      options.handles = slugHandles(query, true) ?? [];
    }
    options.limit = wholeCount('searchKeywordPages', page?.limit, 'a page limit');
    options.offset = wholeCount('searchKeywordPages', page?.offset ?? 0, 'a page offset');
    if (page?.after) {
      const { score, page_id } = page.after;
      if (typeof score !== 'number' || !Number.isFinite(score)) refuseMember('searchKeywordPages', 'an after.score that is not a finite number');
      if (typeof page_id !== 'number' || !Number.isSafeInteger(page_id)) refuseMember('searchKeywordPages', 'an after.page_id that is not a whole number');
      options.after = { score, pageId: page_id };
    }
    const rows: Record<string, unknown>[] = await storeCall({ member: 'searchKeywordPages' }, () => brain.searchKeywordPages(query, options));
    return rows.map(rowToSearchResult);
  };


/**
 * PGLite's keyword arm (pglite-engine.ts searchKeyword): the strict statement over the dash-collapsed query, then the
 * retries of keyword-identifier-probe.ts (handle pages, identifier probe, any-word retry ranked by word rarity)
 * through the same statement. It reads no vector or hybrid knob (`embeddingColumn`, `cjkKeyword`,
 * `keywordTimeoutCache`, `vectorLegacyGuard`, `hnswIterativeScan`, `onVectorPoolMeta`), so the hybrid arm's options
 * are served as PGLite serves them.
 */
export const searchKeyword: StoreMember<[query: string, opts?: SearchOpts], SearchResult[]> = async (brain, query, opts) => {
  const options = keywordOptions('searchKeyword', query, opts);
  const cap = searchLimitCap();
  const limit = clampSearchLimit(opts?.limit, 20, cap);
  const offset = wholeCount('searchKeyword', opts?.offset || 0, 'an offset')!;
  if (opts?.limit && opts.limit > cap) {
    console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${cap}`);
  }
  options.limit = limit;
  options.innerLimit = Math.min((offset + limit) * 3, cap * 3);
  options.offset = offset;
  // PGLite's CJK branch returns before the strict statement and its retries.
  if (hasCJK(query)) return searchCjk(brain, 'searchKeyword', query, opts, options, true);
  const rankQuery = opts?.rankQuery ? String(opts.rankQuery) : undefined;
  const call = (match: string, rank: string): Promise<Row[]> =>
    storeCall({ member: 'searchKeyword' }, () => brain.searchKeywordArm(match, rank, options));
  const collapsed = collapseWebsearchDashRuns(query);
  const strict = opts?.orFill ? [] : await call(collapsed, rankQuery ?? collapsed);
  // PGLite's `run`: the match replaces `$1`; the rank is the caller's rankQuery, else (orFallback) the retry's rank,
  // else `$1` itself.
  const run = (match: string, rank: string) => call(match, rankQuery ?? (opts?.orFallback ? rank : match));
  return keywordArmRows({
    query, strict, orFallback: opts?.orFallback, orFill: opts?.orFill, limit, offset, toResult: rowToSearchResult,
    runProbe: run, onIncomplete: opts?.onKeywordIncomplete,
    runHandles: async handles => {
      if (query.trim() === '' || handles.length === 0) return [];
      const { innerLimit: _inner, ...rest } = options;
      const handleOptions = { ...rest, handles, handlesOnly: true, limit, offset: 0 };
      const rows: Row[] = await storeCall({ member: 'searchKeyword' }, () => brain.searchKeywordPages(query, handleOptions));
      return rows.map(rowToSearchResult);
    },
    runRelaxed: async orQuery => rankOrFallbackByRarity({
      query, rows: await run(orQuery, orQuery), limit, offset, runRare: q => run(q, orQuery),
      readTermPages: async terms => (await storeCall({ member: 'searchKeyword' },
        () => brain.keywordRareTermPages(terms, RARE_TERM_CHUNK_CAP))) as RareTermPages[],
    }),
  });
};

type TitleKind = 'whole' | 'title' | 'complete';
type TitleAttempt = { text: string; kind: TitleKind; limit: number; offset: number };

/**
 * engine-sql/titles.ts `searchTitles`: the strict attempt over the whole vector (completed by the title-only attempt
 * when more pages match than `titleWholeVectorCandidates()`), then the any-word retry with per-word rarity and the
 * identifier lead. Each store call runs its attempts over one read, as each scoped read of the SQL engines does.
 * A safe-chunk read (`requiresSafeChunks`) is title-only throughout, as `buildSearchTitlesStatement` makes it: every
 * attempt matches and ranks the title lexemes and none is capped, so each one runs as the `title` kind.
 */
export const searchTitles: StoreMember<[query: string, opts?: SearchOpts], SearchResult[]> = async (brain, query, opts) => {
  // Chunk-grain code filters have no page-grain meaning: the SQL engines answer nothing.
  if (opts?.language || opts?.symbolKind) return [];
  const options = keywordOptions('searchTitles', query, opts);
  const cap = searchLimitCap();
  if (opts?.limit && opts.limit > cap) {
    console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${cap}`);
  }
  const limit = clampSearchLimit(opts?.limit, 20, cap);
  const offset = wholeCount('searchTitles', opts?.offset || 0, 'an offset')!;
  const strictQuery = boundWebsearchQuery(query);
  const exactKey = normalizeAlias(query);
  // The given-name variants are ORed into every attempt; the OR retry rebinds only the first text.
  const variants = titleNameVariants(query);
  const titleOnly = options.requireSafeChunks === true;
  const run = async (attempts: TitleAttempt[]): Promise<{ rows: Row[]; cut: boolean }[]> =>
    storeCall({ member: 'searchTitles' }, () => brain.searchTitlesAttempts(
      attempts.map(a => ({ texts: [a.text, ...variants], kind: titleOnly ? 'title' : a.kind, limit: a.limit, offset: a.offset })),
      exactKey, titleWholeVectorCandidates(), options,
    ));

  const top = offset + limit;
  const [strict] = await run([{ text: strictQuery, kind: 'whole', limit: top, offset: 0 }]);
  if (strict.rows.length > 0 && strict.cut) {
    opts?.onKeywordIncomplete?.('candidate_budget');
    const [title] = await run([{ text: strictQuery, kind: 'title', limit: top, offset: 0 }]);
    const titled = new Set(title.rows.map(r => r.page_id));
    return [...title.rows, ...strict.rows.filter(r => !titled.has(r.page_id))].slice(offset, offset + limit).map(rowToSearchResult);
  }
  if (strict.rows.length > offset) return strict.rows.slice(offset).map(rowToSearchResult);
  const orQuery = buildOrFallbackWebsearchQuery(strictQuery);
  if (!orQuery) return [];
  const terms = orFallbackTokens(strictQuery);
  const rarity = terms.length <= RARITY_MAX_TERMS && !opts?.offset;
  const anyWord = boundWebsearchQuery(orQuery);
  const wordAttempts: TitleAttempt[] = rarity ? terms.map(text => ({ text, kind: 'title', limit, offset })) : [];
  const [any, ...words] = await run([{ text: anyWord, kind: 'complete', limit, offset }, ...wordAttempts]);
  const orRows = any.cut ? (await run([{ text: anyWord, kind: 'title', limit, offset }]))[0].rows : any.rows;
  const relaxedRows = (rarity ? rankByRarity(orRows, words.map(w => w.rows), limit) : orRows).map(rowToSearchResult);
  const idents = identifierTokens(query);
  const named = idents ? relaxedRows.filter(r => holdsIdentifiers(r.title, idents)) : [];
  return [...named, ...relaxedRows.filter(r => !named.includes(r)).map(r => ({ ...r, keyword_relaxed: true as const }))];
};
