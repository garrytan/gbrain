import type { SearchOpts } from '../types.ts';
import type { VectorSearchStatement } from './vector-statement.ts';

export interface VectorPoolBatch {
  rows: Record<string, unknown>[];
  /** Raw candidate rows the window returned; a short window means the index ran dry. */
  candidatePool: number;
  /** Candidates that passed the content-freshness filter outside the CTE; defaults to `candidatePool`. */
  eligiblePool?: number;
  exhausted?: boolean;
}

export interface VectorPoolAttempt {
  innerLimit: number;
  maxScanTuples: number;
  remainingMs: number;
  exact: boolean;
  /** Run the statement's `indexWalkSql` with INDEX_WALK_SETTINGS instead of `sql`. */
  indexWalk?: boolean;
  /** Run the statement's `scopeScanSql` instead of `sql`. */
  scopeScan?: boolean;
}

/**
 * Runs the statement's index walk, then its scope scan (each when present),
 * before the pool. Walk rows answer the search when its window is full and
 * they fill the limit; scope-scan rows when they fill the limit or the scope
 * ran out of eligible chunks (a short window). Otherwise, or past an
 * attempt's 2 s budget, this returns null and the caller runs the pool. The
 * walk may visit its whole over-fetched window, so its tuple budget covers it.
 */
export async function searchIndexWalk(
  stmt: Pick<VectorSearchStatement, 'indexWalkSql' | 'scopeScanSql' | 'innerLimit' | 'indexWalkOverfetch'>,
  limit: number,
  run: (attempt: VectorPoolAttempt) => Promise<VectorPoolBatch>,
): Promise<Record<string, unknown>[] | null> {
  const attempt = async (kind: { indexWalk: true } | { scopeScan: true }) => {
    try {
      return await run({ innerLimit: stmt.innerLimit, maxScanTuples: Math.max(2_000, stmt.innerLimit * stmt.indexWalkOverfetch), remainingMs: 2_000, exact: false, ...kind });
    } catch (error) {
      if ((error as { code?: string }).code === '57014') return null;
      throw error;
    }
  };
  if (stmt.indexWalkSql) {
    const batch = await attempt({ indexWalk: true });
    if (batch && batch.candidatePool >= stmt.innerLimit && batch.rows.length >= limit) return batch.rows;
  }
  if (stmt.scopeScanSql) {
    const batch = await attempt({ scopeScan: true });
    if (batch && (batch.rows.length >= limit || batch.candidatePool < stmt.innerLimit)) return batch.rows;
  }
  return null;
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
        if (!(await hasMore(batch.eligiblePool ?? batch.candidatePool, remaining()))) return batch.rows;
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
  const batch: VectorPoolBatch = {
    rows: rows.filter(row => row.page_id != null),
    candidatePool: Number(rows[0]?.candidate_pool ?? 0),
  };
  if (rows[0]?.eligible_pool != null) batch.eligiblePool = Number(rows[0].eligible_pool);
  return batch;
}
