import type { MBrainConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import { governedProbeHybridEnabled, hybridProbeSearch } from '../search/governed-probe.ts';
import type { BroadSynthesisRouteDependencies } from './broad-synthesis-route-service.ts';
import type { RetrievalRouteSelectorDependencies } from './retrieval-route-selector-service.ts';
import {
  buildProductionGraphFrontierInput,
  type RetrieveContextDependencies,
} from './retrieve-context-service.ts';

export function createProductionRetrieveContextDependencies(
  engine: BrainEngine,
  config?: MBrainConfig | null,
): RetrieveContextDependencies {
  const dependencies: RetrieveContextDependencies = {
    graphFrontierInputBuilder: buildProductionGraphFrontierInput,
    sourceRankRules: config?.retrieval_source_rank_rules,
  };
  if (config?.retrieval_usage_aware_ranking === true) {
    dependencies.usageAwareRanking = true;
  }
  if (!governedProbeHybridEnabled(config)) return dependencies;
  const broadSynthesis = createProductionBroadSynthesisRouteDependencies(engine, config);
  return {
    ...dependencies,
    candidateSearch: (query, options) =>
      hybridProbeSearch(engine, config, query, {
        limit: options.limit,
        updated_after: options.updated_after,
        updated_before: options.updated_before,
      }),
    broadSynthesisCandidateSearch: broadSynthesis.candidateSearch,
  };
}

export function createProductionBroadSynthesisRouteDependencies(
  engine: BrainEngine,
  config?: MBrainConfig | null,
): BroadSynthesisRouteDependencies {
  if (!governedProbeHybridEnabled(config)) return {};
  return {
    candidateSearch: (query, options) =>
      hybridProbeSearch(engine, config, query, {
        type: options.type,
        limit: options.limit,
      }),
  };
}

export function createProductionRetrievalRouteDependencies(
  engine: BrainEngine,
  config?: MBrainConfig | null,
): RetrievalRouteSelectorDependencies {
  const broadSynthesis = createProductionBroadSynthesisRouteDependencies(engine, config);
  return Object.keys(broadSynthesis).length > 0 ? { broadSynthesis } : {};
}
