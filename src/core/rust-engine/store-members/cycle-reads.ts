/**
 * The cycle, belief and sync reads served from the store (BrainEngine members of engine-members/cycle-reads.ts; SQL in
 * engine-sql/cycle-reads.ts): the
 * cycle's changed-page window (cycle_window.rs) and the belief ledger's orphan lifetimes (trust/belief_coverage.rs).
 * What each answers: rust/docs/store/cycle-window.md and trust.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readCycleListingInstant: Member<'readCycleListingInstant'> = (brain) =>
  storeCall({ member: 'readCycleListingInstant' }, () => brain.readCycleListingInstant()) as Promise<string | null>;

export const listSourceChangedPagesAfter: Member<'listSourceChangedPagesAfter'> = (brain, sourceId, since, slug, limit) =>
  storeCall({ member: 'listSourceChangedPagesAfter', sourceId }, () => brain.listSourceChangedPagesAfter(sourceId, since, slug, limit)) as ReturnType<BrainEngine['listSourceChangedPagesAfter']>;

export const listOrphanLifetimes: Member<'listOrphanLifetimes'> = (brain, sourceId, limit, deep) =>
  storeCall({ member: 'listOrphanLifetimes', sourceId }, () => brain.listOrphanLifetimes(sourceId, Math.min(Math.max(1, Math.floor(limit)), 2 ** 31 - 1), deep)) as ReturnType<BrainEngine['listOrphanLifetimes']>;
