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
    const cache = new SemanticQueryCache(engine);
    const rows_invalidated = await cache.clear(sourceId !== undefined ? { sourceId } : {});
    return { rows_invalidated };
  } catch {
    return { rows_invalidated: 0 };
  }
}
