/**
 * The commit notifier members the Rust store answers (engine-sql/notifier.ts): the host lease (claimNotifierLease) and
 * the host source list (listNotifierHostSourceRows).
 *
 * The store keeps the lease row with Postgres's fencing rule. It keeps no managed worktree bindings, no classic syncer
 * rows and no source `last_commit`, so every source row reads `bound` false and those fields null.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Commit notifier").
 */
import type { NotifierHostSourceRow, NotifierLeaseClaim, NotifierLeaseClaimInput } from '../../engine-sql/notifier.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The fencing token when this resident owns the host's lease, else the live holder. */
export const claimNotifierLease: StoreMember<[l: NotifierLeaseClaimInput], NotifierLeaseClaim> = async (brain, l) => {
  const claim = await storeCall({ member: 'claimNotifierLease' }, () =>
    brain.claimNotifierLease({ hostId: l.hostId, ownerId: l.ownerId, kind: l.kind, pid: l.pid, leaseMs: l.leaseMs })) as NotifierLeaseClaim;
  // The store stamps microseconds; the SQL engines read the expiry back as a millisecond ISO string.
  if (claim.owner || claim.holder === null) return claim;
  return { owner: false, holder: { ...claim.holder, expires_at: new Date(claim.holder.expires_at).toISOString() } };
};

/** Every source that is not archived, in id order. */
export const listNotifierHostSourceRows: StoreMember<[], NotifierHostSourceRow[]> = (brain) =>
  storeCall({ member: 'listNotifierHostSourceRows' }, () => brain.listNotifierHostSourceRows());
