/**
 * Token Budget Enforcement on Search Results (v0.32.x — search-lite)
 *
 * Caps the cumulative token cost of a ranked SearchResult[] so callers
 * (agents, MCP, the query op) can guarantee their search payload fits a
 * downstream context window. The enforcer is the LAST stage of the search
 * pipeline — all scoring, ranking, dedup, boosts, two-pass walk are done
 * before this fires. It does NOT re-rank; it walks top-down and skips any
 * result that would push the running total past the budget (the frozen
 * `packToBudget` used by the memory verbs stops at the first one instead).
 *
 * Token counting uses a deliberately cheap script-aware heuristic
 * (char/4, CJK 1/char) instead of
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
 * Pure module. No DB, no LLM, no async; the only ambient input is the
 * GBRAIN_SEARCH_SALVAGE env kill switch. Tested in test/token-budget.test.ts.
 */

import type { SearchResult } from '../types.ts';
import { CJK_SLUG_CHARS } from '../cjk.ts';

const CJK_CHAR = new RegExp(`[${CJK_SLUG_CHARS}]`);
const CJK_CHARS_G = new RegExp(`[${CJK_SLUG_CHARS}]`, 'g');

/**
 * Cheap script-aware token estimate. Returns 0 for empty strings.
 *
 * OpenAI-style tokenizers average ~4 chars/token for English prose (closer
 * to 3 for punctuation-heavy code) but ~1 token per CJK character, so CJK
 * characters cost 1 each and everything else char/4. Overshoot is fine for
 * a safety budget; undershoot would let a payload blow past the cap, so
 * the total rounds UP.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const cjk = text.match(CJK_CHARS_G)?.length ?? 0;
  return Math.ceil((text.length - cjk) / 4) + cjk;
}

/**
 * Longest prefix of `text` whose `estimateTokens` cost is <= `maxTokens`,
 * cut on a code-point boundary (never a lone surrogate).
 */
function sliceToTokens(text: string, maxTokens: number): string {
  let cjk = 0;
  let other = 0;
  let end = 0;
  for (const ch of text) {
    const nextCjk = CJK_CHAR.test(ch) ? cjk + 1 : cjk;
    const nextOther = nextCjk === cjk ? other + ch.length : other;
    if (Math.ceil(nextOther / 4) + nextCjk > maxTokens) break;
    cjk = nextCjk;
    other = nextOther;
    end += ch.length;
  }
  return text.slice(0, end);
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
  /**
   * WP2/T3 (ENG-2/FOV-2) — set when the minKeep failsafe kept ONE result
   * whose chunk_text was truncated (on a copy) to fit the budget. Only the
   * search wrapper (`enforceTokenBudget`) produces this; `packToBudget`
   * stays strict for the frozen verb consumers.
   */
  truncated?: boolean;
}

/**
 * WP2/T3 (ENG-7) — env-only kill switch for the fail-loud salvage behavior
 * (allSettled embed/vector fan-outs in hybrid.ts + the minKeep:1 budget
 * failsafe below). `GBRAIN_SEARCH_SALVAGE=off` restores the pre-wave
 * all-or-nothing embeds and the strict budget wrapper. Env-above-config on
 * purpose (incident escape hatch, pace-mode precedent); no config surface.
 */
export function searchSalvageEnabled(): boolean {
  return process.env.GBRAIN_SEARCH_SALVAGE !== 'off';
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
 *     (Intentionally strict: the caller asked for a hard cap. FROZEN for
 *     the memory-verb consumers — recall/entity/context_pack budget-pack
 *     through this; the search wrapper enforceTokenBudget layers its
 *     minKeep failsafe on top, never here.)
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
 * with the SearchResult cost model (title + chunk_text). Pinned by
 * test/token-budget.test.ts.
 *
 * WP2/T3 (ENG-2/FOV-2) minKeep:1 failsafe: when the FIRST result alone
 * exceeds the budget (packToBudget's strict [] edge), keep one result with
 * chunk_text truncated to fit — on a COPY, never mutating the shared
 * SearchResult (it flows on to cache write + eval capture). A budget below
 * even the title-only cost truncates the TITLE too (chunk_text: ''), so
 * `used <= budget` holds unconditionally — a hard cap that can be exceeded
 * is not a cap. The failsafe lives HERE, not in packToBudget, because it also
 * feeds the frozen memory-verb paths (recall/entity/context_pack) whose
 * strict-cap contract must not drift. `GBRAIN_SEARCH_SALVAGE=off`
 * restores the strict [] behavior (ENG-7).
 */
export function enforceTokenBudget(
  results: SearchResult[],
  budget: number | undefined,
): { results: SearchResult[]; meta: TokenBudgetMeta } {
  const safeBudget = typeof budget === 'number' && budget > 0 ? budget : 0;
  if (safeBudget === 0 || results.length === 0) {
    const passthrough = packToBudget(results, resultTokens, budget);
    return { results: passthrough.items, meta: passthrough.meta };
  }
  // Once the head fits, a result that does not fit is skipped and packing
  // continues: one oversized chunk must not drop every lower-ranked result
  // after it. An oversized HEAD still takes the minKeep path below.
  const items: SearchResult[] = [];
  let used = 0;
  for (const r of results) {
    const c = resultTokens(r);
    if (used + c <= safeBudget) {
      items.push(r);
      used += c;
    } else if (items.length === 0) {
      break;
    }
  }
  const meta: TokenBudgetMeta = { budget: safeBudget, used, dropped: results.length - items.length, kept: items.length };
  if (items.length === 0 && searchSalvageEnabled()) {
    const first = results[0];
    // Title first (a sub-title-cost budget slices the title itself), then
    // the chunk gets what is left, both cut by estimated cost on code-point
    // boundaries, so used <= budget holds unconditionally.
    const title = sliceToTokens(first.title ?? '', meta.budget);
    const chunk = sliceToTokens(first.chunk_text, meta.budget - estimateTokens(title));
    const copy: SearchResult = { ...first, title, chunk_text: chunk };
    return {
      results: [copy],
      meta: {
        budget: meta.budget,
        used: resultTokens(copy),
        dropped: results.length - 1,
        kept: 1,
        truncated: true,
      },
    };
  }
  return { results: items, meta };
}
