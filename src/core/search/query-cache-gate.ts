/**
 * Cache invalidation gate (v0.40.3.0 base — D2 + D6 + D11; v0.41.19.0
 * rewrite — D18 + D20, codex CDX-1/CDX-2/CDX-5/CDX-6).
 *
 * Two pure helpers wired by query-cache.ts at store + lookup time. Pure
 * surface lets us unit-test the two-layer gate logic without a real cache.
 *
 * Layer 1 (cheap bookmark): `page_generation_clock.value` <=
 *   `query_cache.max_generation_at_store`. If true, no page write has
 *   happened since this row stored, so the row is fresh corpus-wide.
 *
 * Layer 2 (per-page snapshot): if bookmark fires, fall through to the
 *   `page_generations JSONB` snapshot. For each `(page_id, stored_gen)`
 *   pair, compare to current `pages.generation`. Any mismatch (page
 *   deleted, page bumped) invalidates. **Empty `page_generations = {}`
 *   does NOT pass Layer 2 in v0.41.19.0+** — empty snapshots have no
 *   per-page signal to invalidate against, so they MUST rely on Layer 1
 *   exclusively (CDX-6 fix: pre-v0.41.19.0 the vacuous-valid path let
 *   empty-result cache rows survive across writes that should have
 *   invalidated them).
 *
 * Why the rewrite: pre-v0.41.19.0 Layer 1 read `MAX(generation) FROM
 * pages`, but the per-row trigger sets `NEW.generation = OLD.generation
 * + 1` on UPDATE. Updating a NON-MAX page didn't advance MAX(generation),
 * so the bookmark silently passed stale cache rows (codex CDX-2). DELETE
 * doesn't fire the trigger AT ALL, so deletion didn't advance MAX either
 * (codex CDX-1). Migration v105 introduces a global single-row counter
 * (`page_generation_clock`) bumped per-statement by a separate trigger;
 * Layer 1 now reads the counter directly so every INSERT/UPDATE/DELETE
 * statement advances the bookmark exactly once regardless of which rows
 * changed.
 *
 * Backward compat: rows stored before v0.40.3.0 have
 *   `max_generation_at_store = 0` AND `page_generations = '{}'::jsonb`.
 *   Layer 1 check on a populated brain: `clock > 0` so Layer 1 fails.
 *   Layer 2 v0.41.19.0+ stricter: empty `{}` no longer passes — legacy
 *   rows invalidate on first post-upgrade lookup. Cache fills back up
 *   naturally; correct semantics restored. The pre-v0.41.19.0 IRON-RULE
 *   "legacy rows serve via vacuously-valid Layer 2" is intentionally
 *   reversed: that path was the CDX-6 bug.
 *
 * Per-page `pages.generation` column + its row-level trigger
 * (`bump_page_generation_trg`) stay in place. Layer 2 reads from them
 * — Layer 2 only needs per-page advancement (which the row-level trigger
 * delivers correctly), NOT a MAX-style aggregate.
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
      // Empty-result query: only need the Layer 1 bookmark (clock value).
      // Per D20, empty-result cache rows trust Layer 1 exclusively;
      // bumping the clock on subsequent writes correctly invalidates them.
      const rows = await engine.executeRaw<{ v: number }>(
        `SELECT COALESCE((SELECT value FROM page_generation_clock WHERE id = 1), 0)::bigint AS v`,
      );
      snapshot.max_generation_at_store = Number(rows[0]?.v ?? 0);
      return snapshot;
    }

    // Combined query: per-page generation (Layer 2 substrate) + global
    // clock value (Layer 1 bookmark). UNION ALL folds both into one
    // round trip. The 'CLOCK' tag row is identified by `is_max = true`
    // (field name preserved for back-compat at the call site).
    const rows = await engine.executeRaw<{
      k: string;
      v: number;
      is_max: boolean;
    }>(
      `SELECT id::text AS k, generation::bigint AS v, FALSE AS is_max
         FROM pages WHERE id = ANY($1::int[])
       UNION ALL
       SELECT 'CLOCK' AS k,
              COALESCE((SELECT value FROM page_generation_clock WHERE id = 1), 0)::bigint AS v,
              TRUE AS is_max`,
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
    // Pre-v105 brain (no `page_generation_clock` table yet). Return the
    // empty snapshot with zero bookmark — every cache row will fall
    // through to Layer 2 (which is stricter post-v0.41.19.0 and will
    // invalidate empty snapshots). Acceptable upgrade-path one-time
    // cache miss; migration v105 fills the table within the same
    // initSchema() call so this branch is short-lived.
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
    -- Layer 1 (cheap bookmark): O(1) single-row read from page_generation_clock.
    -- Bumped per-statement by bump_page_generation_clock_trg on every INSERT,
    -- UPDATE, or DELETE on pages. If no statement has fired since this row
    -- stored, the row is fresh corpus-wide.
    COALESCE((SELECT value FROM page_generation_clock WHERE id = 1), 0)
      <= qc.max_generation_at_store
    OR
    -- Layer 2 (per-page snapshot): bookmark fired, but maybe THIS row's
    -- specific result set isn't affected. v0.41.19.0+ requires the snapshot
    -- to be non-empty — empty {} snapshots cannot disprove staleness, so
    -- they invalidate when Layer 1 fails (D20 / codex CDX-6 fix). Per-page
    -- mismatch (page deleted via LEFT JOIN p.id IS NULL, or page generation
    -- bumped) invalidates.
    (
      qc.page_generations <> '{}'::jsonb
      AND NOT EXISTS (
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
  // Layer 1: bookmark. `current.max_generation` is the global clock value
  // (kept named max_generation for back-compat at call sites; the underlying
  // read source switched from MAX(pages.generation) to
  // page_generation_clock.value in v0.41.19.0).
  if (current.max_generation <= snapshot.max_generation_at_store) return true;

  // Layer 2 (v0.41.19.0+ stricter, D20 / codex CDX-6): empty per-page
  // snapshots cannot disprove staleness, so they invalidate when Layer 1
  // fails. Pre-v0.41.19.0 callers got a "vacuously valid" pass that
  // silently served stale empty-result rows across writes.
  const ids = Object.keys(snapshot.page_generations);
  if (ids.length === 0) return false;

  for (const id of ids) {
    const storedGen = snapshot.page_generations[id];
    const currentGen = current.page_generations[id];
    if (currentGen === undefined) return false; // Page deleted.
    if (currentGen !== storedGen) return false; // Page bumped.
  }
  return true;
}
