/**
 * The belief side of a purge (src/core/engine-sql/belief-purge.ts), served from
 * rust/crates/gbrain-store/src/trust/belief_purge.rs and facts/page_purges.rs: the source purge epoch
 * (`bumpSourcePurgeEpoch`), the ledger presence probe (`hasBeliefEvents`), the purge receipt's ledger read
 * (`listBeliefEventsForPurgeProbe`: a keyset page of belief_events, as purge-verify's ledgerReports pages it), the
 * purge's suppression writes (`registerPurgeRedaction`, `releasePurgeRedactionsForField`) and the restore replay's
 * tombstones (`replayPagePurges`) with the purge receipt's count of them (`countPagePurgeTombstones`).
 * `readPurgeReplaySchema` makes no store call: the store always has the live schema, so every listed
 * store and every probed table and column is present (as connect-gate.ts answers `hasPersistenceTable`).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const bumpSourcePurgeEpoch: Member<'bumpSourcePurgeEpoch'> = async (brain, sourceId) =>
  (await storeCall({ member: 'bumpSourcePurgeEpoch', sourceId }, () => brain.bumpSourcePurgeEpoch(sourceId))) ?? null;

export const hasBeliefEvents: Member<'hasBeliefEvents'> = (brain, sourceId) =>
  storeCall({ member: 'hasBeliefEvents', sourceId }, () => brain.hasBeliefEvents(sourceId));

export const listBeliefEventsForPurgeProbe: Member<'listBeliefEventsForPurgeProbe'> = (brain, sourceId, after) =>
  storeCall({ member: 'listBeliefEventsForPurgeProbe', sourceId }, () => brain.listBeliefEventsForPurgeProbe(sourceId, after));

export const registerPurgeRedaction: Member<'registerPurgeRedaction'> = async (brain, row) => {
  await storeCall({ member: 'registerPurgeRedaction', sourceId: row.sourceId }, () => brain.registerPurgeRedaction(row));
};

export const releasePurgeRedactionsForField: Member<'releasePurgeRedactionsForField'> = (brain, row) =>
  storeCall({ member: 'releasePurgeRedactionsForField', sourceId: row.sourceId }, () => brain.releasePurgeRedactionsForField(row));

export const replayPagePurges: Member<'replayPagePurges'> = async (brain, row) => {
  await storeCall({ member: 'replayPagePurges', sourceId: row.sourceId }, () => brain.replayPagePurges(row));
};

export const countPagePurgeTombstones: Member<'countPagePurgeTombstones'> = (brain, sourceId, slug) =>
  storeCall({ member: 'countPagePurgeTombstones', sourceId }, () => brain.countPagePurgeTombstones(sourceId, slug));

export const readPurgeReplaySchema: Member<'readPurgeReplaySchema'> = async (_brain, stores) => ({
  stores: [...stores], changeReason: true, persistenceBrain: true, derivationInputs: true, beliefEvents: true,
});
