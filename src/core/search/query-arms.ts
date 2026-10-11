/**
 * The `query` op's post-retrieval arms, applied after hybrid search and the
 * declared-name fan-out, before the CRAG grade: entity anchoring
 * (`search.entity_anchoring`, default off, search/entity-anchor.ts) and then
 * the facts arm (`search.query_facts_arm`, default on, search/facts-arm.ts),
 * or in its place, for a query with a temporal cue and a token budget, the
 * temporal fact reserve (`search.temporal_fact_reserve`, default off). With
 * all off the rows pass through unchanged.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageReadScope, SearchResult } from '../types.ts';
import { anchorOpResults } from './entity-anchor.ts';
import { applyFactsArm, applyTemporalFactReserve, hasTemporalCue, queryFactsArmEnabled, temporalFactReserveEnabled } from './facts-arm.ts';

export async function applyQueryArms(engine: BrainEngine, p: Record<string, unknown>, query: string, results: SearchResult[],
  scope: PageReadScope & { filtered: boolean; evidencePlan: boolean; evidenceBudget?: number; remote: boolean; queryEmbedding: Float32Array | null; rowCap: () => Promise<number> }): Promise<SearchResult[]> {
  const anchored = await anchorOpResults(engine, p, query, results, scope);
  if (p.offset || scope.filtered || p.since || p.until || p.lang || p.symbol_kind || p.near_symbol) return anchored;
  const tokenBudget = !scope.evidencePlan && typeof p.token_budget === 'number' ? p.token_budget : undefined;
  const opts = { sourceId: scope.sourceId, sourceIds: scope.sourceIds, remote: scope.remote, minTrust: scope.minTrust, suppressFlagged: scope.suppressFlagged, queryEmbedding: scope.queryEmbedding, rowCap: scope.rowCap, readScope: scope, tokenBudget };
  const budget = scope.evidencePlan ? scope.evidenceBudget : tokenBudget;
  if (budget && hasTemporalCue(query) && await temporalFactReserveEnabled(engine)) return applyTemporalFactReserve(engine, query, anchored, { ...opts, budget });
  if (!await queryFactsArmEnabled(engine)) return anchored;
  return applyFactsArm(engine, query, anchored, opts);
}
