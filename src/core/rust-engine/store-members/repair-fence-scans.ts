/**
 * The page scans of the contact-rows, split-facts and atom-fence-rows repair plans (BrainEngine listContactRowPages
 * through listPageTruths, the statements of engine-sql/repair-fence-scans.ts). The store scans its page records and
 * body manifests as the SQL filters its rows (rust/crates/gbrain-store/src/repair_fence_scans.rs).
 */
import type { AtomFenceCandidate, AtomFenceQuery, ContactRowQuery, RepairPageRef, SplitFactsPages } from '../../engine-sql/repair-fence-scans.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

const whole = (n: number) => Math.max(0, Math.floor(n));

export const listContactRowPages: StoreMember<[sourceIds: readonly string[], q: ContactRowQuery], RepairPageRef[]> = async (brain, sourceIds, q) =>
  await storeCall({ member: 'listContactRowPages' }, () => brain.listContactRowPages([...sourceIds],
    { after_id: whole(q.afterId), limit: Math.max(1, whole(q.limit)), slugs: [...q.slugs] })) as RepairPageRef[];

export const listSplitFactsPages: StoreMember<[sourceIds: readonly string[]], SplitFactsPages> = async (brain, sourceIds) =>
  await storeCall({ member: 'listSplitFactsPages' }, () => brain.listSplitFactsPages([...sourceIds])) as SplitFactsPages;

/** `timeoutMs` changes nothing: the store read does not wait on a lock. */
export const listAtomFenceCandidates: StoreMember<[sourceIds: readonly string[], q: AtomFenceQuery], AtomFenceCandidate[]> = async (brain, sourceIds, q) => {
  if (q.atomId !== null && !(Number.isSafeInteger(q.atomId) && q.atomId > 0)) refuseMember('listAtomFenceCandidates', 'an atom id that is not a positive integer');
  return await storeCall({ member: 'listAtomFenceCandidates' }, () => brain.listAtomFenceCandidates([...sourceIds],
    { atom_id: q.atomId, after_id: whole(q.afterId), limit: whole(q.limit) })) as AtomFenceCandidate[];
};

/** `timeoutMs` changes nothing, as for listAtomFenceCandidates. */
export const listPageTruths: StoreMember<[ids: readonly number[], opts?: { timeoutMs?: number }], Array<{ id: number; body: string | null }>> = async (brain, ids) => {
  if (!ids.every(id => Number.isSafeInteger(Number(id)))) refuseMember('listPageTruths', 'a page id that is not an integer');
  return await storeCall({ member: 'listPageTruths' }, () => brain.listPageTruths(ids.map(Number))) as Array<{ id: number; body: string | null }>;
};
