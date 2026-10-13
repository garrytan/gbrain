/**
 * W5 (memory proof wave 2): the page-unit ranking cut from the caller's budget.
 *
 * With `return_unit: "page"` and a caller `token_budget`, delivery packs whole
 * pages into that budget, but ranking cut its hits by chunk tokens against the
 * mode's `search.tokenBudget` (4000 conservative, none under tokenmax). Under
 * tokenmax delivery was handed far more pages than it could deliver whole, and
 * each arrived as a sliver; under a mode cut, small pages under-filled the
 * budget. `search.page_rank_cut: whole_pages` (the default; `off` restores the
 * old path) instead stops adding page candidates once their whole delivered
 * pages fill `factor x caller budget` (`search.page_rank_cut_factor`, default
 * 1.5, picked on memory proof wave 2 dev).
 *
 * Ranking lifts the mode's chunk-token cut for such a call (`liftModeCut`), so
 * a mode cut can never under-fill the budget, and delivery applies the cut
 * with its own page sizes (`cutWholePages` below, priced by evidence-delivery.ts `wholeCost`). Chunk-unit
 * calls and calls without a caller budget never engage it.
 */
import type { BrainEngine } from '../engine.ts';
import type { ResolvedSearchKnobs } from './mode.ts';

export const PAGE_RANK_CUT_KEY = 'search.page_rank_cut';
export const PAGE_RANK_CUT_FACTOR_KEY = 'search.page_rank_cut_factor';
export const DEFAULT_PAGE_RANK_CUT_FACTOR = 1.5;

/** The cut a page-unit plan asks for (resolved once per call). */
export interface PageRankCut {
  mode: 'whole_pages';
  factor: number;
  caller_budget: number;
}

/** `delivery.page_rank_cut`: the target, the whole-page cost kept, and the page candidates before and after the cut. */
export interface PageRankCutMeta extends PageRankCut {
  /** floor(factor x the budget the pages share: the caller budget less saved-fact rows). */
  target: number;
  /** Whole delivered cost (text, title, date header) of the kept pages. */
  applied_cost: number;
  candidates: number;
  kept: number;
}

async function readConfig(engine: BrainEngine, key: string): Promise<string | null> {
  try {
    return await engine.getConfig(key);
  } catch {
    return null;
  }
}

/** Undefined only when `search.page_rank_cut` is `off`; any other value is `whole_pages`, and a factor that is not a positive finite number reads as the default. */
export async function resolvePageRankCut(engine: BrainEngine, callerBudget: number): Promise<PageRankCut | undefined> {
  if ((await readConfig(engine, PAGE_RANK_CUT_KEY))?.trim().toLowerCase() === 'off') return undefined;
  const raw = await readConfig(engine, PAGE_RANK_CUT_FACTOR_KEY);
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return { mode: 'whole_pages', factor: Number.isFinite(n) && n > 0 ? n : DEFAULT_PAGE_RANK_CUT_FACTOR, caller_budget: callerBudget };
}

/** With a cut, ranking returns its full `limit`: delivery's whole-page cut replaces the mode's chunk-token cut. */
export function liftModeCut(knobs: ResolvedSearchKnobs, cut: PageRankCut | undefined): ResolvedSearchKnobs {
  return cut && knobs.tokenBudget !== undefined ? { ...knobs, tokenBudget: undefined } : knobs;
}

/**
 * `whole_pages`: keep rank-order pages while their whole delivered cost fits
 * `factor x budget`. The page that crosses it stays only when its floor (what
 * allocation reserves first) still fits what the whole pages before it leave
 * of the budget, so delivery would deliver part of it; rank one always stays.
 */
export function cutWholePages<T>(pages: T[], budget: number, cut: PageRankCut, whole: (p: T) => number, floor: (p: T) => number): { kept: T[]; meta: PageRankCutMeta } {
  const target = Math.max(1, Math.floor(cut.factor * budget));
  const kept: T[] = [];
  let cost = 0;
  for (const p of pages) {
    if (cost >= target) break;
    const w = whole(p);
    const fits = cost + w <= target;
    if (fits || kept.length === 0 || floor(p) <= budget - cost) {
      kept.push(p);
      cost += w;
    }
    if (!fits) break;
  }
  return { kept, meta: { ...cut, target, applied_cost: cost, candidates: pages.length, kept: kept.length } };
}
