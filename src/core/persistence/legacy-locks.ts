import { classifyHolderLiveness } from '../db-lock.ts';
import type { SqlEngine } from './model.ts';
import { isWriteRequestId } from './types.ts';

export async function inspectLegacyWriterLocks(engine: SqlEngine) {
  const rows = await engine.executeRaw<{ id: string; holder_pid: number; holder_host: string; acquisition_token: string; age_ms: number }>(
    `SELECT id,holder_pid,holder_host,acquisition_token,EXTRACT(EPOCH FROM (now()-acquired_at))::double precision*1000 AS age_ms
      FROM gbrain_cycle_locks ORDER BY id`);
  return rows.map(row => ({ id: row.id, holder_pid: row.holder_pid, holder_host: row.holder_host, acquisition_token: row.acquisition_token,
    liveness: Number.isSafeInteger(row.holder_pid) && row.holder_pid > 0 && isWriteRequestId(row.acquisition_token)
      ? classifyHolderLiveness(row.holder_pid, row.holder_host, row.age_ms) : 'unknown' as const }));
}
