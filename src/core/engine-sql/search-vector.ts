/**
 * Keyword index rebuild (`gbrain reindex-search-vector`): the row inventory, once for both engines. The trigger
 * function replacement, the backfills and the facts keyword index stay in the command (they write).
 *
 * The statement ran on master from `src/commands/reindex-search-vector.ts`. It keeps master's text and runs on
 * master's raw path (`exec.executeRaw`) unscoped, as before.
 */
import type { SqlExecutor } from './executor.ts';

type Exec = Pick<SqlExecutor, 'executeRaw'>;

/** How many pages and chunks hold a keyword vector (the rows a rebuild re-tokenizes). */
export async function countSearchVectorRows(exec: Exec): Promise<{ pages: number; chunks: number }> {
  const counts = await exec.executeRaw<{ pages: number; chunks: number }>(
    // chunk-visibility-ok: the rebuild re-tokenizes every stored chunk row, staged and retired included
    `SELECT
       (SELECT COUNT(*)::int FROM pages WHERE search_vector IS NOT NULL) AS pages,
       (SELECT COUNT(*)::int FROM content_chunks WHERE search_vector IS NOT NULL) AS chunks`
  );
  return { pages: counts[0]?.pages ?? 0, chunks: counts[0]?.chunks ?? 0 };
}
