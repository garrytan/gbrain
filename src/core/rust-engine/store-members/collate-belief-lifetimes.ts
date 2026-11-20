/**
 * The belief ledger's page lifetime statements (BrainEngine readOpenLifetimes, mintLifetime, endLifetime, renameLifetime,
 * readMovedLifetimes; SQL in engine-sql/collate-belief-lifetimes.ts), served from the store
 * (rust/crates/gbrain-store/src/belief_ledger.rs). What each member answers: rust/docs/store/collate-belief-lifetimes.md.
 */
import type { LifetimeNeed, MovedLifetimeRow, OpenLifetimeRow } from '../../engine-sql/collate-belief-lifetimes.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readOpenLifetimes: StoreMember<[sourceId: string, pairs: readonly { incarnation: string; slug: string }[]], OpenLifetimeRow[]> = async (brain, sourceId, pairs) =>
  await storeCall({ member: 'readOpenLifetimes', sourceId }, () => brain.readOpenLifetimes(sourceId, pairs.map(n => n.incarnation), pairs.map(n => n.slug))) as OpenLifetimeRow[];

export const mintLifetime: StoreMember<[need: LifetimeNeed], string> = async (brain, need) =>
  await storeCall({ member: 'mintLifetime', sourceId: need.sourceId }, () => brain.mintLifetime(need.sourceId, need.incarnation, need.slug, need.pageId)) as string;

export const endLifetime: StoreMember<[lifetime: string], void> = async (brain, lifetime) => {
  await storeCall({ member: 'endLifetime' }, () => brain.endLifetime(lifetime));
};

export const renameLifetime: StoreMember<[lifetime: string, slug: string, pageId: number], void> = async (brain, lifetime, slug, pageId) => {
  await storeCall({ member: 'renameLifetime' }, () => brain.renameLifetime(lifetime, slug, pageId));
};

export const readMovedLifetimes: StoreMember<[pageIds: readonly number[]], MovedLifetimeRow[]> = async (brain, pageIds) =>
  pageIds.length ? await storeCall({ member: 'readMovedLifetimes' }, () => brain.readMovedLifetimes([...pageIds])) as MovedLifetimeRow[] : [];
