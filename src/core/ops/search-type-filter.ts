/**
 * Agents guess page types ("company", "account", "deal") that a brain may not
 * have, and a filter on a type with no pages silently hides every page
 * (gbrain-evals Cat 40: type-filtered agent runs failed 62% of tasks against
 * 51% unfiltered). Requested types with no readable pages in scope are
 * dropped, the rest stay; when none remain the filter is lifted. Either way
 * the caller is told which types exist so it can refine.
 *
 * One statement answers it: an `EXISTS` per requested type's
 * schema-expanded set, and the `DISTINCT` type list for the notice, which
 * Postgres evaluates only when a probe came back false (a subplan in an
 * untaken `CASE` branch never runs). It runs with JIT off (LHF wave 2 item
 * 1): the correlated visibility subplans cost past `jit_above_cost`, and
 * LLVM compilation took about half a second per typed search on Postgres.
 * It is planned for its parameters on every call: a cached generic plan
 * cannot tell a missing type from a common one and scans every page for
 * each missing type, where the custom plan reads the type index. `OFFSET 0`
 * keeps each probe evaluated once.
 */
import { expandEngineTypeFilters } from '../schema-pack/query-types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import type { TrustTier } from '../trust/tier.ts';
import type { OperationContext } from './contract.ts';

type SourceScope = { sourceId?: string; sourceIds?: string[]; minTrust?: TrustTier };

export async function reconcileTypeFilter(ctx: OperationContext, scope: SourceScope, excludePrivate: boolean,
  types: string[] | undefined): Promise<{ types: string[] | undefined; notice?: string }> {
  if (!types || scope.sourceIds?.length === 0) return { types };
  // A schema-pack lookup failure propagates: typed reads fail closed rather than fall back to literal types.
  const expanded = await Promise.all(types.map(async type => (await expandEngineTypeFilters(ctx.engine, { types: [type], ...scope })).types ?? [type]));
  const params: unknown[] = [];
  const filter = pageReadFilter('p', { ...scope, excludePrivate }, params, true);
  const probes = expanded.flatMap((set, i) => {
    if (set.length === 0) return [];
    params.push(set);
    return [{ name: `t${i}`, sql: `EXISTS (SELECT 1 FROM pages p WHERE ${filter} AND p.type = ANY($${params.length}::text[])) AS t${i}` }];
  });
  if (probes.length === 0) return { types };
  let row: Record<string, unknown> | undefined;
  try {
    [row] = await ctx.engine.executeRaw(
      `SELECT probe.*, CASE WHEN ${probes.map(p => `probe.${p.name}`).join(' AND ')} THEN NULL
         ELSE ARRAY(SELECT DISTINCT p.type FROM pages p WHERE ${filter} LIMIT 500) END AS available
       FROM (SELECT ${probes.map(p => p.sql).join(', ')} OFFSET 0) probe`, params, { jitOff: true, prepare: false });
  } catch {
    return { types };
  }
  const keep: string[] = [];
  const missing: string[] = [];
  types.forEach((type, i) => (expanded[i].length === 0 || row?.[`t${i}`] === true ? keep : missing).push(type));
  if (missing.length === 0) return { types };
  const available = [...new Set((row?.available ?? []) as string[])].sort().join(', ');
  return keep.length === 0
    ? { types: undefined, notice: `No pages have type ${missing.join(', ')}, so the type filter was dropped and every page type was searched. Page types in this brain: ${available}.` }
    : { types: keep, notice: `No pages have type ${missing.join(', ')}; filtered to ${keep.join(', ')}. Page types in this brain: ${available}.` };
}
