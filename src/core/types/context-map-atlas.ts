import type { PersonalEpisodeLookupRoute, PersonalEpisodeSourceKind, PersonalProfileLookupRoute, ProfileMemoryType } from './profile-episode.ts';
import type { ScopeGateDecisionResult, ScopeGateScope } from './retrieval-routing.ts';

export interface ContextMapEntry {
  id: string;
  scope_id: string;
  kind: string;
  title: string;
  build_mode: string;
  status: string;
  source_set_hash: string;
  extractor_version: string;
  node_count: number;
  edge_count: number;
  community_count: number;
  graph_json: Record<string, unknown>;
  generated_at: Date;
  stale_reason: string | null;
}

export interface ContextMapEntryInput {
  id: string;
  scope_id: string;
  kind: string;
  title: string;
  build_mode: string;
  status: string;
  source_set_hash: string;
  extractor_version: string;
  node_count: number;
  edge_count: number;
  community_count?: number;
  graph_json: Record<string, unknown>;
  generated_at?: Date | string;
  stale_reason?: string | null;
}

export interface ContextMapFilters {
  scope_id?: string;
  kind?: string;
  limit?: number;
}

export interface ContextAtlasEntry {
  id: string;
  map_id: string;
  scope_id: string;
  kind: string;
  title: string;
  freshness: string;
  entrypoints: string[];
  budget_hint: number;
  generated_at: Date;
}

export interface ContextAtlasEntryInput {
  id: string;
  map_id: string;
  scope_id: string;
  kind: string;
  title: string;
  freshness: string;
  entrypoints: string[];
  budget_hint: number;
}

export interface ContextAtlasFilters {
  scope_id?: string;
  kind?: string;
  limit?: number;
}

export interface ContextAtlasSelectionInput {
  scope_id?: string;
  kind?: string;
  max_budget_hint?: number;
  allow_stale?: boolean;
}

export interface ContextAtlasSelection {
  entry: ContextAtlasEntry | null;
  reason: string;
  candidate_count: number;
}

export interface ContextAtlasOverviewInput extends ContextAtlasSelectionInput {
  atlas_id?: string;
}

export interface ContextAtlasOverviewRead {
  node_id: string;
  node_kind: 'page' | 'section';
  label: string;
  page_slug: string;
  path: string;
  section_id?: string;
}

export interface ContextAtlasOverviewArtifact {
  overview_kind: 'structural';
  entry: ContextAtlasEntry;
  recommended_reads: ContextAtlasOverviewRead[];
}

export interface ContextAtlasOverviewResult {
  selection_reason: string;
  candidate_count: number;
  overview: ContextAtlasOverviewArtifact | null;
}

export interface ContextAtlasReport {
  report_kind: 'structural';
  title: string;
  entry_id: string;
  freshness: string;
  summary_lines: string[];
  recommended_reads: ContextAtlasOverviewRead[];
}

export interface ContextAtlasReportResult {
  selection_reason: string;
  candidate_count: number;
  report: ContextAtlasReport | null;
}

export interface ContextMapReportRead {
  node_id: string;
  node_kind: 'page' | 'section';
  label: string;
  page_slug: string;
  path: string;
  section_id?: string;
}

export interface ContextMapReport {
  report_kind: 'structural';
  title: string;
  map_id: string;
  scope_id: string;
  status: string;
  summary_lines: string[];
  recommended_reads: ContextMapReportRead[];
}

export interface ContextMapReportInput {
  map_id?: string;
  scope_id?: string;
  kind?: string;
}

export interface ContextMapReportResult {
  selection_reason: string;
  candidate_count: number;
  report: ContextMapReport | null;
}

export interface ContextMapExplanationNeighborEdge {
  edge_kind: string;
  from_node_id: string;
  to_node_id: string;
  source_page_slug: string;
  source_section_id?: string;
}

export interface ContextMapExplanationRead {
  node_id: string;
  node_kind: 'page' | 'section';
  label: string;
  page_slug: string;
  path: string;
  section_id?: string;
}

export interface ContextMapExplanation {
  explanation_kind: 'structural';
  title: string;
  map_id: string;
  node_id: string;
  node_kind: 'page' | 'section';
  label: string;
  status: string;
  summary_lines: string[];
  neighbor_edges: ContextMapExplanationNeighborEdge[];
  recommended_reads: ContextMapExplanationRead[];
}

export interface ContextMapExplanationInput {
  map_id?: string;
  scope_id?: string;
  kind?: string;
  node_id: string;
}

export interface ContextMapExplanationResult {
  selection_reason: string;
  candidate_count: number;
  explanation: ContextMapExplanation | null;
}

export interface ContextMapQueryMatch {
  node_id: string;
  node_kind: 'page' | 'section';
  label: string;
  page_slug: string;
  score: number;
}

export interface ContextMapQueryRead {
  node_id: string;
  node_kind: 'page' | 'section';
  label: string;
  page_slug: string;
  path: string;
  section_id?: string;
}

export interface ContextMapQueryResultPayload {
  query_kind: 'structural';
  map_id: string;
  query: string;
  status: string;
  summary_lines: string[];
  matched_nodes: ContextMapQueryMatch[];
  recommended_reads: ContextMapQueryRead[];
}

export interface ContextMapQueryInput {
  map_id?: string;
  scope_id?: string;
  kind?: string;
  query: string;
  limit?: number;
}

