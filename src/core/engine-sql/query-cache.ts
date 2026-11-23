/**
 * The semantic query cache's clear (search/query-cache.ts SemanticQueryCache.clear), as a typed member so every engine
 * answers it. Each statement is spelled once as a whole literal (the check-engine-sql-dynamic guard).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** Deletes every `query_cache` row, or the rows of one source; the number deleted. */
export async function clearQueryCache(tx: Raw, sourceId?: string): Promise<number> {
  const rows = sourceId
    ? await tx.executeRaw<{ n: number }>('WITH deleted AS (DELETE FROM query_cache WHERE source_id = $1 RETURNING 1) SELECT COUNT(*)::int AS n FROM deleted', [sourceId])
    : await tx.executeRaw<{ n: number }>('WITH deleted AS (DELETE FROM query_cache RETURNING 1) SELECT COUNT(*)::int AS n FROM deleted');
  return Number(rows[0]?.n ?? 0);
}
