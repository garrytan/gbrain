/**
 * Belief ledger writes and the reads its append makes (src/core/engine-sql/belief-ledger.ts), served from the trust
 * store (rust/crates/gbrain-store/src/trust/belief_{events,lifetimes,redactions}.rs; rust/docs/store/trust.md, "The
 * belief ledger"). Each member sends the arguments of its BrainEngine member as one JSON value.
 *
 * `readBeliefTombstones` answers the take half from the take purge ledger. Its fact half is answered only when no fact
 * fingerprint is asked or the source has no fact purge tombstone; otherwise it is refused, since the store does not yet
 * read a fact tombstone's fingerprint by hash.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

interface TombstoneAnswer { fps: string[]; factPathUnread: boolean }

export const readBeliefTombstones: Member<'readBeliefTombstones'> = async (brain, sourceId, factFps, takeFps) => {
  const member = 'readBeliefTombstones';
  const answer = await storeCall({ member, sourceId },
    () => brain.readBeliefTombstones({ sourceId, factFps: [...factFps], takeFps: [...takeFps] })) as TombstoneAnswer;
  if (answer.factPathUnread) refuseMember(member, 'a fact purge tombstone of the source, read by fingerprint');
  return answer.fps;
};

export const readBeliefRedactions: Member<'readBeliefRedactions'> = (brain, sourceId, subjectKeys, fieldHashes) =>
  storeCall({ member: 'readBeliefRedactions', sourceId },
    () => brain.readBeliefRedactions({ sourceId, subjectKeys: [...subjectKeys], fieldHashes: [...fieldHashes] }));

export const insertBeliefRedaction: Member<'insertBeliefRedaction'> = (brain, row) =>
  storeCall({ member: 'insertBeliefRedaction', sourceId: row.sourceId }, () => brain.insertBeliefRedaction(row));

export const releaseBeliefRedactions: Member<'releaseBeliefRedactions'> = (brain, ids, publicationId, releasedHash) =>
  storeCall({ member: 'releaseBeliefRedactions' }, () => brain.releaseBeliefRedactions({ ids: [...ids], publicationId, releasedHash }));

export const insertBeliefEvents: Member<'insertBeliefEvents'> = (brain, rows) =>
  storeCall({ member: 'insertBeliefEvents' }, () => brain.insertBeliefEvents([...rows]));

export const markBeliefCommits: Member<'markBeliefCommits'> = (brain, publicationIds) =>
  storeCall({ member: 'markBeliefCommits' }, () => brain.markBeliefCommits([...publicationIds]));

// The interface types each pair as { incarnation, slug }; callers (resolveLifetimes) pass wider page needs, so only the
// two named fields cross to the store, which refuses an unknown one.
export const readOpenBeliefLifetimes: Member<'readOpenBeliefLifetimes'> = (brain, pairs) =>
  storeCall({ member: 'readOpenBeliefLifetimes' }, () => brain.readOpenBeliefLifetimes(pairs.map(({ incarnation, slug }) => ({ incarnation, slug }))));

export const endBeliefLifetime: Member<'endBeliefLifetime'> = (brain, lifetime) =>
  storeCall({ member: 'endBeliefLifetime' }, () => brain.endBeliefLifetime(lifetime));

export const mintBeliefLifetime: Member<'mintBeliefLifetime'> = (brain, mint) =>
  storeCall({ member: 'mintBeliefLifetime', sourceId: mint.sourceId }, () => brain.mintBeliefLifetime(mint));

export const renameBeliefLifetime: Member<'renameBeliefLifetime'> = (brain, lifetime, slug, pageId) =>
  storeCall({ member: 'renameBeliefLifetime' }, () => brain.renameBeliefLifetime({ lifetime, slug, pageId }));

export const readMovedBeliefLifetimes: Member<'readMovedBeliefLifetimes'> = (brain, pageIds) =>
  storeCall({ member: 'readMovedBeliefLifetimes' }, () => brain.readMovedBeliefLifetimes([...pageIds]));
