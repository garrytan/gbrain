import type { RetrievalSelector } from './retrieval-routing.ts';

export type GraphFrontierEdgeType =
  | 'supports'
  | 'contradicts'
  | 'supersedes'
  | 'requires_reverification';

export type GraphFrontierSelectorActivation =
  | 'canonical_read'
  | 'verify_first'
  | 'review_only';

export type GraphFrontierOmissionReason =
  | 'scope_mismatch'
  | 'policy_mismatch'
  | 'unsupported_edge_type'
  | 'fanout_cap'
  | 'depth_cap'
  | 'stale_graph'
  | 'missing_node'
  | 'missing_canonical_selector'
  | 'non_canonical_selector'
  | 'historical_selector'
  | 'expansion_blocked';

export interface GraphFrontierNode {
  id: string;
  scope_id: string;
  policy_version: string;
  selector?: RetrievalSelector;
  stale?: boolean;
}

export interface GraphFrontierEdge {
  id: string;
  edge_type: GraphFrontierEdgeType | string;
  from_node_id: string;
  to_node_id: string;
  scope_id: string;
  policy_version: string;
  stale?: boolean;
}

export interface GraphFrontierInput {
  enabled: boolean;
  scope_id?: string;
  policy_version: string;
  seed_node_ids: string[];
  nodes: GraphFrontierNode[];
  edges: GraphFrontierEdge[];
  max_depth?: number;
  fanout_cap?: number;
  allowed_edge_types?: GraphFrontierEdgeType[];
}

export interface GraphFrontierSelectedSelector {
  node_id: string;
  selector: RetrievalSelector;
  activation: GraphFrontierSelectorActivation;
  reason_codes: string[];
}

export interface GraphFrontierPathTrace {
  path_id: string;
  start_node_id: string;
  end_node_id: string;
  node_ids: string[];
  edge_ids: string[];
  edge_types: GraphFrontierEdgeType[];
  activation: GraphFrontierSelectorActivation;
  authority: 'selector_planning_only';
}

export interface GraphFrontierOmittedPath {
  node_id?: string;
  edge_id?: string;
  from_node_id?: string;
  to_node_id?: string;
  reason: GraphFrontierOmissionReason;
  edge_type?: string;
}

export interface GraphFrontierResult {
  selected_selectors: GraphFrontierSelectedSelector[];
  paths_considered: GraphFrontierPathTrace[];
  omitted_paths: GraphFrontierOmittedPath[];
  authority_violations: string[];
  warnings: string[];
}
