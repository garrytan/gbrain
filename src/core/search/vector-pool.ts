import type { SearchOpts } from '../types.ts';

export interface VectorPoolBatch {
  rows: Record<string, unknown>[];
  candidatePool: number;
  exhausted?: boolean;
}

export interface VectorPoolAttempt {
  innerLimit: number;
  maxScanTuples: number;
  remainingMs: number;
  exact: boolean;
}

export function remainingVectorBudget(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw Object.assign(new Error('Vector candidate deadline exhausted'), { code: '57014' });
  return remaining;
}

export async function searchVectorPool(
  limit: number,
  initialLimit: number,
  iterative: boolean,
  indexed: boolean,
  engine: 'postgres' | 'pglite',
  run: (attempt: VectorPoolAttempt) => Promise<VectorPoolBatch>,
  hasMore: (pool: number, remainingMs: number) => Promise<boolean>,
  onMeta: SearchOpts['onVectorPoolMeta'],
): Promise<Record<string, unknown>[]> {
  const deadline = performance.now() + 8_000;
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  let batch: VectorPoolBatch = { rows: [], candidatePool: 0 };
  let innerLimit = initialLimit;
  let escalations = 0;
  let exactFallback = false;
  let reason: 'candidate_budget' | 'iterative_scan_unavailable' | 'deadline' =
    indexed && !iterative ? 'iterative_scan_unavailable' : 'candidate_budget';
  try {
    for (;;) {
      if (remaining() === 0) { reason = 'deadline'; break; }
      batch = await run({ innerLimit, maxScanTuples: Math.min(2_000 * 4 ** escalations, 20_000), remainingMs: remaining(), exact: false });
      if (batch.rows.length >= limit) return batch.rows;
      if (batch.candidatePool < innerLimit) {
        if (!indexed) return batch.rows;
        if (remaining() === 0) { reason = 'deadline'; break; }
        if (!(await hasMore(batch.candidatePool, remaining()))) return batch.rows;
      }
      if (escalations >= 3 || (indexed && !iterative)) break;
      innerLimit = Math.min(innerLimit * 4, Math.max(initialLimit, 20_000));
      escalations++;
    }
    if (engine === 'postgres' && indexed && remaining() > 0) {
      exactFallback = true;
      batch = await run({ innerLimit, maxScanTuples: 20_000, remainingMs: remaining(), exact: true });
      if (batch.rows.length >= limit || batch.exhausted) return batch.rows;
      reason = remaining() === 0 ? 'deadline' : 'candidate_budget';
    }
  } catch (error) {
    if (engine !== 'postgres' || (error as { code?: string }).code !== '57014') throw error;
    reason = 'deadline';
  }
  onMeta?.({ underfilled: true, incomplete: true, reason, escalations, innerLimit, candidatePool: batch.candidatePool, exactFallback });
  return batch.rows;
}

export function readVectorPool(rows: Record<string, unknown>[]): VectorPoolBatch {
  return {
    rows: rows.filter(row => row.page_id != null),
    candidatePool: Number(rows[0]?.candidate_pool ?? 0),
  };
}
