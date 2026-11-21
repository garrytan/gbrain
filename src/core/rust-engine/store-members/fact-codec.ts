/**
 * Fact row helpers shared by the facts store members. This module holds no members: index.ts spreads every export of a
 * member module into STORE_MEMBERS, so shared helpers live here and not in a member module.
 */
import { escapeLikePattern } from '../../cjk.ts';
import { privateProvenanceFilterUnderPolicy } from '../../search/private-visibility.ts';
import type { FactPoolFilters, FactPoolScope } from '../../engine-sql/facts-trust.ts';
import { storePrivacyPolicy } from './private-provenance.ts';
import { storeVisibility } from './fact-visibility.ts';

type Row = Record<string, unknown>;

export const FACT_DATES = ['valid_from', 'valid_until', 'expired_at', 'consolidated_at', 'embedded_at', 'created_at'] as const;
/** A returned vector (a number list or null) as the `Float32Array` PGLite hands back. */
export const withVector = (row: Row): Row =>
  Array.isArray(row.embedding) ? { ...row, embedding: new Float32Array(row.embedding as number[]) } : row;

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
    ...(filters?.since ? { since: filters.since.toISOString() } : {}),
    ...(grep ? { grep: `%${escapeLikePattern(grep)}%` } : {}),
    includeExpired: filters?.includeExpired === true,
  };
}
