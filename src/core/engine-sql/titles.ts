/**
 * Page-grain title arm (`BrainEngine.searchTitles`, fix/title-retrieval-arm
 * D1): one implementation for both engines. The statement builds in
 * `src/core/search/title-statement.ts` (shared with the plan-proof E2E, the
 * cjk-search / vector-statement pattern); this module runs it through the
 * engine's scoped read, with the engine's session settings and the OR
 * fallback.
 *
 * Ranks pages whose title matches the websearch query with the same
 * page-grain filters the keyword arm applies (type/types/excludeSlugs/date/
 * source scoping, hard-excludes, visibility), joined to one representative
 * chunk per output page, with the same AND→OR recall fallback as
 * searchKeyword. Ordinary long titles are preserved; oversized pasted context
 * is bounded before websearch FTS.
 *
 * Exact-title key (#5889): every title holding a query term once ties on
 * `ts_rank_cd`, and ties broke by page id, so an identity page titled exactly
 * like the query fell out of the arm's top rows once ~50 other titles
 * contained the word; the exact-lookup tier only sees those rows. Both
 * orderings (the inner `top_pages` LIMIT and the outer projection) now sort
 * `lower(btrim(title, <space, quotes, NBSP>)) = normalizeAlias(query)` first.
 * The normalized query is its own bind parameter, so the OR fallback never
 * rebinds it. The SQL key is a cheap approximation (no internal whitespace
 * collapse: a regexp measured +37 ms); the tier's JS `normalizeAlias` recheck
 * stays authoritative, so a mismatch can only miss, never promote.
 *
 * Title predicate (title FTS; diagnosis credited to PR #5853 by morven-ai):
 * remote callers and every OR re-run match the title alone, which used to mean a per-row
 * `to_tsvector(title)` that no index serves (a scan of every page in scope).
 * `pages.search_vector` carries the title, and only the title, at weight A
 * (schema trigger, `reindex-search-vector`, page-state projection), so the
 * arm matches `search_vector @@ q_a`, where `q_a` is the websearch query
 * with every lexeme labeled `:A`. That is served by `idx_pages_search`, and
 * negated or phrase terms are evaluated on title lexemes only, so timeline
 * text (weight C) never changes which titles they see. Ranking uses the
 * weight-A slice (`ts_filter(..., '{a}')`). Matching follows the language
 * `search_vector` was built with; `gbrain reindex-search-vector` rebuilds it
 * after an FTS language change. A page with a NULL `search_vector` is absent
 * from the arm (the BEFORE INSERT/UPDATE trigger keeps it non-NULL). Local
 * callers' strict query still matches and ranks the whole vector (title weight
 * A dominates); their OR re-run matches titles only, like remote callers,
 * because matching the whole vector let a date in a question pull every dated
 * timeline into `ts_rank_cd`: 3-5 s on a large brain (#7135, diagnosed by
 * @veltri-23 in #7136).
 */
import type { SearchOpts, SearchResult } from '../types.ts';
import { searchLimitCap } from '../search/eval-pool-depth.ts';
import { boundWebsearchQuery, buildOrFallbackWebsearchQuery, orFallbackTokens } from '../search/sql-ranking.ts';
import { buildSearchTitlesStatement, type SearchTitlesDialect } from '../search/title-statement.ts';
import { RARITY_MAX_TERMS } from '../search/keyword-or-rarity.ts';
import { rowToSearchResult } from '../utils.ts';
import type { ScopedRead } from './brands.ts';
import type { ScopedReadRunner } from './cjk-search.ts';

/**
 * `chunkManifest` is the chunkManifestReads probe, run inside each attempt's scoped read after its settings, so the
 * statement timeout bounds it like the title statement (#6495: a probe outside the transaction waited on a lock with
 * no bound) and it answers for the role that read runs as. Unset reads the manifest.
 */
export type SearchTitlesRunDialect = Omit<SearchTitlesDialect, 'chunkManifest'> & {
  chunkManifest?: (exec: ScopedRead) => Promise<boolean>;
  /** Transaction-local settings for every attempt (Postgres: the keyword statement's work_mem, so a common term's bitmap stays exact). */
  statementSettings?: Readonly<Record<string, string>>;
};

