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
// The delete is the typed engine member invalidateQueryCacheRows
// (engine-sql/query-cache-invalidate.ts); the Rust store keeps no query
// cache, so a Rust brain answers 0 instead of refusing.

import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';

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
 * A pre-v51 brain without the table returns {rows_invalidated: 0}. Any
 * other failure is thrown; the mutation post-hooks (mutate.ts) catch it so
 * the mutation itself still succeeds.
 *
 * `sourceId` omitted clears the whole table. Used by Phase 4 reload and
 * any cross-source mutation.
 */
export async function invalidateQueryCache(
  engine: BrainEngine,
  sourceId?: string,
): Promise<InvalidateQueryCacheResult> {
  try {
    return { rows_invalidated: await engine.invalidateQueryCacheRows(sourceId) };
  } catch (e) {
    // A brain from before the query cache has nothing cached; any other failure (a refused delete included) is thrown,
    // so a stale cache is never reported as cleared.
    if (isMissingSchemaObject(e, 'table', 'query_cache')) return { rows_invalidated: 0 };
    throw e;
  }
}
