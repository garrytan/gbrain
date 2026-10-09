import type { EvidencePlan } from './evidence-delivery.ts';

/**
 * A page-unit plan fills a token budget, so its hits are not cut for
 * precision first: autocut stays off unless the caller asks for it, and a
 * budget larger than the default row count can fill raises the row count (one
 * row per ~250 tokens, at most 100). Otherwise the page lane stopped at the
 * default rows (often ~10 after autocut) with half its budget unused.
 */
export function pagePlanHits(plan: EvidencePlan | null): { limit?: number; autocut?: false } {
  if (!plan || plan.unit !== 'page' || !(plan.budgetTokens > 0)) return {};
  const rows = Math.min(100, Math.ceil(plan.budgetTokens / 250));
  return { autocut: false, ...(rows > 25 ? { limit: rows } : {}) };
}
