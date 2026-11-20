import { classifyHolderLiveness } from '../db-lock.ts';
import type { BrainEngine } from '../engine.ts';
import { isWriteRequestId } from './types.ts';

/** Every cycle lock that is not a page embedding lease, by id, with the liveness of its holder. Read-only. */
export async function inspectLegacyWriterLocks(engine: Pick<BrainEngine, 'writerReleaseStore'>) {
  const rows = await (await engine.writerReleaseStore()).legacyLocks();
  return rows.map(row => ({ id: row.id, holder_pid: row.holder_pid, holder_host: row.holder_host, acquisition_token: row.acquisition_token,
    liveness: Number.isSafeInteger(row.holder_pid) && row.holder_pid > 0 && isWriteRequestId(row.acquisition_token)
      ? classifyHolderLiveness(row.holder_pid, row.holder_host, row.age_ms) : 'unknown' as const }));
}
