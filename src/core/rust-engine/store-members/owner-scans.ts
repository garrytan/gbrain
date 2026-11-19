/**
 * The owner scans the Rust store answers (engine-sql/persistence-owner-scans.ts): the reads the write owner's
 * housekeeping makes on each scan tick (listOverdueHeldWrites, lockOverdueHold).
 *
 * Each scan joins a write request to a persistence worktree the host owns. The store keeps no worktree (a request row
 * here always has a null `worktree_id`, and an insert that names a refresh hold refuses), so each list answers no row
 * and no hold stands; it still refuses the arguments the Postgres casts refuse (an id that is not a uuid).
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Owner scans").
 */
import type { OverdueHold, OverdueHoldKind } from '../../engine-sql/persistence-owner-scans.ts';
import { storeCall, type StoreMember } from './common.ts';

/** No write here waits behind a refresh or a worktree import, so none is overdue; the wait limit changes nothing. */
export const listOverdueHeldWrites: StoreMember<[hostId: string, maxWaitMs: number, hold: OverdueHoldKind, opts?: { signal?: AbortSignal }], Record<string, unknown>[]> =
  (brain, hostId, _maxWaitMs, hold) => storeCall({ member: 'listOverdueHeldWrites' }, () => brain.listOverdueHeldWrites(hostId, hold));

/** No refresh row or worktree import hold exists here, so none still stands. */
export const lockOverdueHold: StoreMember<[hold: OverdueHold], boolean> =
  (brain, hold) => storeCall({ member: 'lockOverdueHold' }, () =>
    brain.lockOverdueHold(hold.kind, hold.kind === 'refresh' ? hold.refreshId : hold.id));
