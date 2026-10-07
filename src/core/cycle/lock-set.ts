import type { DbLockHandle } from '../db-lock.ts';

type Lease = Pick<DbLockHandle, 'refresh' | 'release'>;
type LockSet = { handle: Lease; busyLockId?: never } | { handle: null; busyLockId: string };

/** Non-waiting acquisition: a cycle starts only after it owns every required lease. */
export async function acquireCycleLockSet(
  ids: readonly string[],
  acquire: (id: string) => Promise<Lease | null>,
): Promise<LockSet> {
  const held: Lease[] = [];
  const release = async () => {
    const failures: unknown[] = [];
    while (held.length > 0) {
      const lease = held.pop()!;
      try { await lease.release(); } catch (error) {
        // Still release the other leases; a single failed DELETE must not strand all of them.
        failures.push(error);
        console.error('[cycle] lock-set release failed:', error);
      }
    }
    if (failures.length > 0) throw failures[0];
  };
  try {
    for (const id of new Set(ids)) {
      const lease = await acquire(id);
      if (lease === null) {
        await release();
        return { handle: null, busyLockId: id };
      }
      held.push(lease);
    }
  } catch (error) {
    // Keep the acquisition error while making a best effort to release every lease.
    try { await release(); } catch { /* already reported above */ }
    throw error;
  }
  return {
    handle: {
      release,
      refresh: async (opts) => {
        if (held.length === 0) return false;
        for (const lease of held) {
          // Losing either fence invalidates the whole set. Do not renew later leases.
          if (!await lease.refresh(opts)) return false;
        }
        return true;
      },
    },
  };
}
