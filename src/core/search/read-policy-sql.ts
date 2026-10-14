import type { PageReadScope, PageReadPolicy } from '../types.ts';
import { privatePagesFilterFragment } from './private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { currentMemoryPageSql } from '../pmbrain-adapters/memory-projections.ts';

export function hasReadPolicy(scope?: PageReadPolicy): boolean {
  return !!(scope?.sourceIds?.length || scope?.sourceId || scope?.excludePrivate || scope?.takesHoldersAllowList !== undefined);
}

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
  if (live) clauses.push(
    currentMemoryPageSql(alias),
    `${alias}.deleted_at IS NULL`,
    quarantineFilterFragment(alias),
    `EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id = ${alias}.source_id AND NOT read_source.archived)`,
  );
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}
