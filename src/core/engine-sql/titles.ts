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
 * Remote predicate (title FTS; diagnosis credited to PR #5853 by morven-ai):
 * safe-chunks callers must match the title alone, which used to mean a
 * per-row `to_tsvector(title)` that no index serves (a scan of every page in
 * scope). `pages.search_vector` carries the title, and only the title, at
 * weight A (schema trigger, `reindex-search-vector`, page-state projection),
 * so the remote arm matches `search_vector @@ q_a`, where `q_a` is the
 * websearch query with every lexeme labeled `:A`. That is served by
 * `idx_pages_search`, and negated or phrase terms are evaluated on title
 * lexemes only, so timeline text can never change which titles a remote
 * caller sees. Ranking uses the weight-A slice (`ts_filter(..., '{a}')`).
 * Remote matching follows the language `search_vector` was built with;
 * `gbrain reindex-search-vector` rebuilds it after an FTS language change.
 * A page with a NULL `search_vector` is absent from the remote arm (the
 * BEFORE INSERT/UPDATE trigger keeps it non-NULL). The local arm keeps
 * ranking the whole `search_vector` (title weight A dominates).
 */
import type { SearchOpts, SearchResult } from '../types.ts';
import { searchLimitCap } from '../search/eval-pool-depth.ts';
import { boundWebsearchQuery, buildOrFallbackWebsearchQuery } from '../search/sql-ranking.ts';
import { buildSearchTitlesStatement, type SearchTitlesDialect } from '../search/title-statement.ts';
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
  const statementFor = (chunkManifest: boolean) => buildSearchTitlesStatement(query, opts, { ...dialect, chunkManifest });
  const statement = statementFor(true);
  const run = (queryText: string, relaxed: boolean) => {
    const preferIndex = relaxed && dialect.relaxedPrefersIndex && !statement.safeChunks;
    const settings = {
      ...(dialect.statementTimeout ? { statement_timeout: dialect.statementTimeout } : {}),
      ...(preferIndex ? { enable_seqscan: 'off' } : {}),
    };
    const params = [...statement.params];
    params[0] = queryText;
    return scoped(async exec => (await exec.unsafe(statementFor(await dialect.chunkManifest?.(exec) ?? true).sql, params)).rows,
      Object.keys(settings).length ? settings : undefined);
  };

  const strictQuery = statement.params[0] as string;
  const rows = await run(strictQuery, false);
  if (rows.length > 0) return rows.map(rowToSearchResult);
  const orQuery = buildOrFallbackWebsearchQuery(strictQuery);
  if (!orQuery) return [];
  // 2026-09 (#3617 follow-up): relaxed rows are TAGGED so hybrid's fusion can
  // demote them (SearchResult.keyword_relaxed).
  const relaxedRows = await run(boundWebsearchQuery(orQuery), true);
  return relaxedRows.map((r) => ({ ...rowToSearchResult(r), keyword_relaxed: true as const }));
}
