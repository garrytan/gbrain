import type { PageReadScope, PageReadPolicy } from '../types.ts';
import { privatePagesFilterForCaller } from './private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { pageEligibleSql } from '../eligibility/sql.ts';

/** Preserve unrestricted local reads while retaining source-only restrictions. */
export function hasReadPolicy(scope?: PageReadPolicy): boolean {
  return !!(scope?.sourceIds?.length || scope?.sourceId || scope?.excludePrivate || scope?.requireSafeChunks || scope?.takesHoldersAllowList !== undefined
    || scope?.minTrust || scope?.suppressFlagged);
}

const READ_POLICY_KEYS = ['sourceId', 'sourceIds', 'excludePrivate', 'requireSafeChunks', 'minTrust', 'suppressFlagged', 'takesHoldersAllowList'] as const satisfies ReadonlyArray<keyof PageReadPolicy>;
/** Fails to compile when PageReadPolicy gains a key READ_POLICY_KEYS does not list. */
const READ_POLICY_KEYS_COMPLETE: Exclude<keyof PageReadPolicy, (typeof READ_POLICY_KEYS)[number]> extends never ? true : never = true;
void READ_POLICY_KEYS_COMPLETE;

/**
 * Only the page read policy of a wider options object, or undefined when it restricts nothing.
 * Pass this, never the wider object: an engine that refuses option keys it does not model
 * would refuse the whole read.
 */
export function readPolicyOf(opts?: PageReadPolicy): PageReadPolicy | undefined {
  if (!opts || !hasReadPolicy(opts)) return undefined;
  const policy: Record<string, unknown> = {};
  for (const key of READ_POLICY_KEYS) if (opts[key] !== undefined) policy[key] = opts[key];
  return policy as PageReadPolicy;
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
  if (scope?.excludePrivate) clauses.push(privatePagesFilterForCaller(alias));
  if (scope?.minTrust || scope?.suppressFlagged) clauses.push(pageEligibleSql(alias, { floor: scope.minTrust, suppressFlagged: scope.suppressFlagged }));
  if (live) clauses.push(
    `${alias}.deleted_at IS NULL`,
    quarantineFilterFragment(alias),
    `EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id = ${alias}.source_id AND NOT read_source.archived)`,
  );
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}
