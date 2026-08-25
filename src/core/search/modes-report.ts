/**
 * Read-only search-mode dashboard builder — moved from src/commands/search.ts
 * in the CLI→MCP gap-closure wave so the `search_modes` op and the CLI render
 * the same report. Pure reads: never mutates config (the `modes --reset` lane
 * stays in the command file).
 */

import type { BrainEngine } from '../engine.ts';
import {
  MODE_BUNDLES,
  SEARCH_MODE_CONFIG_KEYS,
  loadSearchModeConfig,
  resolveSearchMode,
  attributeKnob,
  type SearchMode,
  type ModeBundle,
} from './mode.ts';

export const KNOB_DESCRIPTIONS: Record<keyof ModeBundle, string> = {
  cache_enabled: 'Semantic query cache on/off',
  cache_similarity_threshold: 'Cosine-similarity floor for cache hits (0..1)',
  cache_ttl_seconds: 'Per-row cache TTL',
  intentWeighting: 'Zero-LLM intent classifier weight adjustments',
  keywordOrFallback: 'Keyword-arm AND→OR zero-recall fallback',
  tokenBudget: 'Per-call token-budget cap (undefined = no cap)',
  expansion: 'LLM multi-query expansion (Haiku call per search)',
  searchLimit: 'Default `limit` for the operation layer',
  reranker_enabled: 'Cross-encoder reranker on/off',
  reranker_model: 'Provider:model for the reranker',
  reranker_top_n_in: 'Candidates sent to reranker per call',
  reranker_top_n_out: 'Cap on reranked output (null = no truncate)',
  reranker_timeout_ms: 'HTTP timeout for the reranker call',
  floor_ratio: 'Floor-ratio gate for metadata boosts (0..1, undefined = off)',
  title_boost: 'Title-phrase boost multiplier (query is a title token-run; 1.0 = off)',
  // v0.46.15 retrieval wave knobs
  evidence_cosine_floor: 'Cosine floor for evidence high_vector_match (label-only; 0..1)',
  autocut_min_top: 'Weak-top floor — autocut no-ops when the top score is below this (0 disables)',
  // v0.36 cross-modal knobs (D3 registry)
  cross_modal_both_text_weight: "D6 'both'-mode RRF weight for text branch (0.6 default)",
  cross_modal_both_image_weight: "D6 'both'-mode RRF weight for image branch (0.4 default)",
  image_query_text_refinement_weight: 'D13 searchByImage text-refinement RRF weight (0.4 default)',
  image_query_image_refinement_weight: 'D13 searchByImage image branch RRF weight (0.6 default)',
  unified_multimodal: 'Phase 3 — route all queries through embedding_multimodal column',
  unified_multimodal_only: 'Phase 3 strict — bypass dual-column fallback when unified is on',
  cross_modal_llm_intent: 'Commit 4 — Haiku tie-break for ambiguous modality classification',
  // v0.40.4 graph signals
  graph_signals: 'Selective graph signals: adjacency hub + cross-source hub + session diversification',
  // v0.40.3.0 contextual retrieval
  contextual_retrieval: 'CR tier (none|title|per_chunk_synopsis) — wraps chunks at embed time',
  contextual_retrieval_disabled: 'Soft kill switch — neutralizes CR wrapping for queries + new embeds',
  // v0.42.3.0 autocut
  autocut: 'Score-discontinuity result-sizing (cuts at the rerank-score cliff; no-op without a reranker)',
  autocut_jump: 'Autocut sensitivity: min normalized score gap that counts as a cliff (0..1, 0.20 default)',
  autocut_min_keep: 'Autocut floor: never trim the returned set below this many results (integer >= 1, 1 default)',
  // v0.43 relational recall
  relationalRetrieval: 'Typed-edge relational recall arm (relational queries walk the graph; no-op otherwise)',
  relational_retrieval_depth: 'Max hops for relational traversal (1..3, 2 default)',
};

export interface SearchModesReport {
  schema_version: 2;
  active_mode: SearchMode;
  active_mode_valid: boolean;
  resolved: Record<keyof ModeBundle, { value: unknown; source: string; source_detail: string; description: string }>;
  bundles: Record<SearchMode, ModeBundle>;
  config_keys: ReadonlyArray<string>;
  _meta?: {
    metric_glossary?: Record<string, string>;
  };
}

export async function buildModesReport(engine: BrainEngine): Promise<SearchModesReport> {
  const input = await loadSearchModeConfig(engine);
  const resolved = resolveSearchMode(input);

  const knobs: Array<keyof ModeBundle> = [
    'cache_enabled',
    'cache_similarity_threshold',
    'cache_ttl_seconds',
    'intentWeighting',
    'keywordOrFallback',
    'tokenBudget',
    'expansion',
    'searchLimit',
    // v0.35.6.0 — floor-ratio surfaced in `gbrain search modes` dashboard
    // so config drift is legible. Default undefined renders as 'undefined'
    // in the bundle column, 'mode' source when unset by config/per-call.
    'floor_ratio',
    // v0.46.15 retrieval wave — evidence floor (label-only) + autocut weak-top
    // floor surfaced so config drift on the new knobs is legible.
    'evidence_cosine_floor',
    'autocut_min_top',
    // #3621 — the documented autocut floor, surfaced alongside the weak-top floor.
    'autocut_min_keep',
  ];

  const attributions = {} as SearchModesReport['resolved'];
  for (const k of knobs) {
    const a = attributeKnob(k, input, resolved);
    attributions[k] = {
      value: a.value,
      source: a.source,
      source_detail: a.source_detail,
      description: KNOB_DESCRIPTIONS[k],
    };
  }

  return {
    schema_version: 2,
    active_mode: resolved.resolved_mode,
    active_mode_valid: resolved.mode_valid,
    resolved: attributions,
    bundles: {
      conservative: { ...MODE_BUNDLES.conservative },
      balanced: { ...MODE_BUNDLES.balanced },
      tokenmax: { ...MODE_BUNDLES.tokenmax },
    },
    config_keys: SEARCH_MODE_CONFIG_KEYS,
  };
}
