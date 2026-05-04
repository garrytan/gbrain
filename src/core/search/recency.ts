/**
 * Recency Boost for Search Results (v0.27.0)
 *
 * Applies a time-decay boost to search results so newer pages rank higher.
 * Uses a hyperbolic decay curve — recent pages get a meaningful boost,
 * but old pages aren't completely buried.
 *
 * Boost formula: score *= (1 + coefficient / (1 + days_old / halflife))
 *
 * At halflife days old, the boost is halved.
 * strength=1: halflife=30 days, coefficient=1.0 (moderate — temporal queries)
 * strength=2: halflife=7 days, coefficient=1.5 (aggressive — "what's new" queries)
 *
 * Brand-new page at strength=1: factor = 1 + 1.0 / (1 + 0/30) = 2.0x
 * 30-day-old page at strength=1: factor = 1 + 1.0 / (1 + 1) = 1.5x
 * 365-day-old page at strength=1: factor = 1 + 1.0 / (1 + 12.17) = ~1.076x
 *
 * Brand-new page at strength=2: factor = 1 + 1.5 / (1 + 0/7) = 2.5x
 * 7-day-old page at strength=2: factor = 1 + 1.5 / (1 + 1) = 1.75x
 * 365-day-old page at strength=2: factor = 1 + 1.5 / (1 + 52.14) = ~1.028x
 *
 * Same contract as applyBacklinkBoost: mutates results in place, caller re-sorts.
 */

import type { SearchResult } from '../types.ts';

const DEBUG = process.env.GBRAIN_SEARCH_DEBUG === '1';

interface RecencyConfig {
  halflifeDays: number;
  coefficient: number;
}

const STRENGTH_CONFIG: Record<1 | 2, RecencyConfig> = {
  1: { halflifeDays: 30, coefficient: 1.0 },
  2: { halflifeDays: 7, coefficient: 1.5 },
};

/**
 * Apply recency boost to a result list in place. Mutates each result's score
 * by (1 + coefficient / (1 + days_old / halflife)). Pure data transform; no DB call.
 * Caller fetches timestamps via engine.getPageTimestamps.
 */
export function applyRecencyBoost(
  results: SearchResult[],
  pageTimestamps: Map<string, Date>,
  strength: 1 | 2,
): void {
  const config = STRENGTH_CONFIG[strength];
  const now = Date.now();

  for (const r of results) {
    const ts = pageTimestamps.get(r.slug);
    if (!ts) continue; // no timestamp → no boost (factor = 1.0)

    const msOld = now - ts.getTime();
    const daysOld = Math.max(0, msOld / (1000 * 60 * 60 * 24));
    const factor = 1.0 + config.coefficient / (1.0 + daysOld / config.halflifeDays);

    if (DEBUG) {
      console.error(
        `[search-debug] recency: ${r.slug} days_old=${daysOld.toFixed(1)} factor=${factor.toFixed(4)} strength=${strength} score=${r.score.toFixed(4)}→${(r.score * factor).toFixed(4)}`,
      );
    }

    r.score *= factor;
  }
}
