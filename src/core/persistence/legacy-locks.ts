import { classifyHolderLiveness } from '../db-lock.ts';
import type { BrainEngine } from '../engine.ts';
import { PAGE_EMBEDDING_LEASE_PREFIX } from '../page-embedding-lease.ts';
import { isWriteRequestId } from './types.ts';

/**
 * Every legacy writer lease (`gbrain_cycle_locks` rows other than page-embedding leases), by id in byte order, with
 * the holder's liveness. Reads through the typed `readCycleLocks`; the age compares the database's stamps with its
 * own clock (#7614).
 */
export async function inspectLegacyWriterLocks(engine: Pick<BrainEngine, 'readCycleLocks'>) {
  const rows = (await engine.readCycleLocks({ by: 'all' }))
    .filter(row => !row.id.startsWith(PAGE_EMBEDDING_LEASE_PREFIX))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.map(row => {
    const ageMs = new Date(row.db_now).getTime() - new Date(row.acquired_at).getTime();
    return { id: row.id, holder_pid: row.holder_pid, holder_host: row.holder_host, acquisition_token: row.acquisition_token,
      liveness: Number.isSafeInteger(row.holder_pid) && row.holder_pid > 0 && isWriteRequestId(row.acquisition_token)
        ? classifyHolderLiveness(row.holder_pid, row.holder_host, ageMs) : 'unknown' as const };
  });
}
