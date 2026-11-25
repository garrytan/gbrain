/**
 * The cycle-lock members the import path takes (BrainEngine acquireCycleLock, refreshCycleLock, releaseCycleLock), served from the
 * store's `gbrain_cycle_locks` rows (rust/docs/store/jobs.md).
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
