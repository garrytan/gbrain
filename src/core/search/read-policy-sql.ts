import type { BrainEngine } from '../engine.ts';
import type { PageReadScope, PageReadPolicy } from '../types.ts';
import { privatePagesFilterFragment } from './private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { pageEligibleSql } from '../eligibility/sql.ts';

/** Preserve unrestricted local reads while retaining source-only restrictions. */
export function hasReadPolicy(scope?: PageReadPolicy): boolean {
  return !!(scope?.sourceIds?.length || scope?.sourceId || scope?.excludePrivate || scope?.requireSafeChunks || scope?.takesHoldersAllowList !== undefined
    || scope?.minTrust || scope?.suppressFlagged);
}

/** Callers supply fixed SQL aliases; all policy values are bound parameters. */
export function pageReadFilter(
  alias: string,
  scope: PageReadScope | undefined,
  params: unknown[],
  live = false,
): string {
  const clauses: string[] = [];
  if (scope?.sourceIds?.length) {
    params.push(scope.sourceIds);
    clauses.push(`${alias}.source_id = ANY($${params.length}::text[])`);
  } else if (scope?.sourceId) {
    params.push(scope.sourceId);
    clauses.push(`${alias}.source_id = $${params.length}`);
  }
  if (scope?.excludePrivate) clauses.push(privatePagesFilterFragment(alias));
  if (scope?.minTrust || scope?.suppressFlagged) clauses.push(pageEligibleSql(alias, { floor: scope.minTrust, suppressFlagged: scope.suppressFlagged }));
  if (live) clauses.push(
    `${alias}.deleted_at IS NULL`,
    quarantineFilterFragment(alias),
    `EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id = ${alias}.source_id AND NOT read_source.archived)`,
  );
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}

/** The `(source_id, slug)` identity of a page as one map key; an absent source is `default`. */
export const pageKey = (sourceId: string | null | undefined, slug: string): string => `${sourceId ?? 'default'}\u0000${slug}`;

/**
 * Live readability of the pages this brain holds among `refs`, keyed by
 * pageKey. A key with no entry is a page this brain does not hold; a
 * held page that is deleted, quarantined or outside `scope` maps to false.
 */
export async function pageReadability(engine: Pick<BrainEngine, 'executeRaw'>, refs: ReadonlyArray<{ slug: string; source_id: string }>,
  scope: PageReadScope | undefined): Promise<Map<string, boolean>> {
  const slugs = [...new Set(refs.map(r => r.slug))];
  if (!slugs.length) return new Map();
  const params: unknown[] = [slugs];
  const filter = pageReadFilter('p', scope, params, true);
  const rows = await engine.executeRaw<{ slug: string; source_id: string; readable: boolean }>(
    `SELECT p.slug, p.source_id, (${filter}) AS readable FROM pages p WHERE p.slug = ANY($1::text[])`, params);
  return new Map(rows.map(r => [pageKey(r.source_id, r.slug), r.readable === true]));
}
