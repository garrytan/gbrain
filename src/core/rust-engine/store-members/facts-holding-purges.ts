/**
 * `insertHoldingPagePurges` (src/core/engine-sql/facts-purge.ts), served from the facts store
 * (rust/crates/gbrain-store/src/facts/holding_purges.rs). The purge transaction calls it once per purge with the ids of
 * the facts the purge removes; the store stores a tombstone for each holding page that holds one of them.
 */
import { storeCall, type StoreMember } from './common.ts';

export const insertHoldingPagePurges: StoreMember<
  [sourceId: string, visibility: string, factHash: string, requestId: string, actor: string, reason: string | null, factIds: number[]],
  void
> = async (brain, sourceId, visibility, factHash, requestId, actor, reason, factIds) => {
  await storeCall({ member: 'insertHoldingPagePurges', sourceId }, () =>
    brain.insertHoldingPagePurges({ sourceId, visibility, factHash, requestId, actor, reason, factIds }));
};
