/**
 * The owner scans the Rust store answers (engine-sql/persistence-owner-scans.ts): the reads the write owner's
 * housekeeping makes on each scan tick (listOverdueHeldWrites, lockOverdueHold, listOwnerRecoveryHeads,
 * listResumableRefreshes, listSourceLastCommits).
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

/** No write here carries a recovery record (those live only on worktree-owned writes), so there is no head; `excluded` changes nothing. */
export const listOwnerRecoveryHeads: StoreMember<[hostId: string, excluded: readonly string[], opts?: { signal?: AbortSignal; direct?: boolean }], Record<string, unknown>[]> =
  (brain, hostId) => storeCall({ member: 'listOwnerRecoveryHeads' }, () => brain.listOwnerRecoveryHeads(hostId));

/** No refresh row exists here (refreshes live only on managed worktrees), so none is interrupted; the sync budget changes nothing. */
export const listResumableRefreshes: StoreMember<[hostId: string, budgetMs: number], (Record<string, unknown> & { stale: boolean })[]> =
  (brain, hostId) => storeCall({ member: 'listResumableRefreshes' }, () => brain.listResumableRefreshes(hostId));

/**
 * Each named source that exists, in id order, with its last commit. The store keeps no `last_commit`
 * (rust/docs/store/persistence.md), so each reads null, as a source before its first sync does on the SQL engines.
 */
export const listSourceLastCommits: StoreMember<[sourceIds: readonly string[]], { last_commit: string | null }[]> = async (brain, sourceIds) => {
  const commits: { last_commit: string | null }[] = [];
  for (const sourceId of [...new Set(sourceIds)].sort()) {
    const row = await storeCall({ member: 'listSourceLastCommits', sourceId }, () => brain.getSource(sourceId)) as { last_commit?: string | null } | null;
    if (row) commits.push({ last_commit: row.last_commit ?? null });
  }
  return commits;
};
