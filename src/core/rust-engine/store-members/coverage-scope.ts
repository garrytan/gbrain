/** The store's reading of a `ProjectionReadinessScope`; a helper shared by the coverage and doctor-search members (not a member itself). */
import type { ProjectionReadinessScope } from '../../search/projection-readiness.ts';
import { storePagePolicy } from './private-provenance.ts';

export function coverageScope(member: string, scope: ProjectionReadinessScope = {}) {
  return {
    sourceId: scope.sourceId ?? null,
    sourceIds: scope.sourceIds ? [...scope.sourceIds] : null,
    excludePrivate: storePagePolicy(member, scope.excludePrivate, { callerReaders: true }) ?? null,
    pageKind: scope.pageKind ?? null,
    types: scope.types ? [...scope.types] : null,
    excludeSlugPrefixes: [...(scope.excludeSlugPrefixes ?? [])],
    minTrust: scope.minTrust || null,
    suppressFlagged: scope.suppressFlagged === true,
  };
}
