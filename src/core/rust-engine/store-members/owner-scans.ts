/**
 * The owner scans the Rust store answers (engine-sql/persistence-owner-scans.ts): the reads the write owner's
 * housekeeping makes on each scan tick (listOverdueHeldWrites, lockOverdueHold, listOwnerRecoveryHeads,
 * listResumableRefreshes, listSourceLastCommits).
 *
 * Each scan joins a write request to a persistence worktree the host owns, read from the store's worktree rows. No
 * caller here writes a refresh row, so no refresh is interrupted. Each member still refuses the arguments the Postgres
 * casts refuse (an id that is not a uuid).
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Owner scans").
 */
import type { OverdueHold, OverdueHoldKind } from '../../engine-sql/persistence-owner-scans.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The deferred writes on worktrees `hostId` owns whose `hold` is past `maxWaitMs`, in sequence order. */

/** The deferred writes on worktrees `hostId` owns whose `hold` is past `maxWaitMs`, in sequence order. */
export const listOverdueHeldWrites: StoreMember<[hostId: string, maxWaitMs: number, hold: OverdueHoldKind, opts?: { signal?: AbortSignal }], Record<string, unknown>[]> =
  (brain, hostId, maxWaitMs, hold) => storeCall({ member: 'listOverdueHeldWrites' }, () => brain.listOverdueHeldWrites(hostId, maxWaitMs, hold));

/** The oldest recovering write of each worktree `hostId` owns that is not in `excluded`, at most 16. */
export const listOwnerRecoveryHeads: StoreMember<[hostId: string, excluded: readonly string[], opts?: { signal?: AbortSignal; direct?: boolean }], Record<string, unknown>[]> =
  (brain, hostId, excluded) => storeCall({ member: 'listOwnerRecoveryHeads' }, () => brain.listOwnerRecoveryHeads(hostId, [...excluded]));

/** No refresh row exists here (refreshes live only on managed worktrees), so none is interrupted; the sync budget changes nothing. */
export const listResumableRefreshes: StoreMember<[hostId: string, budgetMs: number], (Record<string, unknown> & { stale: boolean })[]> =
  (brain, hostId) => storeCall({ member: 'listResumableRefreshes' }, () => brain.listResumableRefreshes(hostId));

/** Whether the hold still stands: the refresh unreleased, or the write still deferred on a pending import past its limit. */
export const lockOverdueHold: StoreMember<[hold: OverdueHold], boolean> =
  (brain, hold) => storeCall({ member: 'lockOverdueHold' }, () => hold.kind === 'refresh'
    ? brain.lockOverdueHold(hold.kind, hold.refreshId, null, null)
    : brain.lockOverdueHold(hold.kind, hold.id, hold.importFrom, hold.maxWaitMs));
