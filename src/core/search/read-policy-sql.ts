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