export async function searchTitles(
  scoped: ScopedReadRunner,
  query: string,
  opts: SearchOpts | undefined,
  dialect: SearchTitlesRunDialect,
): Promise<SearchResult[]> {
  // language/symbolKind are chunk-grain code filters with no page-grain
  // meaning; a code-scoped query gets no title candidates rather than rows
  // that silently violate the caller's filter.
  if (opts?.language || opts?.symbolKind) return [];
  if (opts?.limit && opts.limit > searchLimitCap()) {
    console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${searchLimitCap()}`);
  }
  const statementFor = (chunkManifest: boolean, relaxed = false) => buildSearchTitlesStatement(query, opts, { ...dialect, chunkManifest, relaxed });
  const statement = statementFor(true);
  /** One scoped read running the statement once per query text ($1), in order. */
  const run = (queryTexts: string[], relaxed: boolean) => {
    const preferIndex = relaxed && dialect.relaxedPrefersIndex && !statement.safeChunks;
    const settings = {
      ...(dialect.statementTimeout ? { statement_timeout: dialect.statementTimeout } : {}),
      ...dialect.statementSettings,
      ...(preferIndex ? { enable_seqscan: 'off' } : {}),
    };
    return scoped(async exec => {
      const sql = statementFor(await dialect.chunkManifest?.(exec) ?? true, relaxed).sql;
      const lists = [];
      for (const text of queryTexts) lists.push((await exec.unsafe(sql, [text, ...statement.params.slice(1)])).rows);
      return lists;
    }, Object.keys(settings).length ? settings : undefined);
  };

  const strictQuery = statement.params[0] as string;
  const [rows] = await run([strictQuery], false);
  if (rows.length > 0) return rows.map(rowToSearchResult);
  const orQuery = buildOrFallbackWebsearchQuery(strictQuery);
  if (!orQuery) return [];
  const terms = orFallbackTokens(strictQuery);
  const rarity = terms.length <= RARITY_MAX_TERMS && !opts?.offset;
  const [orRows, ...wordLists] = await run([boundWebsearchQuery(orQuery), ...(rarity ? terms : [])], true);
  const relaxedRows = rarity ? rankByRarity(orRows, wordLists, statement.params[2] as number) : orRows;
  // 2026-09 (#3617 follow-up): relaxed rows are TAGGED so hybrid's fusion can
  // demote them (SearchResult.keyword_relaxed).
  return relaxedRows.map((r) => ({ ...rowToSearchResult(r), keyword_relaxed: true as const }));
}


/**
 * #7471: the OR fallback ranks every title holding one query word alike
 * (ts_rank_cd knows no term rarity) and breaks the tie by page id, so once
 * thousands of titles held a common word ("Matt"), the one title holding the
 * rare word (the surname) fell out of the arm. A short query also runs once
 * per word. A word with fewer rows than the limit is rare, and all of its
 * titles are known: each weighs 1 / its row count, a title sums the weights
 * of the rare words it holds, and titles sort by that sum, then in the OR
 * query's order. A word that fills the limit weighs nothing, so a query with
 * no rare word keeps the OR query's order exactly.
 */
export function rankByRarity<T extends { page_id?: unknown }>(orRows: T[], wordLists: T[][], limit: number): T[] {
  const weight = new Map<string, number>();
  const pool = [...orRows];
  const seen = new Set(orRows.map(row => String(row.page_id)));
  for (const list of wordLists) {
    if (list.length === 0 || list.length >= limit) continue;
    for (const row of list) {
      const key = String(row.page_id);
      weight.set(key, (weight.get(key) ?? 0) + 1 / list.length);
      if (!seen.has(key)) { seen.add(key); pool.push(row); }
    }
  }
  return pool
    .map((row, i) => ({ row, i, w: weight.get(String(row.page_id)) ?? 0 }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .slice(0, limit)
    .map(e => e.row);
}
