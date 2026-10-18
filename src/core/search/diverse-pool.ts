/**
 * Session-diverse candidate pool before the reranker (`search.diverse_pool_depth`,
 * BEAM-1M wave 3 item S1; off in every bundle).
 *
 * On BEAM-1M dev, 30 of the 57 questions with no gold session in the top 5 were
 * semantic drift: other sessions outranked the gold, and the reranker reads only
 * `reranker_top_n_in` rows, where several chunks of one session can take the
 * slots the gold competes for. With depth N > 0, hybridSearch (1) fetches at
 * least N candidates per retrieval arm (hybrid/request.ts, still capped at
 * MAX_SEARCH_LIMIT unless an eval pool depth is set), (2) keeps one row per
 * session in the deduped pool (`capPerSession`, hybrid.ts) and (3) lets the
 * reranker read at least N rows (hybrid/rank.ts). The keyword-only paths have
 * no reranker and are unchanged.
 *
 * A session is the group `sessionPrefix` (graph-signals.ts) derives from a
 * session-shaped slug (`chat/<id>`, `.../session/<id>`, a dated segment);
 * every other page is its own session. Keys include the source id.
 */
import type { SearchResult } from '../types.ts';
import { MAX_SEARCH_LIMIT } from '../engine.ts';
import { sessionPrefix } from './graph-signals.ts';

export const DIVERSE_POOL_DEPTH_KEY = 'search.diverse_pool_depth';

/** Inclusive upper bound of `search.diverse_pool_depth`: the production per-arm cap. */
export const DIVERSE_POOL_DEPTH_MAX = MAX_SEARCH_LIMIT;

/**
 * The ONE range contract for `search.diverse_pool_depth`: an integer in
 * [0, DIVERSE_POOL_DEPTH_MAX] (or a string parsing to one); `off`/`false` is 0;
 * anything else is undefined (falls through to the bundle).
 */
export function normalizeDiversePoolDepth(v: unknown): number | undefined {
  if (v === 'off' || v === false) return 0;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= DIVERSE_POOL_DEPTH_MAX ? n : undefined;
}

/** The `gbrain config set` refusal message for an out-of-contract value, or null (search/config-values.ts). */
export function diversePoolDepthValueProblem(value: string): string | null {
  return normalizeDiversePoolDepth(value) === undefined
    ? `${DIVERSE_POOL_DEPTH_KEY} must be an integer from 0 to ${DIVERSE_POOL_DEPTH_MAX} or off (got ${value})` : null;
}

/** Keeps the first row of each session in input order (callers pass a score-ordered pool). */
export function capPerSession(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.source_id ?? 'default'}:${sessionPrefix(r.slug) ?? r.slug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
