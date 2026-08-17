/**
 * Search-tune recommendation builder — moved from src/commands/search.ts in
 * the CLI→MCP gap-closure wave so the `search_tune` op and the CLI derive the
 * same recommendations. STRICTLY READ-ONLY: applying a recommendation
 * (`gbrain search tune` with the apply flag) is CLI-only by design [CDX-21]
 * and stays in the command file.
 */

import type { BrainEngine } from '../engine.ts';
import { loadSearchModeConfig, resolveSearchMode, type SearchMode } from './mode.ts';
import { readSearchStats, telemetryCoverage, type TelemetryCoverage } from './telemetry.ts';

export interface TuneRecommendation {
  knob: string;
  current: unknown;
  suggested: unknown;
  reason: string;
  apply_command: string;
}

export interface TuneReport {
  schema_version: 2;
  status: 'insufficient_data' | 'no_recommendations' | 'has_recommendations';
  total_calls: number;
  cache_hit_rate: number;
  active_mode: SearchMode;
  coverage: TelemetryCoverage;
  recommendations: TuneRecommendation[];
}

/** Below this many recorded searches the report is 'insufficient_data'. */
export const TUNE_MIN_CALLS = 20;

export async function buildTuneRecommendations(engine: BrainEngine): Promise<TuneReport> {
  const modeInput = await loadSearchModeConfig(engine);
  const resolved = resolveSearchMode(modeInput);
  const stats = await readSearchStats(engine, { days: 7 });

  const base = {
    schema_version: 2 as const,
    total_calls: stats.total_calls,
    cache_hit_rate: stats.cache_hit_rate,
    active_mode: resolved.resolved_mode,
    coverage: telemetryCoverage(),
  };

  // Recommendation 1: low call volume → no data yet.
  if (stats.total_calls < TUNE_MIN_CALLS) {
    return { ...base, status: 'insufficient_data', recommendations: [] };
  }

  const recs: TuneRecommendation[] = [];

  // Recommendation 2: budget pressure under conservative.
  if (resolved.resolved_mode === 'conservative' && stats.total_calls > 0) {
    const dropPctPerCall = stats.total_budget_dropped / stats.total_calls;
    if (dropPctPerCall > 2) {
      recs.push({
        knob: 'search.mode',
        current: 'conservative',
        suggested: 'balanced',
        reason: `Avg ${dropPctPerCall.toFixed(1)} results dropped per search by the 4K budget. Consider balanced (12K budget) or raise search.tokenBudget.`,
        apply_command: 'gbrain config set search.mode balanced',
      });
    }
  }

  // Recommendation 3: high cache hit rate → bump similarity threshold.
  if (stats.cache_hit_rate > 0.85 && stats.cache_hits + stats.cache_misses > 50) {
    recs.push({
      knob: 'search.cache.similarity_threshold',
      current: resolved.cache_similarity_threshold,
      suggested: 0.94,
      reason: `Cache hit rate is ${(stats.cache_hit_rate * 100).toFixed(1)}%. You can raise similarity threshold to 0.94 for tighter freshness at small recall cost.`,
      apply_command: 'gbrain config set search.cache.similarity_threshold 0.94',
    });
  }

  // Recommendation 4: tokenmax + Haiku subagent.
  const subagentModel = await engine.getConfig('models.tier.subagent');
  if (resolved.resolved_mode === 'tokenmax' && subagentModel && /haiku/i.test(subagentModel)) {
    recs.push({
      knob: 'search.mode',
      current: 'tokenmax',
      suggested: 'balanced',
      reason: `Subagent tier is Haiku but mode is tokenmax. LLM expansion adds ~50ms + ~1¢ per query. Balanced cuts that cost without losing intent weighting or cache.`,
      apply_command: 'gbrain config set search.mode balanced',
    });
  }

  // Recommendation 5: cache disabled but available — fix the free win.
  if (!resolved.cache_enabled && stats.total_calls > 5) {
    recs.push({
      knob: 'search.cache.enabled',
      current: false,
      suggested: true,
      reason: 'Cache is disabled but mode bundles enable it by default. Cache is a free win (zero LLM cost, big latency drop on repeat queries).',
      apply_command: 'gbrain config unset search.cache.enabled',
    });
  }

  return {
    ...base,
    status: recs.length === 0 ? 'no_recommendations' : 'has_recommendations',
    recommendations: recs,
  };
}
