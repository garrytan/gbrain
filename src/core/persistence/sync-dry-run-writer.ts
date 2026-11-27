/**
 * #7167: what a managed dry run reports about the source's writer instead of waiting on it: the open write requests
 * (queued, running or recovering), the oldest one's age, and the read-only command that explains them.
 */
import type { BrainEngine } from '../engine.ts';
import { syncRows } from '../engine-sql/managed-sync-store.ts';

export interface DryRunWriterState { open_requests: number; oldest_open_age_seconds: number | null; next: string[] }

export async function readDryRunWriterState(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<DryRunWriterState> {
  const [open] = await syncRows<{ n: number | string; age: number | string | null }>(engine, 'open_writer_requests', [sourceId]);
  return { open_requests: Number(open?.n ?? 0), oldest_open_age_seconds: open?.age == null ? null : Math.round(Number(open.age)),
    next: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] };
}
