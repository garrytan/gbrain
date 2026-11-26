/**
 * The reads `remember` and `forget` make before admission (src/core/engine-sql/memory-mutation-reads.ts), served from
 * the store (rust/crates/gbrain-store/src/memory_mutation_reads.rs): `readSourceWriteRow` and `readSourceLocalPath`
 * over the source record, `readFactEntitySlug`, `factReadableUnder`, `readRemoteForgetTier` and `readForgetTarget`
 * over the fact rows, and `hasLiveFileBackedPage` over the page records. `readForgetTarget`'s `lock` (FOR UPDATE)
 * changes nothing here: one store call reads under the store's own lock. `isFactEntityUnbacked`, `readLinkedFactCopies`,
 * `hasHiddenFactCopy` and `ownerReachesFact` (what a forget's withdrawal reaches) read the fact and page records.
 * `readFactWithdrawalClaim` (the claim a withdrawal changes) reads the fact record and, for its subject, the page records.
 *
 * Refused (`engine_capability_missing`):
 *  - a fact id that is not an integer, rather than guess at Postgres's bind error;
 *  - `factReadableUnder` for a caller whose world visibility rule a member page or a private-facts grant widens
 *    (factVisibilitySql is then more than `visibility IN ('world')`), and under `excludePrivate` for a caller whose
 *    policy `storePrivacyPolicy` refuses;
 *  - `readRemoteForgetTier` under `remoteFloor` for a caller whose remote provenance floor (remoteProvenanceFloorSql)
 *    is none of the forms the store models: the floor with no caller record, or a caller record on a brain with or
 *    without member-access restrictions, for the owner or not, at the caller's schema version. A labelled-only caller,
 *    folder coverage or a relaxed privacy setting renders other text. `readForgetTarget`, `readLinkedFactCopies`
 *    and `readFactWithdrawalClaim` under `remoteFloor`, and `hasHiddenFactCopy` (always under the floor), refuse the same;
 *  - `ownerReachesFact` for an owner bound to a member (ownerReadPolicyFragment renders GST-2490's owner read rule rather
 *    than FALSE) whose rule text, or the member read rule's, is not the canonical rendering `storeOwnerReachPolicy`
 *    compares (a caller context that changes it, or an identity or satisfied rule the text dropped as invalid).
 */
import type { BrainEngine, FactWithdrawalClaim, ForgetTargetRow, LinkedFactCopy } from '../../engine.ts';
import { MEMBER_PAGE_PREFIX, factVisibilitySql } from '../../access/member-facts.ts';
import { withDates } from '../store-codec.ts';
import {
  privateProvenanceFilterUnderPolicy, ownerReadPolicyFragment,
} from '../../search/private-visibility.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storeOwnerReachPolicy, storePrivacyPolicy } from './private-provenance.ts';
import { storeRemoteFloor } from './remote-floor.ts';

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


export const readRemoteForgetTier: Member<'readRemoteForgetTier'> = (brain, spec) => {
  const member = 'readRemoteForgetTier';
  requireInteger(member, spec.factId);
  const remoteFloor = spec.remoteFloor ? storeRemoteFloor(member) : null;
  return storeCall({ member }, () => brain.readRemoteForgetTier({ factId: spec.factId, sourceId: spec.sourceId, remoteFloor }));
};

export const readForgetTarget: Member<'readForgetTarget'> = async (brain, spec) => {
  const member = 'readForgetTarget';
  requireInteger(member, spec.id);
  const own = spec.ownPage;
  const remoteFloor = !own && spec.remoteFloor ? storeRemoteFloor(member) : null;
  const row = await storeCall({ member }, () => brain.readForgetTarget({
    id: spec.id,
    sourceId: spec.sourceId,
    worldOnly: spec.worldOnly,
    remoteFloor,
    ownPage: own ? { slug: own, reader: `member:${own.slice(MEMBER_PAGE_PREFIX.length)}` } : null,
  }));
  return row ? withDates(row as ForgetTargetRow, ['expired_at']) : null;
};

export const isFactEntityUnbacked: Member<'isFactEntityUnbacked'> = (brain, id, sourceId) => {
  requireInteger('isFactEntityUnbacked', id);
  return storeCall({ member: 'isFactEntityUnbacked' }, () => brain.isFactEntityUnbacked(id, sourceId));
};

export const readLinkedFactCopies: Member<'readLinkedFactCopies'> = async (brain, spec) => {
  const member = 'readLinkedFactCopies';
  requireInteger(member, spec.id);
  const remoteFloor = spec.remoteFloor ? storeRemoteFloor(member) : null;
  return storeCall({ member }, () => brain.readLinkedFactCopies({ id: spec.id, sourceId: spec.sourceId, worldOnly: spec.worldOnly, remoteFloor })) as Promise<LinkedFactCopy[]>;
};

export const hasHiddenFactCopy: Member<'hasHiddenFactCopy'> = (brain, spec) => {
  const member = 'hasHiddenFactCopy';
  requireInteger(member, spec.id);
  const remoteFloor = storeRemoteFloor(member);
  return storeCall({ member }, () => brain.hasHiddenFactCopy({ id: spec.id, sourceId: spec.sourceId, remoteFloor }));
};

export const ownerReachesFact: Member<'ownerReachesFact'> = (brain, spec) => {
  const member = 'ownerReachesFact';
  requireInteger(member, spec.id);
  // An owner bound to no member reads no page (the rule renders FALSE); one bound to a member sends its identity and
  // satisfied folder rules, which the store judges as the rule's text does, or the member refuses the rendering.
  const policy = ownerReadPolicyFragment('pp', spec.identity, spec.satisfied) === 'FALSE' ? undefined : storeOwnerReachPolicy(member, spec);
  return storeCall({ member }, () => brain.ownerReachesFact({ id: spec.id, sourceId: spec.sourceId, ...(policy ? { policy } : {}) }));
};

/** `lock` takes no row lock: the store serializes its writes, so the withdrawal's own Store::write is the lock. */
export const readFactWithdrawalClaim: Member<'readFactWithdrawalClaim'> = (brain, spec) => {
  const member = 'readFactWithdrawalClaim';
  requireInteger(member, spec.id);
  const remoteFloor = spec.remoteFloor ? storeRemoteFloor(member) : null;
  return storeCall({ member }, () => brain.readFactWithdrawalClaim({
    id: spec.id, sourceId: spec.sourceId, worldOnly: spec.worldOnly, memberPage: spec.memberPage, remoteFloor,
  })) as Promise<FactWithdrawalClaim | null>;
};
