/**
 * Token Budget Enforcement on Search Results (v0.32.x — search-lite)
 *
 * Caps the cumulative token cost of a ranked SearchResult[] so callers
 * (agents, MCP, the query op) can guarantee their search payload fits a
 * downstream context window. The enforcer is the LAST stage of the search
 * pipeline — all scoring, ranking, dedup, boosts, two-pass walk are done
 * before this fires. It does NOT re-rank; it greedily walks top-down and
 * stops when the next result would push the running total past the
 * budget.
 *
 * Token counting uses a deliberately cheap char/4 heuristic instead of
 * dropping in a real tokenizer (js-tiktoken is 1.5MB+ and would balloon
 * the bun build --compile bundle). The heuristic is accurate within
 * ~10-15% for English text and ~5-25% for mixed code/Unicode — over-
 * estimating in code (which is what we want for a safety budget). For
 * a precise count, the caller can subtract real-tokens-vs-heuristic in
 * post and re-run with a tighter budget.
 *
 * Backward-compatibility: when no budget is set (undefined or <=0), the
 * enforcer is a no-op. The pre-v0.32 contract for search results is
 * unchanged.
 *
 * Pure module. No DB, no LLM, no async. Tested in test/token-budget.test.ts.
 */

import type { SearchResult } from '../types.ts';

/**
 * Cheap char/4 token estimate. Returns 0 for empty strings.
 *
 * Why char/4: OpenAI's tokenization averages ~4 chars/token for English
 * prose; closer to 3 for code with lots of punctuation; up to 8 for
 * CJK. Overshoot is fine for a safety budget. Undershoot would let us
 * blow past the cap, so we round UP when in doubt.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  // Math.ceil so a 1-char string still costs at least 1 token.
  return Math.ceil(text.length / 4);
}

/**
 * Per-result token cost: title + chunk_text. Slug is metadata and
 * doesn't enter the assistant context, so we don't count it. If a
 * caller wants a different cost model (e.g. including timeline detail
 * or compiled_truth length), they can pre-shape the chunk_text before
 * calling enforceTokenBudget.
 */
export function resultTokens(r: SearchResult): number {
  return estimateTokens(r.title) + estimateTokens(r.chunk_text);
}

export interface TokenBudgetMeta {
  /** Token budget that was applied (verbatim from caller). */
  budget: number;
  /** Cumulative token cost of the returned results. */
  used: number;
  /** Count of results that were dropped to fit the budget. */
  dropped: number;
  /** Count of results actually returned. */
  kept: number;
}

/**
 * Generic greedy top-down budget packer (v1 memory-verbs protocol). Walks
 * the input in order, accumulates per-item costs via the caller-supplied
 * cost function, and stops as soon as adding the next item would exceed
 * the budget. Items are NOT re-ranked — caller's order is preserved.
 *
 * Edge cases (all preserve the pre-v0.32 contract):
 *   - budget undefined / <= 0: returns input unchanged; dropped=0, kept=N.
 *   - First item alone exceeds budget: returns []; dropped=N, kept=0.
 *     (Intentionally strict: the caller asked for a hard cap.)
 *   - Input empty: returns []; budget unused.
 */
export function packToBudget<T>(
  items: T[],
  cost: (item: T) => number,
  budget: number | undefined,
): { items: T[]; meta: TokenBudgetMeta } {
  const safeBudget = typeof budget === 'number' && budget > 0 ? budget : 0;

  if (safeBudget === 0 || items.length === 0) {
    return {
      items,
      meta: {
        budget: safeBudget,
        used: items.reduce((acc, it) => acc + cost(it), 0),
        dropped: 0,
        kept: items.length,
      },
    };
  }

  const kept: T[] = [];
  let used = 0;
  for (const it of items) {
    const c = cost(it);
    if (used + c > safeBudget) break;
    kept.push(it);
    used += c;
  }

  return {
    items: kept,
    meta: {
      budget: safeBudget,
      used,
      dropped: items.length - kept.length,
      kept: kept.length,
    },
  };
}

/**
 * Search-pipeline budget enforcement — a thin wrapper over packToBudget
 * with the SearchResult cost model (title + chunk_text). Behavior is
 * byte-identical to the pre-refactor implementation; pinned by
 * test/token-budget.test.ts.
 */
export function enforceTokenBudget(
  results: SearchResult[],
  budget: number | undefined,
): { results: SearchResult[]; meta: TokenBudgetMeta } {
  const { items, meta } = packToBudget(results, resultTokens, budget);
  return { results: items, meta };
}
