/**
 * The fact pool's scope and filters as the store reads them. This module holds no members: index.ts spreads every export
 * of a member module into STORE_MEMBERS, so the helper the pool members share lives here (facts-trust.ts, facts-recall.ts).
 */
import { escapeLikePattern } from '../../cjk.ts';
import { privateProvenanceFilterUnderPolicy } from '../../search/private-visibility.ts';
import type { FactPoolFilters, FactPoolScope } from '../../engine-sql/facts-trust.ts';
import { storePrivacyPolicy } from './private-provenance.ts';
import { storeVisibility } from './fact-visibility.ts';

type Row = Record<string, unknown>;

/** The pool's scope and filters as the store reads them, or a refusal for a policy it cannot answer. */
export function poolArgs(member: string, scope: FactPoolScope, filters: FactPoolFilters | undefined): Row {
  // A world-only pool is widened per row for the caller's member page and private-facts grant, as the fact lists are.
  const widen = scope.worldOnly ? storeVisibility(member, ['world']).widen : undefined;
  const grep = filters?.grep?.trim();
  return {
    sourceIds: [...new Set(scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'])],
    worldOnly: scope.worldOnly,
    ...(widen ? { widen } : {}),
    // A caller with a reader identity and a private-readable grant is served (`callerReaders`).
    excludePrivate: storePrivacyPolicy(member, scope.excludePrivate, () => privateProvenanceFilterUnderPolicy('facts'), { callerReaders: true }),
    minTrust: scope.minTrust || null,
    suppressFlagged: scope.suppressFlagged === true,
    ...(filters?.entities ? { entities: filters.entities.map(e => ({ sourceId: e.sourceId, slug: e.slug })) } : {}),
    ...(filters?.sessionId ? { sessionId: filters.sessionId } : {}),
    ...(filters?.since ? { since: filters.since.toISOString(), ...(filters.includeUndated ? { includeUndated: true } : {}) } : {}),
    ...(grep ? { grep: `%${escapeLikePattern(grep)}%` } : {}),
    includeExpired: filters?.includeExpired === true,
  };
}
