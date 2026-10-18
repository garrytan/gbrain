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

/**
 * `hnsw.max_scan_tuples` for every pooled attempt: pgvector's own default.
 * A filtered pooled attempt asks for `innerLimit` eligible chunks and is
 * accepted once they cover `limit` pages, so its scan budget decides how far
 * it can reach. At 2,000 tuples a 10% source or visibility filter found about
 * 200 eligible chunks: enough pages to be accepted, too shallow to hold the
 * true neighbours. At 20,000 the window fills down to about 1% selectivity
 * at limit 50: 10%-filter recall@50 rose from 0.52-0.63 to 0.96-0.99 on 1M and
 * 2M synthetic chunks and from 0.77 to 0.97 on 1M voyage-4 chunks under a
 * random filter, for 16 to 36 ms more p50 (docs/eval/hnsw-scale-bench.md).
 * An unfiltered scan stops at its LIMIT long before either budget, so only
 * filtered searches pay for the deeper visit.
 */
export const POOL_MAX_SCAN_TUPLES = 20_000;

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
      batch = await run({ innerLimit, maxScanTuples: POOL_MAX_SCAN_TUPLES, remainingMs: remaining(), exact: false });
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
      batch = await run({ innerLimit, maxScanTuples: POOL_MAX_SCAN_TUPLES, remainingMs: remaining(), exact: true });
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
