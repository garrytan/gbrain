/**
 * CJK keyword fallback: one executor path for both engines (refactor wave 1,
 * W1-core C14). `websearch_to_tsquery` with an ASCII-stemming FTS config can't
 * tokenize CJK, so both engines route CJK queries here (#3986, PGLite since
 * v0.32.7). The SQL builds once in `src/core/search/cjk-keyword-sql.ts`
 * (identical text + params on both engines) and runs through master's direct
 * `unsafe` path.
 *
 * The read was RLS-scoped on master (EO4 inventory): it takes a `ScopedRead`,
 * supplied by the engine's `scoped` hook only AFTER the SQL built, so an
 * unbuildable query opens no transaction. Postgres's hook runs inside
 * `withScopedReadTransaction` with `SET LOCAL statement_timeout`; PGLite (no
 * RLS layer) brands its own executor.
 *
 * Note: the fallback is an ILIKE scan over content_chunks — correct but not
 * index-accelerated. Deployments with heavy CJK corpora should install a
 * CJK-aware FTS extension (pgroonga / zhparser); see
 * docs/guides/multi-language-fts.md.
 */
import type { SearchResult } from '../types.ts';
import { rowToSearchResult } from '../utils.ts';
import { buildCJKKeywordSql, type CjkKeywordCtx } from '../search/cjk-keyword-sql.ts';
import type { ScopedRead } from './brands.ts';

/** Runs `read` on the engine's scoped read executor. */
export type ScopedReadRunner = <T>(read: (exec: ScopedRead) => Promise<T>) => Promise<T>;

export async function searchKeywordCJK(
  scoped: ScopedReadRunner,
  query: string,
  ctx: CjkKeywordCtx,
): Promise<SearchResult[]> {
  const built = buildCJKKeywordSql(query, ctx);
  if (!built) return [];
  const rows = await scoped(async (exec) => (await exec.unsafe(built.sql, built.params)).rows);
  return rows.map(rowToSearchResult);
}
