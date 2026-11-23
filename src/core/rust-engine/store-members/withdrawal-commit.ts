/**
 * The statements a forget's withdrawal commits (recordFactWithdrawal, src/core/facts/withdrawal.ts; forget-prepare.ts)
 * and the `fact_withdrawn` refusal reads (factWithdrawnRefusal, src/core/facts/single-prepare.ts), over
 * `rust/crates/gbrain-store/src/trust/withdrawal_commit.rs`: `lockFactForWithdrawal`, `queueWithdrawalReview`,
 * `listSegmentedPagesBySlug`, `bumpWithdrawnPageRevisions`, `readPageRevisions`, `appendFactForgetReason`,
 * `readFactWithdrawnRow` and `readFactWithdrawnBacking`. One store call reads under the store's own lock, so
 * `lockFactForWithdrawal`'s FOR UPDATE changes nothing here. `withdrawn_at` comes back as ISO text.
 *
 * Refused (`engine_capability_missing`): a fact or page id that is not an integer, and, under the remote provenance
 * floor (`lockFactForWithdrawal`'s `remoteFloor`, `readFactWithdrawnRow`'s `excludePrivate`, and
 * `readFactWithdrawnBacking` always), a floor the store does not model (storeRemoteFloor, memory-mutation-reads.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { FactWithdrawnRow, FactWithdrawnSpec, WithdrawalLockRow, WithdrawnPageRevision } from '../../engine-sql/trust-withdrawals.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storeRemoteFloor } from './remote-floor.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function requireInteger(member: string, what: string, value: number): void {
  if (!Number.isSafeInteger(value)) refuseMember(member, `a ${what} that is not an integer`);
}

function claim(spec: FactWithdrawnSpec, remoteFloor: ReturnType<typeof storeRemoteFloor> | null) {
  return { sourceId: spec.sourceId, visibility: spec.visibility, fact: spec.fact, entitySlug: spec.entitySlug ?? null, ownedPage: spec.ownedPage ?? null, remoteFloor };
}

export const lockFactForWithdrawal: Member<'lockFactForWithdrawal'> = (brain, spec) => {
  const member = 'lockFactForWithdrawal';
  requireInteger(member, 'fact id', spec.id);
  const remoteFloor = spec.remoteFloor ? storeRemoteFloor(member) : null;
  return storeCall({ member, sourceId: spec.sourceId }, () => brain.lockFactForWithdrawal({
    id: spec.id, sourceId: spec.sourceId, worldOnly: spec.worldOnly, memberPage: spec.memberPage ?? null, remoteFloor,
  })) as Promise<WithdrawalLockRow | null>;
};

export const queueWithdrawalReview: Member<'queueWithdrawalReview'> = (brain, sourceId, factRef) =>
  storeCall({ member: 'queueWithdrawalReview', sourceId }, () => brain.queueWithdrawalReview(sourceId, factRef));

export const listSegmentedPagesBySlug: Member<'listSegmentedPagesBySlug'> = (brain, sourceId, slugs) =>
  storeCall({ member: 'listSegmentedPagesBySlug', sourceId }, () => brain.listSegmentedPagesBySlug(sourceId, [...slugs]));

export const bumpWithdrawnPageRevisions: Member<'bumpWithdrawnPageRevisions'> = (brain, sourceId, slugs) =>
  storeCall({ member: 'bumpWithdrawnPageRevisions', sourceId }, () => brain.bumpWithdrawnPageRevisions(sourceId, [...slugs])) as Promise<WithdrawnPageRevision[]>;

export const readPageRevisions: Member<'readPageRevisions'> = (brain, ids) => {
  for (const id of ids) requireInteger('readPageRevisions', 'page id', id);
  return storeCall({ member: 'readPageRevisions' }, () => brain.readPageRevisions([...ids])) as Promise<WithdrawnPageRevision[]>;
};

export const appendFactForgetReason: Member<'appendFactForgetReason'> = (brain, id, sourceId, note) => {
  requireInteger('appendFactForgetReason', 'fact id', id);
  return storeCall({ member: 'appendFactForgetReason', sourceId }, () => brain.appendFactForgetReason(id, sourceId, note));
};

export const readFactWithdrawnRow: Member<'readFactWithdrawnRow'> = (brain, spec) => {
  const member = 'readFactWithdrawnRow';
  const remoteFloor = spec.excludePrivate ? storeRemoteFloor(member) : null;
  return storeCall({ member, sourceId: spec.sourceId }, () => brain.readFactWithdrawnRow(claim(spec, remoteFloor))) as Promise<FactWithdrawnRow | null>;
};

export const readFactWithdrawnBacking: Member<'readFactWithdrawnBacking'> = (brain, spec) => {
  const member = 'readFactWithdrawnBacking';
  const remoteFloor = storeRemoteFloor(member);
  return storeCall({ member, sourceId: spec.sourceId }, () => brain.readFactWithdrawnBacking(claim(spec, remoteFloor))) as Promise<{ visible: boolean; hidden: boolean }>;
};
