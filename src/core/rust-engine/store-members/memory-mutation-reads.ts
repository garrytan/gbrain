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
 *    than FALSE), which the store does not model.
 */
import type { BrainEngine, FactWithdrawalClaim, ForgetTargetRow, LinkedFactCopy } from '../../engine.ts';
import { MEMBER_PAGE_PREFIX, factVisibilitySql } from '../../access/member-facts.ts';
import { withDates } from '../store-codec.ts';
import {
  privateProvenanceFilterUnderPolicy, ownerReadPolicyFragment,
} from '../../search/private-visibility.ts';
import { assertStoreSerializedTransactions, refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePrivacyPolicy } from './private-provenance.ts';
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
  const excludePrivate = storePrivacyPolicy(member, spec.excludePrivate, () => privateProvenanceFilterUnderPolicy('facts'), { callerReaders: true, fragment: 'under_policy' });
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
  if (spec.lock) assertStoreSerializedTransactions(brain, 'readForgetTarget');
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
  if (ownerReadPolicyFragment('pp', spec.identity, spec.satisfied) !== 'FALSE') {
    refuseMember(member, 'an owner bound to a member, whose pages the owner read rule (GST-2490 lineage) judges, which the store does not model');
  }
  return storeCall({ member }, () => brain.ownerReachesFact({ id: spec.id, sourceId: spec.sourceId }));
};

/** `lock` skips the row lock while explicit transactions hold the writer (`serialized_transactions`); it asserts that. */
export const readFactWithdrawalClaim: Member<'readFactWithdrawalClaim'> = async (brain, spec) => {
  if (spec.lock) assertStoreSerializedTransactions(brain, 'readFactWithdrawalClaim');
  const member = 'readFactWithdrawalClaim';
  requireInteger(member, spec.id);
  const remoteFloor = spec.remoteFloor ? storeRemoteFloor(member) : null;
  return storeCall({ member }, () => brain.readFactWithdrawalClaim({
    id: spec.id, sourceId: spec.sourceId, worldOnly: spec.worldOnly, memberPage: spec.memberPage, remoteFloor,
  })) as Promise<FactWithdrawalClaim | null>;
};
