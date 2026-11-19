/**
 * The reads `remember` and `forget` make before admission (src/core/engine-sql/memory-mutation-reads.ts), served from
 * the store (rust/crates/gbrain-store/src/memory_mutation_reads.rs): `readSourceWriteRow` and `readSourceLocalPath`
 * over the source record, `readFactEntitySlug`, `factReadableUnder` and `readRemoteForgetTier` over the fact rows,
 * and `hasLiveFileBackedPage` over the page records.
 *
 * Refused (`engine_capability_missing`):
 *  - a fact id that is not an integer, rather than guess at Postgres's bind error;
 *  - `factReadableUnder` for a caller whose world visibility rule a member page or a private-facts grant widens
 *    (factVisibilitySql is then more than `visibility IN ('world')`), and under `excludePrivate` for a caller whose
 *    policy `storePrivacyPolicy` refuses;
 *  - `readRemoteForgetTier` under `remoteFloor` for a caller whose remote provenance floor (remoteProvenanceFloorSql)
 *    is none of the forms the store models: the floor with no caller record, or a caller record on a brain with or
 *    without member-access restrictions, for the owner or not, at the caller's schema version. A labelled-only caller,
 *    folder coverage or a relaxed privacy setting renders other text.
 */
import type { BrainEngine } from '../../engine.ts';
import { factVisibilitySql } from '../../access/member-facts.ts';
import {
  currentCallerAccess, privacyAliasSql, privateProvenanceFilterUnderPolicy, remoteProvenanceFloorSql, withCallerAccess, withoutCallerAccess,
} from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { normalizeConceptInputs, storePrivacyPolicy } from './private-provenance.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/** The world rule with no member page or grant widening it, which the store models. */
const WORLD_ONLY = "facts.visibility IN ('world')";

function requireInteger(member: string, value: number): void {
  if (!Number.isSafeInteger(value)) refuseMember(member, 'a fact id that is not an integer');
}

export const readSourceWriteRow: Member<'readSourceWriteRow'> = (brain, sourceId) =>
  storeCall({ member: 'readSourceWriteRow' }, () => brain.readSourceWriteRow(sourceId));

export const readSourceLocalPath: Member<'readSourceLocalPath'> = (brain, sourceId) =>
  storeCall({ member: 'readSourceLocalPath' }, () => brain.readSourceLocalPath(sourceId));

export const readFactEntitySlug: Member<'readFactEntitySlug'> = (brain, id, sourceId) => {
  requireInteger('readFactEntitySlug', id);
  return storeCall({ member: 'readFactEntitySlug' }, () => brain.readFactEntitySlug(id, sourceId));
};

export const hasLiveFileBackedPage: Member<'hasLiveFileBackedPage'> = (brain, sourceId, slugs) =>
  storeCall({ member: 'hasLiveFileBackedPage' }, () => brain.hasLiveFileBackedPage(sourceId, [...slugs]));

export const factReadableUnder: Member<'factReadableUnder'> = (brain, spec) => {
  const member = 'factReadableUnder';
  requireInteger(member, spec.id);
  if (!spec.anyVisibility && factVisibilitySql('facts', ['world']) !== WORLD_ONLY) {
    refuseMember(member, 'a caller whose member page or private-facts grant widens the world visibility rule');
  }
  const excludePrivate = storePrivacyPolicy(member, spec.excludePrivate, () => privateProvenanceFilterUnderPolicy('facts'), { callerReaders: true });
  const e = spec.eligibility;
  return storeCall({ member }, () => brain.factReadableUnder({
    id: spec.id,
    sourceId: spec.sourceId,
    anyVisibility: spec.anyVisibility,
    minTrust: e?.floor || null,
    suppressFlagged: e?.suppressFlagged === true,
    ...(excludePrivate ? { excludePrivate } : {}),
  }));
};

/**
 * The remote provenance floor as the store reads it: the rendering with no caller record (which reads pending folder
 * coverage live), or the rendering of a fresh record carrying only the caller's `restricted` and `owner` flags and its
 * schema version (remotePolicy). The floor never reads the caller's identity, and the store keeps no owner-only source,
 * folder rule or pending coverage, so those forms differ only in text the store answers the same way, except
 * `restricted: false`, which drops the origin test (sent as a flag). Any other rendering refuses.
 */
function storeRemoteFloor(member: string): { honorAliases: boolean; restricted: boolean } {
  const got = normalizeConceptInputs(remoteProvenanceFloorSql('facts'));
  const unscoped = withoutCallerAccess(() => remoteProvenanceFloorSql('facts'));
  if (got === normalizeConceptInputs(unscoped)) return { honorAliases: unscoped.includes(privacyAliasSql('pp')), restricted: true };
  const { restricted, owner, remotePolicy } = currentCallerAccess();
  const fresh = withoutCallerAccess(() => withCallerAccess({ restricted, owner, remotePolicy }, () => remoteProvenanceFloorSql('facts')));
  if (got !== normalizeConceptInputs(fresh)) {
    refuseMember(member, 'a remote provenance floor the store does not model (a labelled-only caller, folder coverage or a relaxed privacy setting)');
  }
  return { honorAliases: fresh.includes(privacyAliasSql('pp')), restricted };
}

export const readRemoteForgetTier: Member<'readRemoteForgetTier'> = (brain, spec) => {
  const member = 'readRemoteForgetTier';
  requireInteger(member, spec.factId);
  const remoteFloor = spec.remoteFloor ? storeRemoteFloor(member) : null;
  return storeCall({ member }, () => brain.readRemoteForgetTier({ factId: spec.factId, sourceId: spec.sourceId, remoteFloor }));
};
