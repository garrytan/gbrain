/**
 * #7191: `get_stats` grouped mode (`by` / `since` / `collapse_aliases`; CLI
 * `gbrain stats --by source,type --since 30d --collapse-aliases`). Grouping
 * rules and the alias collapse: src/core/page-counts.ts; SQL:
 * src/core/engine-sql/page-lookup.ts. Without any of the three params
 * `get_stats` returns its unchanged counters (admin.ts).
 *
 * Scope is the diagnostic ladder `get_stats` already uses (trusted local:
 * every source; remote: the caller's grant). Counts cover live pages in
 * unarchived sources; a remote caller's `readPolicyOpts` policy goes through
 * `pageReadFilter` (private pages, trust floor, quarantine), like other
 * remote reads. Stats do not hide the search hard-exclude prefixes: they
 * count what is stored.
 */
import { collapseTypes, groupPageCounts, parseStatsBy, type StatsByResult, type StatsDimension } from '../page-counts.ts';
import { loadActivePackBestEffort } from '../schema-pack/best-effort.ts';
import { resolveDateBoundary } from '../search/date-bounds.ts';
import type { OperationContext, ParamDef } from './contract.ts';
import { readPolicyOpts } from './context.ts';
import { invalidParam } from './op-fix.ts';

export const STATS_BY_PARAMS: Record<string, ParamDef> = {
  by: { type: 'string', description: "Group page counts: 'source', 'type' or 'source,type'." },
  since: { type: 'string', description: 'Effective date on/after: YYYY-MM-DD or 7d/2w/1y.' },
  collapse_aliases: { type: 'boolean', description: 'Merge near-duplicate type names; lists each group\'s member types.' },
};

const blank = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/** Grouped mode runs when the caller passed any of the grouping params. */
export function wantsStatsBy(p: Record<string, unknown>): boolean {
  return !blank(p.by) || !blank(p.since) || p.collapse_aliases === true;
}

export async function statsBy(
  ctx: OperationContext,
  p: Record<string, unknown>,
  scope: { sourceId?: string; sourceIds?: string[] },
): Promise<StatsByResult> {
  let by: StatsDimension[];
  try {
    by = parseStatsBy(blank(p.by) ? undefined : p.by);
  } catch (e) {
    throw invalidParam(ctx, 'get_stats', 'by', `get_stats: ${(e as Error).message}.`, { example: 'source,type', def: STATS_BY_PARAMS.by });
  }
  let since: string | undefined;
  try {
    since = resolveDateBoundary(blank(p.since) ? undefined : String(p.since), 'since');
  } catch (e) {
    throw invalidParam(ctx, 'get_stats', 'since', `get_stats: ${(e as Error).message}`, { example: '30d', def: STATS_BY_PARAMS.since });
  }
  const pack = p.collapse_aliases === true ? (await loadActivePackBestEffort(ctx))?.manifest ?? null : null;
  const collapseFor = (types: string[]) => (p.collapse_aliases === true ? collapseTypes(types, pack) : null);
  const groupTypes = by.includes('type') && !by.includes('source')
    ? (types: string[]) => { const collapse = collapseFor(types); return types.map((type) => collapse?.get(type)?.group ?? type); }
    : undefined;
  const policy = ctx.remote === false ? undefined : await readPolicyOpts(ctx, scope);
  const counts = await ctx.engine.countPagesBy({
    ...scope,
    since,
    untrusted: policy && { excludePrivate: policy.excludePrivate, minTrust: policy.minTrust, suppressFlagged: policy.suppressFlagged },
  }, groupTypes);
  const collapse = collapseFor([...new Set(counts.bySourceType.map((row) => row.type))]);
  return groupPageCounts(counts, { by, since: since ?? null, collapse });
}
