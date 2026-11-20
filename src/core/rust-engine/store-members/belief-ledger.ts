/**
 * Belief ledger writes and the reads its append makes (src/core/engine-sql/belief-ledger.ts), served from the trust
 * store (rust/crates/gbrain-store/src/trust/belief_{events,lifetimes,redactions}.rs; rust/docs/store/trust.md, "The
 * belief ledger"). Each member sends the arguments of its BrainEngine member as one JSON value.
 *
 * `readBeliefTombstones` answers the fact half from the fact purge ledger and the take half from the take purge ledger.
 */
import type { BrainEngine } from '../../engine.ts';
import type { BeliefCoverageRow } from '../../engine-sql/belief-ledger.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

interface TombstoneAnswer { fps: string[] }

export const readBeliefTombstones: Member<'readBeliefTombstones'> = async (brain, sourceId, factFps, takeFps) => {
  const answer = await storeCall({ member: 'readBeliefTombstones', sourceId },
    () => brain.readBeliefTombstones({ sourceId, factFps: [...factFps], takeFps: [...takeFps] })) as TombstoneAnswer;
  return answer.fps;
};

// The store's recorded_at carries microseconds; PGLite returns a Date, which the engine-sql member turns to ISO milliseconds.
export const readLatestBeliefCoverage: Member<'readLatestBeliefCoverage'> = async (brain, sourceId) => {
  const row = await storeCall({ member: 'readLatestBeliefCoverage', sourceId }, () => brain.readLatestBeliefCoverage(sourceId)) as BeliefCoverageRow | null;
  return row ? { ...row, recorded_at: new Date(row.recorded_at).toISOString(), id: Number(row.id) } : null;
};

export const hasBeliefBaseline: Member<'hasBeliefBaseline'> = (brain, sourceId, slug, runId) =>
  storeCall({ member: 'hasBeliefBaseline', sourceId }, () => brain.hasBeliefBaseline(sourceId, slug, runId));

export const listBeliefBaselinePending: Member<'listBeliefBaselinePending'> = (brain, sourceId, runId, after, skip, limit) =>
  storeCall({ member: 'listBeliefBaselinePending', sourceId }, () => brain.listBeliefBaselinePending({ sourceId, runId, after, skip: [...skip], limit }));

export const countBeliefBaselineSlugs: Member<'countBeliefBaselineSlugs'> = (brain, sourceId, runId) =>
  storeCall({ member: 'countBeliefBaselineSlugs', sourceId }, () => brain.countBeliefBaselineSlugs(sourceId, runId));

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
