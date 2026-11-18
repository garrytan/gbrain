/**
 * Keyword search members of the keyword_search capability and title trigrams. findByTitleFuzzy, searchKeyword,
 * searchKeywordChunks, countKeywordPages and searchKeywordPages are served; searchTitles still refuses with `engine_capability_missing`
 * until this file exports it (docs/designs/RUST_ENGINE_INTERFACES.md).
 *
 * The keyword members resolve every engine default here (the hard-exclude list, the source-boost map, the slug
 * handles, the dash-run collapse, the date bounds) and send the store only predicates; rust/docs/store/keyword.md
 * lists what each member reads, ignores and refuses.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import { hasCJK } from '../../cjk.ts';
import { clampSearchLimit } from '../../engine.ts';
import { getFtsLanguage } from '../../fts-language.ts';
import { searchLimitCap } from '../../search/eval-pool-depth.ts';
import { slugHandles } from '../../search/keyword-handles.ts';
import { keywordArmRows } from '../../search/keyword-identifier-probe.ts';
import { RARE_TERM_CHUNK_CAP, rankOrFallbackByRarity, type RareTermPages } from '../../search/keyword-or-rarity.ts';
import type { KeywordPageWindow } from '../../search/keyword-statement.ts';
import { resolveBoostMap, resolveHardExcludes } from '../../search/source-boost.ts';
import { collapseWebsearchDashRuns } from '../../search/sql-ranking.ts';
import type { SearchOpts, SearchResult } from '../../types.ts';
import { rowToSearchResult } from '../../utils.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

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

/** Options no keyword statement reads: hybrid-search, vector and reporting knobs. */
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
/** The page filters `searchKeywordChunks` does not apply on PGLite but Postgres does (follow-up keyword-chunks-page-filters). */
const PAGE_FILTERS = ['type', 'types', 'where', 'exclude_slugs'] as const;
/** Visibility options the store cannot apply (private pages, safe chunks, the trust floor). */
const VISIBILITY = ['excludePrivate', 'requireSafeChunks', 'minTrust', 'suppressFlagged'] as const;

type Member = 'searchKeyword' | 'searchKeywordChunks' | 'countKeywordPages' | 'searchKeywordPages';

/** Checks every option `member` gets, refusing one it cannot answer exactly, and returns the store options. */
function keywordOptions(member: Member, query: string, opts: (SearchOpts & { timeoutMs?: number }) | undefined): Record<string, unknown> {
  if (typeof query !== 'string') refuseMember(member, 'a query that is not a string');
  if (hasCJK(query)) refuseMember(member, 'a CJK query (follow-up keyword-cjk)');
  if (getFtsLanguage() !== 'english') refuseMember(member, `the ${getFtsLanguage()} text search configuration`);
  const o = (opts ?? {}) as Record<string, unknown>;
  const pageGrain = member !== 'searchKeywordChunks';
  for (const [key, value] of Object.entries(o)) {
    if (value === undefined || value === false || NOT_READ.has(key) || SHARED.has(key)) continue;
    if (key === 'limit' || key === 'offset') continue;
    if (key === 'timeoutMs' && member === 'countKeywordPages') continue;
    if (pageGrain && (key === 'keywordPhrase' || (PAGE_FILTERS as readonly string[]).includes(key))) continue;
    if (!pageGrain && (PAGE_FILTERS as readonly string[]).includes(key)) {
      // PGLite ignores these on searchKeywordChunks and Postgres applies them: refuse rather than pick one.
      const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0)
        || (key === 'where' && typeof value === 'object' && Object.keys(value as object).length === 0);
      if (empty) continue;
      refuseMember(member, `option ${key} (follow-up keyword-chunks-page-filters)`);
    }
    if ((VISIBILITY as readonly string[]).includes(key)) {
      if (!value) continue;
      refuseMember(member, `option ${key}`);
    }
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
  if (pageGrain) {
    if (o.type) out.type = String(o.type);
    if ((o.types as string[] | undefined)?.length) out.types = (o.types as string[]).map(String);
    if (o.where) out.where = whereFields(member, o.where);
    if ((o.exclude_slugs as string[] | undefined)?.length) out.excludeSlugs = (o.exclude_slugs as string[]).map(String);
    if (o.keywordPhrase === true) out.phrase = true;
  }
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

/** `frontmatterWhereSql`'s containment forms per key: the value, and a numeric or boolean reading of a string. */
function whereFields(member: Member, where: unknown): [string, unknown[]][] {
  if (typeof where !== 'object' || where === null || Array.isArray(where)) refuseMember(member, 'a where that is not an object');
  return Object.entries(where as Record<string, unknown>).map(([key, values]) => {
    // The SQL engines read a normalized where (every key a non-empty list); anything else fails there.
    if (!Array.isArray(values) || values.length === 0) refuseMember(member, `where.${key} that is not a non-empty list`);
    const forms: unknown[] = [];
    for (const v of values) {
      if (!(typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) {
        refuseMember(member, `where.${key} value that is not a string, number or boolean`);
      }
      forms.push(v);
      if (typeof v === 'string') {
        if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)) forms.push(Number(v));
        if (v === 'true' || v === 'false') forms.push(v === 'true');
      }
    }
    return [key, forms];
  });
}

