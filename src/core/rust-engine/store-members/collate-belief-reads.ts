/**
 * The belief ledger's orphan lifetime read (BrainEngine listOrphanLifetimes; SQL in engine-sql/collate-belief-reads.ts),
 * served from the store's lifetime records (rust/crates/gbrain-store/src/belief_ledger.rs). What it answers:
 * rust/docs/store/collate-belief-reads.md. The store keeps no belief events, so the deep read (events that name a lifetime
 * that does not exist) refuses instead of answering with its first half only.
 */
import type { OrphanLifetimeSamples, OrphanReason } from '../../engine-sql/collate-belief-reads.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

export const listOrphanLifetimes: StoreMember<[sourceId: string, limit: number, deep: boolean], OrphanLifetimeSamples> = async (brain, sourceId, limit, deep) => {
  if (deep) refuseMember('listOrphanLifetimes', 'the deep read needs belief events, which the store does not keep');
  const found = await storeCall({ member: 'listOrphanLifetimes', sourceId }, () => brain.listOrphanLifetimes(sourceId, Math.max(1, Math.floor(limit)))) as
    { total: number; rows: Array<{ slug: string; page_lifetime: string; reason: OrphanReason }> };
  return { count: found.total, samples: found.rows };
};
