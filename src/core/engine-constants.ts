// v0.41.25.0 — single source of truth for engine batch-sizing.
//
// Both PostgresEngine and PGLiteEngine import from here so the constants
// cannot drift across engines. Lives outside `src/core/engine.ts` to avoid
// circular-import worries (engine.ts is the interface; engines depend on
// engine.ts; this file depends on neither).

/**
 * Maximum number of slugs per single batch `DELETE FROM pages WHERE slug =
 * ANY($1::text[])` call. Callers (e.g. `src/commands/sync.ts` delete loop)
 * are responsible for chunking input arrays to this size; `engine.deletePages`
 * is a single-batch primitive that does NOT chunk internally (matches the
 * `addLinksBatch` convention — caller owns chunking, engine assumes the
 * caller is well-behaved).
 *
 * 500 is the same order-of-magnitude as the effective per-call budget for
 * the existing `addLinksBatch` (postgres-engine.ts) — well under Postgres's
 * 65535 parameter cap. We bind a single array parameter so the cap doesn't
 * bite directly, but per-statement work stays bounded for predictable lock
 * hold time + write-amplification budget.
 *
 * The same constant is also used for batch `SELECT slug, source_path FROM
 * pages WHERE source_path = ANY($1::text[])` in `engine.resolveSlugsByPaths`.
 */
export const DELETE_BATCH_SIZE = 500;

/**
 * Total-row cap on `traversePaths` / `traversePathsDetailed` (both engines).
 * The breadth-first walk returns each qualifying edge once, but a hub's
 * neighbourhood can still hold far more edges than a caller can use. The
 * final SELECT is bounded to `CAP + 1` rows (the extra row is the truncation
 * probe): the ORDER BY depth contract means the DEEPEST edges are the ones
 * dropped, so a truncated result is still the complete shallow
 * neighbourhood. Counts raw rows before the provenance dedup, so the deduped
 * `paths.length` can be under the cap on a truncated walk.
 */
export const TRAVERSE_PATH_ROW_CAP = 5000;

/**
 * Cap on the pages a graph walk (`traverseGraph`, `traversePaths*`, both
 * engines) visits. The walk is breadth-first and visits each page once, so
 * its work is bounded by the pages and edges it touches; the cap bounds a walk
 * that reaches a huge share of the brain. It is enforced inside the recursion
 * in (depth, slug, id) order, so a capped walk keeps the complete shallow
 * neighbourhood. Before the breadth-first walk this capped enumerated simple
 * paths (a 12-page clique at depth 5 took 22 s).
 */
export const TRAVERSE_WALK_ROW_CAP = 20000;