// `$n::text::timestamptz` with TimeZone UTC, for the ISO shapes: a date, or a date and time with an optional
// fraction and zone. Postgres reads many more shapes; those refuse.
const ISO_DATE = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?)?\s*$/;

/** A date bound as UTC microseconds (decimal text), or a refusal for a shape the store does not parse. */
function dateMicros(member: Member, raw: unknown): string {
  const m = typeof raw === 'string' ? ISO_DATE.exec(raw) : null;
  if (!m) refuseMember(member, 'a date bound that is not an ISO date or date-time');
  const [year, month, day, hour = 0, minute = 0, second = 0] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(v => (v === undefined ? undefined : Number(v))) as number[];
  const monthDays = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  const midnight = hour === 24 && minute === 0 && second === 0 && !Number(m[7] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > monthDays || (hour > 23 && !midnight) || minute > 59 || second > 59) {
    refuseMember(member, 'a date bound outside the calendar');
  }
  let offsetMinutes = 0;
  const zone = m[8];
  if (zone && zone !== 'Z' && zone !== 'z') {
    const digits = zone.slice(1).replace(':', '');
    const hh = Number(digits.slice(0, 2));
    const mm = digits.length > 2 ? Number(digits.slice(2)) : 0;
    if (hh > 15 || mm > 59) refuseMember(member, 'a date bound with an offset outside ±15:59');
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (hh * 60 + mm);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute - offsetMinutes, second, 0);
  const fraction = BigInt((m[7] ?? '').padEnd(6, '0') || '0');
  return (BigInt(date.getTime()) * 1000n + fraction).toString();
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** A row count the SQL engines bind as a bigint: refuse what Postgres would reject (fractions, negatives). */
function wholeCount(member: Member, value: unknown, what: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) refuseMember(member, `${what} that is not a whole number of 0 or more`);
  return value;
}

export const searchKeywordChunks: StoreMember<[query: string, opts?: SearchOpts], SearchResult[]> = async (brain, query, opts) => {
  const options = keywordOptions('searchKeywordChunks', query, opts);
  const cap = searchLimitCap();
  if (opts?.limit && opts.limit > cap) {
    console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${cap}`);
  }
  options.limit = clampSearchLimit(opts?.limit, 20, cap);
  options.offset = wholeCount('searchKeywordChunks', opts?.offset || 0, 'an offset');
  const rows: Record<string, unknown>[] = await storeCall({ member: 'searchKeywordChunks' },
    () => brain.searchKeywordChunks(collapseWebsearchDashRuns(query), options));
  return rows.map(rowToSearchResult);
};

export const countKeywordPages: StoreMember<[query: string, opts?: SearchOpts & { timeoutMs?: number }], number> = async (brain, query, opts) => {
  const options = keywordOptions('countKeywordPages', query, opts);
  if (query.trim() === '') return 0;
  options.handles = slugHandles(query, true) ?? [];
  return Number(await storeCall({ member: 'countKeywordPages' }, () => brain.countKeywordPages(query, options)));
};

export const searchKeywordPages: StoreMember<[query: string, opts: SearchOpts | undefined, page: KeywordPageWindow], SearchResult[]> =
  async (brain, query, opts, page) => {
    const options = keywordOptions('searchKeywordPages', query, opts);
    if (query.trim() === '') return [];
    options.handles = slugHandles(query, true) ?? [];
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

type Row = Record<string, unknown>;

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
  options.innerLimit = Math.min(limit * 3, cap * 3);
  options.offset = offset;
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
