/**
 * The commit notifier members the Rust store answers (engine-sql/notifier.ts): the host lease (claimNotifierLease,
 * readNotifierLease, holdsNotifierLease, releaseNotifierLease) and the host source list (listNotifierHostSourceRows).
 *
 * The store keeps the lease row with Postgres's fencing rule. It keeps no managed worktree bindings, no classic syncer
 * rows and no source `last_commit`, so every source row reads `bound` false and those fields null.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Commit notifier").
 */
import type { NotifierHostSourceRow, NotifierLeaseClaim, NotifierLeaseClaimInput, NotifierLeaseHolder } from '../../engine-sql/notifier.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The store stamps microseconds; the SQL engines read an expiry back as a millisecond ISO string. */
const msHolder = (h: NotifierLeaseHolder): NotifierLeaseHolder => ({ ...h, expires_at: new Date(h.expires_at).toISOString() });

/** The fencing token when this resident owns the host's lease, else the live holder. */
export const claimNotifierLease: StoreMember<[l: NotifierLeaseClaimInput], NotifierLeaseClaim> = async (brain, l) => {
  const claim = await storeCall({ member: 'claimNotifierLease' }, () =>
    brain.claimNotifierLease({ hostId: l.hostId, ownerId: l.ownerId, kind: l.kind, pid: l.pid, leaseMs: l.leaseMs })) as NotifierLeaseClaim;
  if (claim.owner || claim.holder === null) return claim;
  return { owner: false, holder: msHolder(claim.holder) };
};

/** The host's lease row, or null when it has none. */
export const readNotifierLease: StoreMember<[hostId: string], NotifierLeaseHolder | null> = async (brain, hostId) => {
  const row = await storeCall({ member: 'readNotifierLease' }, () => brain.readNotifierLease(hostId)) as NotifierLeaseHolder | null;
  return row === null ? null : msHolder(row);
};

/** The fencing check: the lease is still the owner's, with its fence, and unexpired. */
export const holdsNotifierLease: StoreMember<[hostId: string, ownerId: string, fence: number], boolean> = (brain, hostId, ownerId, fence) =>
  storeCall({ member: 'holdsNotifierLease' }, () => brain.holdsNotifierLease(hostId, ownerId, fence));

/** Expires the owner's own lease now, in one store write. */
export const releaseNotifierLease: StoreMember<[hostId: string, ownerId: string], void> = async (brain, hostId, ownerId) => {
  await storeCall({ member: 'releaseNotifierLease' }, () => brain.releaseNotifierLease(hostId, ownerId));
};

/** Every source that is not archived, in id order. */
export const listNotifierHostSourceRows: StoreMember<[], NotifierHostSourceRow[]> = (brain) =>
  storeCall({ member: 'listNotifierHostSourceRows' }, () => brain.listNotifierHostSourceRows());
