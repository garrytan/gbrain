/**
 * The cycle, belief and sync reads served from the store (BrainEngine members of engine-members/cycle-reads.ts; SQL in
 * engine-sql/cycle-reads.ts): the propose_takes failure tombstones (rust/crates/gbrain-store/src/take_proposals.rs), the
 * cycle's changed-page window (cycle_window.rs), the identity-downgrade page reads (identity_downgrades.rs), the
 * stale-mention scan's reads (mention_scan_reads.rs), the phantom-redirect pass's root-page walk (phantom_redirect.rs) and the belief ledger's orphan lifetimes
 * (trust/belief_coverage.rs). What each answers: rust/docs/store/take-proposals.md, cycle-window.md,
 * identity-downgrades.md, mention-scan-reads.md, phantom-redirect.md and trust.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const recordFailureTombstone: Member<'recordFailureTombstone'> = (brain, input) =>
  storeCall({ member: 'recordFailureTombstone', sourceId: input.sourceId }, () => brain.recordFailureTombstone(input)) as Promise<boolean>;

export const listFailureTombstones: Member<'listFailureTombstones'> = (brain, sourceId, claimPrefix) =>
  storeCall({ member: 'listFailureTombstones', sourceId }, () => brain.listFailureTombstones(sourceId, claimPrefix)) as ReturnType<BrainEngine['listFailureTombstones']>;

export const readCycleListingInstant: Member<'readCycleListingInstant'> = (brain) =>
  storeCall({ member: 'readCycleListingInstant' }, () => brain.readCycleListingInstant()) as Promise<string | null>;

export const listSourceChangedPagesAfter: Member<'listSourceChangedPagesAfter'> = (brain, sourceId, since, slug, limit) =>
  storeCall({ member: 'listSourceChangedPagesAfter', sourceId }, () => brain.listSourceChangedPagesAfter(sourceId, since, slug, limit)) as ReturnType<BrainEngine['listSourceChangedPagesAfter']>;

export const readSoftDeletedPageAtOrigin: Member<'readSoftDeletedPageAtOrigin'> = (brain, sourceId, path, slug) =>
  storeCall({ member: 'readSoftDeletedPageAtOrigin', sourceId }, () => brain.readSoftDeletedPageAtOrigin(sourceId, path, slug)) as ReturnType<BrainEngine['readSoftDeletedPageAtOrigin']>;

export const listLivePagesAtOrigin: Member<'listLivePagesAtOrigin'> = (brain, sourceId, sourcePath) =>
  storeCall({ member: 'listLivePagesAtOrigin', sourceId }, () => brain.listLivePagesAtOrigin(sourceId, sourcePath)) as ReturnType<BrainEngine['listLivePagesAtOrigin']>;

export const countPageCarryRows: Member<'countPageCarryRows'> = (brain, sourceId, slug, pageId) =>
  storeCall({ member: 'countPageCarryRows', sourceId }, () => brain.countPageCarryRows(sourceId, slug, pageId)) as ReturnType<BrainEngine['countPageCarryRows']>;

export const listStaleMentionPages: Member<'listStaleMentionPages'> = (brain, limit) =>
  storeCall({ member: 'listStaleMentionPages' }, () => brain.listStaleMentionPages(limit)) as ReturnType<BrainEngine['listStaleMentionPages']>;

export const listStaleMentionLinks: Member<'listStaleMentionLinks'> = (brain, limit) =>
  storeCall({ member: 'listStaleMentionLinks' }, () => brain.listStaleMentionLinks(limit)) as ReturnType<BrainEngine['listStaleMentionLinks']>;

export const listOrphanLifetimes: Member<'listOrphanLifetimes'> = (brain, sourceId, limit, deep) =>
  storeCall({ member: 'listOrphanLifetimes', sourceId }, () => brain.listOrphanLifetimes(sourceId, Math.min(Math.max(1, Math.floor(limit)), 2 ** 31 - 1), deep)) as ReturnType<BrainEngine['listOrphanLifetimes']>;

export const listRootPageSlugsAfter: Member<'listRootPageSlugsAfter'> = (brain, sourceId, take, held, after) =>
  storeCall({ member: 'listRootPageSlugsAfter', sourceId }, () => brain.listRootPageSlugsAfter(sourceId, take, [...held], after)) as ReturnType<BrainEngine['listRootPageSlugsAfter']>;
