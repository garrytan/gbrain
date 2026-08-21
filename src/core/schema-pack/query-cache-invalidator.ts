// v0.40.6.0 Schema Cathedral v3 — query-cache invalidation hook.
//
// Codex C9: `schema sync --apply` and `schema add-type` change page
// types under cached search rows that were keyed by the OLD knobs_hash
// (which doesn't include schema-pack identity yet — that's a v0.41+
// design choice). Without invalidation, an agent who mutates the pack
// AND immediately re-queries sees stale results from the pre-mutation
// cache.
//
// The fix: after every successful withMutation, call
// `invalidateQueryCache(engine, sourceId)` which DELETEs all rows for
// the source. Cache rebuilds organically on next search — the only cost
// is one extra LLM expansion / vector call per query for the first few
// requests after a mutation. That's the right trade vs serving stale
// page types.
//
// Reuses the existing SemanticQueryCache.clear() method (already
// PGLite + Postgres parity-safe) rather than reinventing the SQL.

import type { BrainEngine } from '../engine.ts';
import { SemanticQueryCache } from '../search/query-cache.ts';

export interface InvalidateQueryCacheResult {
  rows_invalidated: number;
}

/**
 * Invalidate query_cache rows scoped to a source so search results
 * bound to the old knobs_hash don't serve stale page types after
 * schema mutations.
 *
 * Wave-D review: per-source invalidation must reach every row whose stored
 * result set can CONTAIN the mutated source, not just the scalar-keyed rows.
 * `cacheScopeKey` also writes `'__unscoped__'` rows (an unscoped search reads
 * ALL sources) and `'__set__:a,b,c'` rows (federated reads) — both can carry
 * the source's pages, so both go too. The `__set__` match is a cheap
 * comma-token LIKE on the id list; LIKE wildcards in an id (`_`) can only
 * OVER-match, and a false-positive delete is just one extra cache miss —
 * always the safe direction for an invalidator.
 *
 * Best-effort: failures (e.g. pre-v51 brain without the table) return
 * {rows_invalidated: 0} silently. Mutation hot-path must never break
 * because the cache invalidator fell over.
 *
 * `sourceId` omitted clears the whole table. Used by Phase 4 reload and
 * any cross-source mutation.
 */
export async function invalidateQueryCache(
  engine: BrainEngine,
  sourceId?: string,
): Promise<InvalidateQueryCacheResult> {
  try {
    if (sourceId === undefined) {
      const cache = new SemanticQueryCache(engine);
      const rows_invalidated = await cache.clear({});
      return { rows_invalidated };
    }
    // '__set__:' is 8 chars; substring(... from 9) is the sorted,
    // comma-joined id list. Wrapping both the list and the target in commas
    // makes the LIKE an exact token match ('a' never matches 'aa').
    const rows = await engine.executeRaw<{ n: number }>(
      `WITH deleted AS (
         DELETE FROM query_cache
         WHERE source_id = $1
            OR source_id = '__unscoped__'
            OR (source_id LIKE '\\_\\_set\\_\\_:%'
                AND (',' || substring(source_id from 9) || ',') LIKE ('%,' || $1 || ',%'))
         RETURNING 1
       )
       SELECT COUNT(*)::int AS n FROM deleted`,
      [sourceId],
    );
    return { rows_invalidated: rows[0]?.n ?? 0 };
  } catch {
    return { rows_invalidated: 0 };
  }
}
