/**
 * Keyword index rebuild (`gbrain reindex-search-vector`): the row inventory
 * and the trigger function replacement, once for both engines. The backfills
 * and the facts keyword index stay in search-vector-backfill.ts and
 * facts/fts-index.ts (shared with migrations); each engine member calls them.
 *
 * Every statement here ran on master from the caller named on its function.
 * They keep master's text and run on master's raw path (`exec.executeRaw`)
 * unscoped, as before. A caller that swallowed a database error still does;
 * a refused capability is never swallowed (engine-capability-refusal.ts).
 */
import { chunkSearchVectorTriggerFnSql, pageSearchVectorTriggerFnSql } from '../fts-language.ts';
import { FUNCTION_SEARCH_PATH_HARDENING_SQL } from '../function-search-path.ts';
import type { SqlExecutor } from './executor.ts';

type Exec = Pick<SqlExecutor, 'executeRaw'>;

/** How many pages and chunks hold a keyword vector (the rows a rebuild re-tokenizes). */
export async function countSearchVectorRows(exec: Exec): Promise<{ pages: number; chunks: number }> {
  const counts = await exec.executeRaw<{ pages: number; chunks: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM pages WHERE search_vector IS NOT NULL) AS pages,
       (SELECT COUNT(*)::int FROM content_chunks WHERE search_vector IS NOT NULL) AS chunks -- chunk-visibility-ok: the rebuild re-tokenizes every stored chunk row, staged and retired included`
  );
  return { pages: counts[0]?.pages ?? 0, chunks: counts[0]?.chunks ?? 0 };
}

/**
 * Recreate one keyword trigger function under `lang`. The chunks function goes second and also puts pg_temp back
 * last on both functions' search_path (CREATE OR REPLACE reset it, #7632, function-search-path.ts).
 */
export async function replaceSearchVectorTriggerFunction(exec: Exec, target: 'pages' | 'chunks', lang: string): Promise<void> {
  if (target === 'pages') {
    await exec.executeRaw(pageSearchVectorTriggerFnSql(lang));
    return;
  }
  await exec.executeRaw(chunkSearchVectorTriggerFnSql(lang));
  await exec.executeRaw(FUNCTION_SEARCH_PATH_HARDENING_SQL);
}
