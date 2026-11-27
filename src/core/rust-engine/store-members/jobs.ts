/**
 * The cycle-lock members the import path takes (BrainEngine acquireCycleLock, refreshCycleLock, releaseCycleLock) and the
 * page embedding leases the embed effect takes (take/renew/releasePageEmbeddingLease), served by the store's jobs
 * family (rust/docs/store/jobs.md).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type AcquireOpts = Parameters<BrainEngine['acquireCycleLock']>[1];

type HolderOpts = { holderPid: number; acquisitionToken: string };

export const acquireCycleLock: StoreMember<[lockId: string, opts: AcquireOpts], { id: string; fence: string } | null> = (brain, lockId, opts) =>
  storeCall({ member: 'acquireCycleLock' }, () => brain.acquireCycleLock(lockId, opts));

/** A signal is ignored, as PGLite ignores it. */
export const refreshCycleLock: StoreMember<[lockId: string, opts: HolderOpts & { ttlMinutes: number }, queryOpts?: { signal?: AbortSignal }], boolean> =
  (brain, lockId, opts) => storeCall({ member: 'refreshCycleLock' }, () => brain.refreshCycleLock(lockId, opts));

export const releaseCycleLock: StoreMember<[lockId: string, opts: HolderOpts], boolean> = (brain, lockId, opts) =>
  storeCall({ member: 'releaseCycleLock' }, () => brain.releaseCycleLock(lockId, opts));

// ---------------------------------------------------------------- page embedding leases (page-embedding-lease.ts)

type PageLeaseTake = Parameters<BrainEngine['takePageEmbeddingLease']>[1];

export const takePageEmbeddingLease: StoreMember<[leaseId: string, opts: PageLeaseTake], boolean> = (brain, leaseId, opts) =>
  storeCall({ member: 'takePageEmbeddingLease' }, () => brain.takePageEmbeddingLease(leaseId, opts));

export const renewPageEmbeddingLease: StoreMember<[leaseId: string, opts: { acquisitionToken: string; ttlMinutes: number }], boolean> = (brain, leaseId, opts) =>
  storeCall({ member: 'renewPageEmbeddingLease' }, () => brain.renewPageEmbeddingLease(leaseId, opts));

export const releasePageEmbeddingLease: StoreMember<[leaseId: string, opts: { acquisitionToken: string }], void> = async (brain, leaseId, opts) => {
  await storeCall({ member: 'releasePageEmbeddingLease' }, () => brain.releasePageEmbeddingLease(leaseId, opts));
};
