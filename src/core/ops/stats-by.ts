/**
 * #7191: `get_stats` grouped mode (`by` / `since` / `collapse_aliases`; CLI
 * `gbrain stats --by source,type --since 30d --collapse-aliases`). Grouping
 * rules and the alias collapse: src/core/page-counts.ts; SQL:
 * src/core/engine-sql/page-lookup.ts. Without any of the three params
 * `get_stats` returns its unchanged counters (admin.ts).
 *
 * Scope is the diagnostic ladder `get_stats` already uses (trusted local:
 * every source; remote: the caller's grant). Counts cover live pages in
 * unarchived sources; a remote caller's (or a local `--as <member>` preview's) `readPolicyOpts` policy goes through
 * `pageReadFilter` (private pages, trust floor, quarantine), like other
 * remote reads. Stats do not hide the search hard-exclude prefixes: they
 * count what is stored.
 */
import { collapseTypes, groupPageCounts, parseStatsBy, type StatsByResult, type StatsDimension } from '../page-counts.ts';
import type { UntrustedReadPolicy } from '../page-find.ts';
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
  const counts = await ctx.engine.countPagesBy({ ...scope, since, untrusted: await countReadPolicy(ctx, scope) }, groupTypes);
  const collapse = collapseFor([...new Set(counts.bySourceType.map((row) => row.type))]);
  return groupPageCounts(counts, { by, since: since ?? null, collapse });
}

/** The read policy page counts apply: none for a trusted local caller, else the caller's `readPolicyOpts` policy. */
async function countReadPolicy(ctx: OperationContext, scope: { sourceId?: string; sourceIds?: string[] }): Promise<UntrustedReadPolicy | undefined> {
  const policy = ctx.remote === false && !ctx.applyRemoteReadPolicy ? undefined : await readPolicyOpts(ctx, scope);
  return policy && { excludePrivate: policy.excludePrivate, minTrust: policy.minTrust, suppressFlagged: policy.suppressFlagged };
}

/**
 * GBRA-449: the page types this caller can read in `scope`, most pages first
 * (ties by name), counted over the same live, visible pages as `get_stats`
 * by type. Pages with no type are left out. get_backlinks accepts these as a
 * `type` filter, and an empty list_pages names them.
 */
export async function visiblePageTypes(ctx: OperationContext, scope: { sourceId?: string; sourceIds?: string[] }): Promise<Array<{ type: string; pages: number }>> {
  if (scope.sourceIds?.length === 0) return [];
  const counts = await ctx.engine.countPagesBy({ ...scope, untrusted: await countReadPolicy(ctx, scope) });
  const byType = new Map<string, number>();
  for (const row of counts.bySourceType) if (row.type) byType.set(row.type, (byType.get(row.type) ?? 0) + row.pages);
  return [...byType].map(([type, pages]) => ({ type, pages })).sort((a, b) => b.pages - a.pages || a.type.localeCompare(b.type));
}