export interface ContextMapQueryResult {
  selection_reason: string;
  candidate_count: number;
  result: ContextMapQueryResultPayload | null;
}

export interface ContextMapPathEdge {
  edge_kind: string;
  from_node_id: string;
  to_node_id: string;
  source_page_slug: string;
  source_section_id?: string;
}

export interface ContextMapPathRead {
  node_id: string;
  node_kind: 'page' | 'section';
  label: string;
  page_slug: string;
  path: string;
  section_id?: string;
}

export interface ContextMapPathResultPayload {
  path_kind: 'structural';
  map_id: string;
  from_node_id: string;
  to_node_id: string;
  status: string;
  hop_count: number;
  node_ids: string[];
  edges: ContextMapPathEdge[];
  summary_lines: string[];
  recommended_reads: ContextMapPathRead[];
}

export interface ContextMapPathInput {
  map_id?: string;
  scope_id?: string;
  kind?: string;
  from_node_id: string;
  to_node_id: string;
  max_depth?: number;
}

export interface ContextMapPathResult {
  selection_reason: string;
  candidate_count: number;
  path: ContextMapPathResultPayload | null;
}

export interface BroadSynthesisRouteRead {
  node_id: string;
  node_kind: 'page' | 'section';
  label: string;
  page_slug: string;
  path: string;
  section_id?: string;
}

export interface BroadSynthesisEntrypoint {
  source_kind: 'curated_note' | 'context_map';
  page_slug?: string;
  map_id?: string;
  label: string;
}

export interface BroadSynthesisDerivedSuggestion {
  map_id: string;
  node_id: string;
  label: string;
  page_slug: string;
}

export interface BroadSynthesisConflict {
  entity_key: string;
  canonical_page_slug: string;
  derived_map_id: string;
  resolution: 'prefer_canonical';
  summary: string;
}

export interface BroadSynthesisRoute {
  route_kind: 'broad_synthesis';
  map_id: string;
  query: string;
  status: string;
  retrieval_route: string[];
  focal_node_id: string | null;
  summary_lines: string[];
  matched_nodes: ContextMapQueryMatch[];
  entrypoints: BroadSynthesisEntrypoint[];
  canonical_reads: BroadSynthesisRouteRead[];
  derived_suggestions: BroadSynthesisDerivedSuggestion[];
  conflicts: BroadSynthesisConflict[];
  recommended_reads: BroadSynthesisRouteRead[];
}

export interface BroadSynthesisRouteInput {
  map_id?: string;
  scope_id?: string;
  kind?: string;
  query: string;
  limit?: number;
}

export interface BroadSynthesisRouteResult {
  selection_reason: string;
  candidate_count: number;
  route: BroadSynthesisRoute | null;
}

export interface MixedScopeBridgeRoute {
  route_kind: 'mixed_scope_bridge';
  bridge_reason: 'explicit_mixed_scope';
  personal_route_kind: 'profile' | 'episode';
  work_route: BroadSynthesisRoute;
  personal_route: PersonalProfileLookupRoute | PersonalEpisodeLookupRoute;
  retrieval_route: string[];
  summary_lines: string[];
}

export interface MixedScopeBridgeInput {
  requested_scope?: Exclude<ScopeGateScope, 'unknown'>;
  personal_route_kind: 'profile' | 'episode';
  map_id?: string;
  scope_id?: string;
  kind?: string;
  query: string;
  limit?: number;
  subject?: string;
  profile_type?: ProfileMemoryType;
  episode_title?: string;
  episode_source_kind?: PersonalEpisodeSourceKind;
}

export interface MixedScopeBridgeResult {
  selection_reason: string;
  candidate_count: number;
  route: MixedScopeBridgeRoute | null;
  scope_gate: ScopeGateDecisionResult;
}

export type MixedScopeDisclosureVisibility =
  | 'profile_content_disclosed'
  | 'profile_metadata_only'
  | 'profile_withheld'
  | 'episode_metadata_only';

export interface MixedScopeDisclosure {
  disclosure_kind: 'mixed_scope_bridge';
  personal_route_kind: 'profile' | 'episode';
  personal_visibility: MixedScopeDisclosureVisibility;
  work_summary_lines: string[];
  personal_summary_lines: string[];
  recommended_reads: BroadSynthesisRouteRead[];
}

export type MixedScopeDisclosureInput = MixedScopeBridgeInput;

export interface MixedScopeDisclosureResult {
  selection_reason: string;
  candidate_count: number;
  scope_gate: ScopeGateDecisionResult;
  disclosure: MixedScopeDisclosure | null;
}

export interface PrecisionLookupRouteRead {
  node_id: string;
  node_kind: 'page' | 'section';
  label: string;
  page_slug: string;
  path: string;
  section_id?: string;
}

export interface PrecisionLookupRoute {
  route_kind: 'precision_lookup';
  target_kind: 'page' | 'section';
  slug: string;
  path: string;
  title: string;
  scope_id: string;
  section_id?: string;
  retrieval_route: string[];
  summary_lines: string[];
  recommended_reads: PrecisionLookupRouteRead[];
}

export interface PrecisionLookupRouteInput {
  scope_id?: string;
  slug?: string;
  path?: string;
  section_id?: string;
  source_ref?: string;
}

export interface PrecisionLookupRouteResult {
  selection_reason: string;
  candidate_count: number;
  route: PrecisionLookupRoute | null;
}
