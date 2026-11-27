/**
 * The type-filter probe statement (ops/search-type-filter.ts): an `EXISTS` per requested type's schema-expanded set, and
 * the `DISTINCT` type list for the notice, which Postgres evaluates only when a probe came back false (a subplan in an
 * untaken `CASE` branch never runs). `OFFSET 0` keeps each probe evaluated once. One read filter, bound once, serves
 * every probe and the type list, so the statement is built here as text rather than as fragments.
 */
import type { PageReadScope } from '../types.ts';
import { pageReadFilter } from './read-policy-sql.ts';

/** The statement for the non-empty `sets` (probe `t<i>` for set `i`), or null when every set is empty. */
export function pageTypeProbeStatement(sets: readonly (readonly string[])[], scope: PageReadScope): { text: string; params: unknown[] } | null {
  const params: unknown[] = [];
  const filter = pageReadFilter('p', scope, params, true);
  const probes = sets.flatMap((set, i) => {
    if (set.length === 0) return [];
    params.push([...set]);
    return [{ name: `t${i}`, sql: `EXISTS (SELECT 1 FROM pages p WHERE ${filter} AND p.type = ANY($${params.length}::text[])) AS t${i}` }];
  });
  if (probes.length === 0) return null;
  return {
    text: `SELECT probe.*, CASE WHEN ${probes.map(p => `probe.${p.name}`).join(' AND ')} THEN NULL
         ELSE ARRAY(SELECT DISTINCT p.type FROM pages p WHERE ${filter} LIMIT 500) END AS available
       FROM (SELECT ${probes.map(p => p.sql).join(', ')} OFFSET 0) probe`,
    params,
  };
}
