/**
 * The frontmatter `where` check on finished search rows (search/frontmatter-where.ts keepFrontmatterMatches): the
 * page ids among `ids` whose frontmatter holds every key. One indexed read over the ids; the clauses are
 * frontmatterWhereFragment's (the text frontmatterWhereSql composes), values bound, so both SQL engines send the
 * text the search op sent before this member (pinned in test/engine-sql-caller-raw-sql-pins.test.ts).
 */
import { frontmatterWhereFragment, type FrontmatterWhere } from '../search/frontmatter-where.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment } from './fragment.ts';

export type { FrontmatterWhere } from '../search/frontmatter-where.ts';

/** The matching page ids, in no set order. A soft-deleted page counts: the read has no other predicate. */
export async function filterPageIdsByFrontmatter(raw: EngineRawRead, ids: number[], where: FrontmatterWhere): Promise<number[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id FROM pages p WHERE p.id = ANY(${ids}::bigint[])${frontmatterWhereFragment(where)}`);
  const rows = await raw<{ id: number | string }>(text, params);
  return rows.map(r => Number(r.id));
}
