import type { SearchOpts, SearchResult } from '../types.ts';
import { resolveHardExcludes } from './source-boost.ts';

/**
 * Which detail levels get the compiled_truth boost (#3430).
 *
 * ONLY `low`. The documented contract (`src/core/operations.ts`) is
 * "low (compiled truth only), medium (default, all with dedup), high (all
 * chunks)" — so `low` is the level that privileges compiled truth, and both
 * `medium` and `high` are supposed to see everything on equal footing.
 *
 * This was previously spelled `detail !== 'high'`, i.e. written as though
 * `high` were the special case. Because COMPILED_TRUTH_BOOST is applied AFTER
 * RRF normalization, and RRF's whole range over a 100-deep pool is 1/60 → 1/160,
 * a 2.0x multiplier is not a tilt — break-even is `2/(60+r) >= 1/60`, so any
 * boosted chunk inside the first 60 ranks outranks an unboosted rank-1 chunk.
 * At the default detail that made search categorically compiled-truth-only:
 * a page whose answer lived in a `fenced_code` chunk returned the prose chunk,
 * and the code chunk fell out of the window entirely.
 *
 * Extracted as a named predicate rather than left inline at three call sites so
 * the detail→boost mapping is directly testable. An inline expression can only
 * be covered through a full `hybridSearch` round trip, which is why the
 * original inversion went unnoticed.
 */
export function shouldBoostCompiledTruth(detail: string | null | undefined): boolean {
  return detail === 'low';
}

/**
 * Defense-in-depth for candidate generators that do not query through the
 * engine SearchOpts surface (alias, relational, and structural-walk arms).
 * SQL-level filtering still happens first so excluded rows do not consume the
 * candidate budget; this final fence prevents a later arm from reintroducing
 * them after fusion.
 */
export function applyResultFilters(results: SearchResult[], opts?: SearchOpts): SearchResult[] {
  const hardExcludes = resolveHardExcludes(
    opts?.exclude_slug_prefixes,
    opts?.include_slug_prefixes,
  );
  const exactExcludes = new Set(opts?.exclude_slugs ?? []);
  const types = opts?.types?.length ? new Set(opts.types) : null;
  return results.filter((result) => {
    if (opts?.type && result.type !== opts.type) return false;
    if (types && !types.has(result.type)) return false;
    if (exactExcludes.has(result.slug)) return false;
    return !hardExcludes.some(prefix => result.slug.startsWith(prefix));
  });
}
