/**
 * Cache invalidation gate (v0.40.3.0 — D2 + D6 + D11)
 *
 * Two pure helpers wired by query-cache.ts at store + lookup time. Pure
 * surface lets us unit-test the two-layer gate logic without a real cache.
 *
 * Layer 1 (cheap bookmark): `MAX(generation) FROM pages` <=
 *   `query_cache.max_generation_at_store`. If true, brain has not been
 *   written since this row stored, so the row is fresh corpus-wide.
 *
 * Layer 2 (per-page snapshot): if bookmark fires, fall through to the
 *   `page_generations JSONB` snapshot. For each `(page_id, stored_gen)`
 *   pair, compare to current `pages.generation`. Any mismatch (page
 *   deleted, page bumped) invalidates.
 *
 * Backward compat: rows stored before v0.40.3.0 have
 *   `max_generation_at_store = 0` AND `page_generations = '{}'::jsonb`.
 *   Bookmark check: `MAX <= 0` is false on any populated brain, so we fall
 *   through to Layer 2; Layer 2 sees `'{}'::jsonb` and is vacuously valid.
 *   Legacy rows continue to serve naturally (IRON-RULE regression pinned
 *   in test/e2e/cache-gate-pglite.test.ts).
 *
 * See plan ~/.claude/plans/system-instruction-you-are-working-enchanted-mountain.md
 * Phase 2A for full design.
 */

import type { BrainEngine } from '../engine.ts';

/**
 * Snapshot of (pageId, generation) pairs plus the corpus-state MAX
 * captured at cache-store time. Stored as JSONB (page_generations) +
 * BIGINT (max_generation_at_store).
 */
export interface PageGenerationsSnapshot {
  /**
   * Map of page_id (stringified) → generation (integer). Empty when no
   * results have valid page_ids (e.g., empty-result-set query — still
   * cacheable; bookmark check covers freshness).
   */
  page_generations: Record<string, number>;
  /**
   * MAX(generation) FROM pages at snapshot time. The corpus-state bookmark.
   * Zero when the brain has no pages (fresh install before first put_page).
   */
  max_generation_at_store: number;
}

/**
 * Build the page-generations snapshot for a set of page_ids in one SQL
 * round trip. Used by query-cache.ts:store() at cache-write time.
 *
 * UNION ALL combines the per-page fetch with the corpus-state MAX into
 * one round trip — Postgres / PGLite both fold both branches into a
 * single result set. The 'MAX' tag row is identified by `is_max = true`.
 *
 * @param engine - BrainEngine to query.
 * @param pageIds - Page IDs from the SearchResult set being cached. Pass
 *   an empty array for empty-result queries; the snapshot will be empty
 *   but the bookmark still captures MAX(generation).
 * @returns PageGenerationsSnapshot suitable for INSERT into query_cache.
 */
export async function buildPageGenerationsSnapshot(
  engine: BrainEngine,
  pageIds: number[],
): Promise<PageGenerationsSnapshot> {
  // Empty pageIds: just fetch MAX(generation) for the bookmark. Skip the
  // per-page branch entirely (UNION ALL with an empty IN clause is a
  // valid SQL but skipping saves one ARRAY[] construction).
  const snapshot: PageGenerationsSnapshot = {
    page_generations: {},
    max_generation_at_store: 0,
  };

  try {
    if (pageIds.length === 0) {
      const rows = await engine.executeRaw<{ v: number }>(
        `SELECT COALESCE(MAX(generation), 0)::bigint AS v FROM pages`,
      );
      snapshot.max_generation_at_store = Number(rows[0]?.v ?? 0);
      return snapshot;
    }

    // Combined query: per-page generation + corpus-state MAX.
    const rows = await engine.executeRaw<{
      k: string;
      v: number;
      is_max: boolean;
    }>(
      `SELECT id::text AS k, generation::bigint AS v, FALSE AS is_max
         FROM pages WHERE id = ANY($1::int[])
       UNION ALL
       SELECT 'MAX' AS k, COALESCE(MAX(generation), 0)::bigint AS v, TRUE AS is_max
         FROM pages`,
      [pageIds],
    );

    for (const row of rows) {
      const v = Number(row.v);
      if (row.is_max) {
        snapshot.max_generation_at_store = v;
      } else {
        snapshot.page_generations[row.k] = v;
      }
    }
    return snapshot;
  } catch {
    // Pre-v91 brain (no `generation` column yet). Return the
    // backward-compat empty snapshot with zero bookmark — every cache
    // row will fall through to Layer 2 and serve via the `'{}'::jsonb`
    // vacuously-valid path. Closes the upgrade-path gap.
    return snapshot;
  }
}

/**
 * The SQL fragment that lookup() embeds inside its WHERE clause to apply
 * the two-layer gate. Exported as a string so the test suite can grep
 * for shape invariants (e.g., assert the bookmark uses MAX(generation)
 * and the per-page check uses jsonb_each).
 *
 * Placeholder semantics:
 *   - qc — the `query_cache` row alias used by the caller's outer SELECT.
 *
 * The fragment is a single boolean expression suitable for AND-ing with
 * the rest of the lookup's WHERE clause. It does NOT include a leading
 * AND — caller provides that.
 */
export const CACHE_GATE_WHERE_CLAUSE = `
  (
    -- Layer 1 (cheap bookmark): O(log N) MAX(generation) via pages_generation_idx.
    -- If no page has been bumped since this row stored, the row is fresh.
    (SELECT COALESCE(MAX(generation), 0) FROM pages) <= qc.max_generation_at_store
    OR
    -- Layer 2 (per-page snapshot): bookmark fired, but maybe this row's
    -- specific result set isn't affected. Pre-v0.40.3.0 rows have
    -- page_generations = '{}'::jsonb and serve vacuously (legacy compat —
    -- IRON-RULE regression in test/e2e/cache-gate-pglite.test.ts).
    (
      qc.page_generations = '{}'::jsonb
      OR NOT EXISTS (
        SELECT 1
        FROM jsonb_each(qc.page_generations) AS g(page_id, stored_gen)
        LEFT JOIN pages p ON p.id = (g.page_id)::int
        WHERE p.id IS NULL                              -- page deleted → invalidate
           OR p.generation <> ((g.stored_gen)::text)::bigint  -- bumped → invalidate
      )
    )
  )
`;

/**
 * Pure validator for unit testing: given a cache row's snapshot and the
 * current brain state, return whether the cache row is still valid.
 *
 * @param snapshot - The (page_generations, max_generation_at_store) tuple
 *   stored on the cache row.
 * @param current - The current brain state: MAX(generation) plus the
 *   current generation of every (formerly-)stored page. Use `undefined`
 *   for pages that no longer exist (deleted).
 * @returns true if the cache row would still serve; false if it has
 *   invalidated and the caller should re-query.
 */
export function validateCacheRowAgainstPages(
  snapshot: PageGenerationsSnapshot,
  current: {
    max_generation: number;
    page_generations: Record<string, number | undefined>;
  },
): boolean {
  // Layer 1: bookmark.
  if (current.max_generation <= snapshot.max_generation_at_store) return true;

  // Layer 2: per-page snapshot.
  const ids = Object.keys(snapshot.page_generations);
  if (ids.length === 0) return true; // Vacuously valid (legacy + zero-page).

  for (const id of ids) {
    const storedGen = snapshot.page_generations[id];
    const currentGen = current.page_generations[id];
    if (currentGen === undefined) return false; // Page deleted.
    if (currentGen !== storedGen) return false; // Page bumped.
  }
  return true;
}
