/**
 * #3986: CJK keyword fallback for the Postgres engine — parity port of the
 * PGLite fallback that has existed since v0.32.7. `websearch_to_tsquery`
 * with an ASCII-stemming FTS config can't tokenize CJK, so keyword recall
 * on Postgres was silently zero for Chinese / Japanese / Korean queries
 * (the vector arm masked it until embeddings were stale or unavailable).
 *
 * SQL builds in the shared `src/core/search/cjk-keyword-sql.ts` (identical
 * text + params on both engines). This module supplies only the executor
 * seam: a narrow runner the engine binds to its scoped read transaction
 * (RLS scope binding + `SET LOCAL statement_timeout`), never the engine
 * class itself.
 *
 * Note: the fallback is an ILIKE scan over content_chunks — correct but
 * not index-accelerated. Deployments with heavy CJK corpora should install
 * a CJK-aware FTS extension (pgroonga / zhparser); see
 * docs/guides/multi-language-fts.md.
 */
import type { SearchResult } from '../types.ts';
import { rowToSearchResult } from '../utils.ts';
import { buildCJKKeywordSql, type CjkKeywordCtx } from '../search/cjk-keyword-sql.ts';

/**
 * Narrow executor dep: runs one positional-param query inside the engine's
 * scoped read transaction and returns raw rows.
 */
export type CjkKeywordRunner = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export async function searchKeywordCJK(
  run: CjkKeywordRunner,
  query: string,
  ctx: CjkKeywordCtx,
): Promise<SearchResult[]> {
  const built = buildCJKKeywordSql(query, ctx);
  if (!built) return [];
  const rows = await run(built.sql, built.params);
  return rows.map(rowToSearchResult);
}
