/**
 * The schema-pack query-cache invalidation (src/core/schema-pack/query-cache-invalidator.ts): after a schema-pack
 * mutation, the cached search results of one source (its own rows, the unscoped rows and every federated set naming it)
 * or of every source are deleted. One implementation for both engines. The Rust store keeps no query cache (no search
 * result is cached on a Rust brain: rust/docs/store/embedding-catalog.md), so its member deletes nothing and answers 0.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

// '__set__:' is 8 chars; substring(... from 9) is the sorted, comma-joined id list. Wrapping both the list and the
// target in commas makes the LIKE an exact token match ('a' never matches 'aa').
const INVALIDATE_SOURCE_CACHE_SQL = `WITH deleted AS (
         DELETE FROM query_cache
         WHERE source_id = $1
            OR source_id = '__unscoped__'
            OR (source_id LIKE '\\_\\_set\\_\\_:%'
                AND (',' || substring(source_id from 9) || ',') LIKE ('%,' || $1 || ',%'))
         RETURNING 1
       )
       SELECT COUNT(*)::int AS n FROM deleted`;
const INVALIDATE_ALL_CACHE_SQL = `WITH deleted AS (DELETE FROM query_cache RETURNING 1)
         SELECT COUNT(*)::int AS n FROM deleted`;

/** Deletes the cached results of `sourceId` (every cached result when omitted); the rows deleted. A failed delete throws. */
export async function invalidateQueryCacheRows(raw: EngineRawRead, sourceId?: string): Promise<number> {
  const rows = sourceId === undefined ? await raw<{ n: number }>(INVALIDATE_ALL_CACHE_SQL) : await raw<{ n: number }>(INVALIDATE_SOURCE_CACHE_SQL, [sourceId]);
  return rows[0]?.n ?? 0;
}
