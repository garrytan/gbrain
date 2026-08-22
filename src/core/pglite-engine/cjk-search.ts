/**
 * v0.32.7: CJK keyword fallback search, peeled out of PGLiteEngine
 * (containment sprint C15). Free functions over a NARROW deps surface — the
 * live PGLite handle only. Never the whole engine class.
 *
 * #3986: the SQL itself now builds in the shared
 * `src/core/search/cjk-keyword-sql.ts` so the Postgres engine's port
 * (`src/core/postgres-engine/cjk-search.ts`) cannot drift from this one.
 * This module keeps its original export surface and only supplies the
 * PGLite executor.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { SearchResult } from '../types.ts';
import { rowToSearchResult } from '../utils.ts';
import { buildCJKKeywordSql, type CjkKeywordCtx } from '../search/cjk-keyword-sql.ts';

/** Narrow slice of PGLiteEngine the CJK search operations use. */
export interface PgliteCjkSearchDeps {
  /** Live PGLite handle. Getter-backed at the call site so the
   *  connect() check fires exactly when the original engine `db` read did. */
  readonly db: PGlite;
}

export async function searchKeywordCJK(
  deps: PgliteCjkSearchDeps,
  query: string,
  ctx: CjkKeywordCtx,
): Promise<SearchResult[]> {
  const built = buildCJKKeywordSql(query, ctx);
  if (!built) return [];
  const { rows } = await deps.db.query(built.sql, built.params);
  return (rows as Record<string, unknown>[]).map(rowToSearchResult);
}
