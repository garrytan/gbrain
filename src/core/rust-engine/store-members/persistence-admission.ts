/**
 * The managed-worktree admission members (engine-sql/persistence-admission.ts) the Rust store answers from its refresh
 * keyspace (K1, rust/crates/gbrain-store/src/persistence/worktree_admission.rs).
 *
 * No worktree, source binding or consumer row exists on this engine yet, so `readWorktreeAdmission` reads no worktree
 * and `bound: false` (admission refuses the write `source_changed`, as Postgres does for an unbound source) and
 * `hasDeferralRoom` is true (no live consumer lacks the capability). The row locks change nothing here: each store
 * call is one store write transaction. These members are classified `managed_persistence`, which stays held until its
 * callers are typed (store-capabilities.ts HELD_FOR_CALLERS).
 */
import type { RefreshTiming, WorktreeAdmission, WorktreeAdmissionKey } from '../../engine-sql/persistence-admission.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readWorktreeAdmission: StoreMember<[key: WorktreeAdmissionKey, opts?: { lockRefresh?: boolean }], WorktreeAdmission> = (brain, key) =>
  storeCall({ member: 'readWorktreeAdmission' }, () => brain.readWorktreeAdmission(key.worktreeId, key.sourceIncarnation));

export const completeSyncedRefresh: StoreMember<[refreshId: string], boolean> = (brain, refreshId) =>
  storeCall({ member: 'completeSyncedRefresh' }, () => brain.completeSyncedRefresh(refreshId));

export const hasDeferralRoom: StoreMember<[worktreeId: string, capability: string, liveMs: number], boolean> = (brain, worktreeId, _capability, liveMs) =>
  storeCall({ member: 'hasDeferralRoom' }, () => brain.hasDeferralRoom(worktreeId, liveMs));

export const readRefreshTiming: StoreMember<[refreshId: string], RefreshTiming | null> = async (brain, refreshId) =>
  (await storeCall({ member: 'readRefreshTiming' }, () => brain.readRefreshTiming(refreshId))) ?? null;

export const countHeldBehindImport: StoreMember<[sourceId: string, principal: { kind: string; id: string } | null], { count: number; bytes: number }> = (brain, sourceId, principal) =>
  storeCall({ member: 'countHeldBehindImport' }, () => brain.countHeldBehindImport(sourceId, principal?.kind ?? null, principal?.id ?? null));
