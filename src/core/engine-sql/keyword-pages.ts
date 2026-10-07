/**
 * Page-grain keyword reads for `search` (Cat 40 Hard F2): the strict match
 * count and the keyword-mode page query, one implementation for both
 * engines. The statements build in `src/core/search/keyword-statement.ts`
 * from one WHERE builder; this module runs them through the engine's scoped
 * read (Postgres: `withScopedReadTransaction`, so RLS scope binding and
 * `SET LOCAL` settings stay transaction-scoped; PGLite brands its own
 * executor). Neither read retries with OR-of-terms: they report the strict
 * match set only.
 */
import type { SearchOpts, SearchResult } from '../types.ts';
import { rowToSearchResult } from '../utils.ts';
import { buildKeywordCountStatement, buildKeywordPagesStatement, type KeywordPageWindow } from '../search/keyword-statement.ts';
import type { ScopedReadRunner } from './cjk-search.ts';

/** Engine session settings: Postgres bounds each read with a statement timeout; PGLite has none. */
export interface KeywordPagesDialect { statementTimeout?: string }

/** Distinct pages matching the strict keyword query, at most KEYWORD_COUNT_CAP + 1. */
export async function countKeywordPages(
  scoped: ScopedReadRunner, query: string, opts: SearchOpts | undefined, dialect: KeywordPagesDialect & { timeoutMs?: number },
): Promise<number> {
  const statement = buildKeywordCountStatement(query, opts);
  if (!statement) return 0;
  const timeout = dialect.statementTimeout && dialect.timeoutMs ? `${Math.max(1, Math.floor(dialect.timeoutMs))}ms` : dialect.statementTimeout;
  const rows = await scoped(async (exec) => {
    if (timeout) await exec.query(`SELECT set_config('statement_timeout', $1, true)`, [timeout]);
    return (await exec.unsafe<{ n: number }>(statement.sql, statement.params)).rows;
  });
  return Number(rows[0]?.n ?? 0);
}

/** One window of matching pages (best chunk each) in (score DESC, page_id ASC) order. */
export async function searchKeywordPages(
  scoped: ScopedReadRunner, query: string, opts: SearchOpts | undefined, page: KeywordPageWindow, dialect: KeywordPagesDialect,
): Promise<SearchResult[]> {
  const statement = buildKeywordPagesStatement(query, opts, page);
  if (!statement) return [];
  const rows = await scoped(async (exec) => {
    if (dialect.statementTimeout) await exec.query(`SELECT set_config('statement_timeout', $1, true)`, [dialect.statementTimeout]);
    return (await exec.unsafe(statement.sql, statement.params)).rows;
  });
  return rows.map(rowToSearchResult);
}
