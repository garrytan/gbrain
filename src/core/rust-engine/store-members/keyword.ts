/**
 * Keyword search members of the keyword_search capability and title trigrams. findByTitleFuzzy, searchKeyword,
 * searchKeywordChunks, countKeywordPages, searchKeywordPages and searchTitles are served. searchTitles rebuilds each
 * page's keyword vector from the sanitized timeline the last seal sent (`pages::search_timeline`).
 *
 * The keyword members resolve every engine default here (the hard-exclude list, the source-boost map, the slug
 * handles, the dash-run collapse, the date bounds) and send the store only predicates; rust/docs/store/keyword.md
 * lists what each member reads, ignores and refuses. `searchKeyword` and `searchTitles` also serve `excludePrivate` (the
 * page policy of private-provenance.ts); the other members refuse it.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import { hasCJK } from '../../cjk.ts';
import { clampSearchLimit } from '../../engine.ts';
import { rankByRarity } from '../../engine-sql/titles.ts';
import { normalizeAlias } from '../../search/alias-normalize.ts';
import { getFtsLanguage } from '../../fts-language.ts';
import { searchLimitCap } from '../../search/eval-pool-depth.ts';
import { slugHandles } from '../../search/keyword-handles.ts';
import { holdsIdentifiers, identifierTokens, keywordArmRows } from '../../search/keyword-identifier-probe.ts';
import {
  RARE_TERM_CHUNK_CAP, RARITY_MAX_TERMS, rankOrFallbackByRarity, type RareTermPages,
} from '../../search/keyword-or-rarity.ts';
import type { KeywordPageWindow } from '../../search/keyword-statement.ts';
import { resolveBoostMap, resolveHardExcludes } from '../../search/source-boost.ts';
import {
  boundWebsearchQuery, buildOrFallbackWebsearchQuery, collapseWebsearchDashRuns, orFallbackTokens,
} from '../../search/sql-ranking.ts';
import { titleNameVariants } from '../../search/title-match.ts';
import { titleWholeVectorCandidates } from '../../search/title-statement.ts';
import type { SearchOpts, SearchResult } from '../../types.ts';
import { rowToSearchResult } from '../../utils.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

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
/** The page filters `searchKeywordChunks` does not apply on PGLite but Postgres does (follow-up pglite-keyword-chunks-page-filters). */
const PAGE_FILTERS = ['type', 'types', 'where', 'exclude_slugs'] as const;
/** Visibility options the store cannot apply (safe chunks on their own, the trust floor, flag suppression). */
const VISIBILITY = ['requireSafeChunks', 'minTrust', 'suppressFlagged'] as const;
/** The members that serve `excludePrivate` (as the page policy of private-provenance.ts, with the safe-chunks rule it turns on). */
const PRIVATE_PAGES_MEMBERS: readonly Member[] = ['searchKeyword', 'searchTitles'];

type Member = 'searchKeyword' | 'searchKeywordChunks' | 'countKeywordPages' | 'searchKeywordPages' | 'searchTitles';

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
      refuseMember(member, `option ${key} (follow-up pglite-keyword-chunks-page-filters)`);
    }
    // `excludePrivate` turns on the safe-chunks rule (`requiresSafeChunks`: `requireSafeChunks ?? excludePrivate`), so a
    // `requireSafeChunks` beside it is the same rule when true, and switches it off when false (read below).
    if (PRIVATE_PAGES_MEMBERS.includes(member) && o.excludePrivate && (key === 'excludePrivate' || key === 'requireSafeChunks')) continue;
    if ((VISIBILITY as readonly string[]).includes(key) || key === 'excludePrivate') {
      if (!value) continue;
      refuseMember(member, `option ${key}`);
    }
    refuseMember(member, `option ${key}`);
  }

  const out: Record<string, unknown> = {};
  if (PRIVATE_PAGES_MEMBERS.includes(member) && o.excludePrivate) {
    // `buildVisibilityClause`: the page policy, and the safe-chunks rule unless `requireSafeChunks` says otherwise. A caller
    // whose policy is wider than the store's refuses (private-provenance.ts).
    out.excludePrivate = storePagePolicy(member, o.excludePrivate);
    out.requireSafeChunks = o.requireSafeChunks ?? true;
  }
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
  options.innerLimit = Math.min((offset + limit) * 3, cap * 3);
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

type TitleKind = 'whole' | 'title' | 'complete';
type TitleAttempt = { text: string; kind: TitleKind; limit: number; offset: number };

/**
 * engine-sql/titles.ts `searchTitles`: the strict attempt over the whole vector (completed by the title-only attempt
 * when more pages match than `titleWholeVectorCandidates()`), then the any-word retry with per-word rarity and the
 * identifier lead. Each store call runs its attempts over one read, as each scoped read of the SQL engines does.
 * `excludePrivate` serves as the page policy with the safe-chunks rule it turns on (`requireSafeChunks ?? excludePrivate`).
 * That rule makes the SQL statement match and rank the title lexemes alone, uncapped (`titleOnly` in title-statement.ts),
 * so every attempt reads the title vector and none is cut. A `requireSafeChunks` of true without `excludePrivate` refuses.
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
