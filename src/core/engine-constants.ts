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
