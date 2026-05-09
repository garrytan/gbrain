// Page types
export type PageType =
  | 'person'
  | 'company'
  | 'deal'
  | 'yc'
  | 'civic'
  | 'project'
  | 'concept'
  | 'source'
  | 'media'
  | 'system';

export type ChunkSource = 'compiled_truth' | 'timeline' | 'frontmatter';

export interface CodemapPointer {
  path: string;
  symbol?: string;
  role: string;
  verified_at?: string;
  stale?: boolean;
}

export interface CodemapEntry {
  system: string;
  pointers: CodemapPointer[];
  vocabulary?: string;
}

export interface SystemEntryPoint {
  name: string;
  path: string;
  purpose: string;
}

export interface SystemFrontmatter {
  repo?: string;
  language?: string[];
  build_command?: string;
  test_command?: string;
  key_entry_points?: SystemEntryPoint[];
}

export interface Page {
  id: number;
  slug: string;
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash?: string;
  created_at: Date;
  updated_at: Date;
}

export interface PageInput {
  type: PageType;
  title: string;
  compiled_truth: string;
  timeline?: string;
  frontmatter?: Record<string, unknown>;
  content_hash?: string;
}

export interface PageFilters {
  type?: PageType;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface NoteManifestHeading {
  slug: string;
  text: string;
  depth: number;
  line_start: number;
}

export interface NoteManifestEntry {
  scope_id: string;
  page_id: number;
  slug: string;
  path: string;
  page_type: PageType;
  title: string;
  frontmatter: Record<string, unknown>;
  aliases: string[];
  tags: string[];
  outgoing_wikilinks: string[];
  outgoing_urls: string[];
  source_refs: string[];
  heading_index: NoteManifestHeading[];
  content_hash: string;
  extractor_version: string;
  last_indexed_at: Date;
}

export interface NoteManifestEntryInput {
  scope_id: string;
  page_id: number;
  slug: string;
  path: string;
  page_type: PageType;
  title: string;
  frontmatter: Record<string, unknown>;
  aliases: string[];
  tags: string[];
  outgoing_wikilinks: string[];
  outgoing_urls: string[];
  source_refs: string[];
  heading_index: NoteManifestHeading[];
  content_hash: string;
  extractor_version: string;
}

export interface NoteManifestFilters {
  scope_id?: string;
  slug?: string;
  limit?: number;
  offset?: number;
}

export interface NoteSectionEntry {
  scope_id: string;
  page_id: number;
  page_slug: string;
  page_path: string;
  section_id: string;
  parent_section_id: string | null;
  heading_slug: string;
  heading_path: string[];
  heading_text: string;
  depth: number;
  line_start: number;
  line_end: number;
  section_text: string;
  outgoing_wikilinks: string[];
  outgoing_urls: string[];
  source_refs: string[];
  content_hash: string;
  extractor_version: string;
  last_indexed_at: Date;
}

export interface NoteSectionEntryInput {
  scope_id: string;
  page_id: number;
  page_slug: string;
  page_path: string;
  section_id: string;
  parent_section_id: string | null;
  heading_slug: string;
  heading_path: string[];
  heading_text: string;
  depth: number;
  line_start: number;
  line_end: number;
  section_text: string;
  outgoing_wikilinks: string[];
  outgoing_urls: string[];
  source_refs: string[];
  content_hash: string;
  extractor_version: string;
}

export interface NoteSectionFilters {
  scope_id?: string;
  page_slug?: string;
  section_id?: string;
  limit?: number;
  offset?: number;
}

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

export type ProfileMemoryType =
  | 'preference'
  | 'routine'
  | 'personal_project'
  | 'stable_fact'
  | 'relationship_boundary'
  | 'other';

export type ProfileMemorySensitivity = 'public' | 'personal' | 'secret';
export type ProfileMemoryExportStatus = 'private_only' | 'exportable';

export interface ProfileMemoryEntry {
  id: string;
  scope_id: string;
  profile_type: ProfileMemoryType;
  subject: string;
  content: string;
  source_refs: string[];
  sensitivity: ProfileMemorySensitivity;
  export_status: ProfileMemoryExportStatus;
  last_confirmed_at: Date | null;
  superseded_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProfileMemoryEntryInput {
  id: string;
  scope_id: string;
  profile_type: ProfileMemoryType;
  subject: string;
  content: string;
  source_refs: string[];
  sensitivity: ProfileMemorySensitivity;
  export_status: ProfileMemoryExportStatus;
  last_confirmed_at?: Date | string | null;
  superseded_by?: string | null;
}

export interface ProfileMemoryFilters {
  scope_id?: string;
  subject?: string;
  profile_type?: ProfileMemoryType;
  limit?: number;
  offset?: number;
}

export interface PersonalProfileLookupRoute {
  route_kind: 'personal_profile_lookup';
  profile_memory_id: string;
  scope_id: string;
  profile_type: ProfileMemoryType;
  subject: string;
  content: string;
  sensitivity: ProfileMemorySensitivity;
  export_status: ProfileMemoryExportStatus;
  retrieval_route: string[];
  summary_lines: string[];
  source_refs: string[];
}

export interface PersonalProfileLookupRouteInput {
  scope_id?: string;
  subject: string;
  profile_type?: ProfileMemoryType;
  requested_scope?: Exclude<ScopeGateScope, 'unknown'>;
  query?: string;
}

export interface PersonalProfileLookupRouteResult {
  selection_reason: string;
  candidate_count: number;
  route: PersonalProfileLookupRoute | null;
}

export type PersonalEpisodeSourceKind = 'chat' | 'note' | 'import' | 'meeting' | 'reminder' | 'other';

export interface PersonalEpisodeEntry {
  id: string;
  scope_id: string;
  title: string;
  start_time: Date;
  end_time: Date | null;
  source_kind: PersonalEpisodeSourceKind;
  summary: string;
  source_refs: string[];
  candidate_ids: string[];
  created_at: Date;
  updated_at: Date;
}

export interface PersonalEpisodeEntryInput {
  id: string;
  scope_id: string;
  title: string;
  start_time: Date | string;
  end_time?: Date | string | null;
  source_kind: PersonalEpisodeSourceKind;
  summary: string;
  source_refs: string[];
  candidate_ids: string[];
}

export interface PersonalEpisodeFilters {
  scope_id?: string;
  title?: string;
  source_kind?: PersonalEpisodeSourceKind;
  limit?: number;
  offset?: number;
}

export type MemoryMutationResult =
  | 'dry_run'
  | 'staged_for_review'
  | 'applied'
  | 'conflict'
  | 'denied'
  | 'failed'
  | 'redacted';

export type MemoryMutationRedactionVisibility =
  | 'visible'
  | 'partially_redacted'
  | 'tombstoned';

export type MemoryMutationTargetKind =
  | 'page'
  | 'source_record'
  | 'task_thread'
  | 'working_set'
  | 'task_event'
  | 'task_episode'
  | 'attempt'
  | 'decision'
  | 'procedure'
  | 'memory_candidate'
  | 'memory_patch_candidate'
  | 'profile_memory'
  | 'personal_episode'
  | 'memory_realm'
  | 'memory_session'
  | 'memory_session_attachment'
  | 'context_map'
  | 'context_atlas'
  | 'file_artifact'
  | 'export_artifact'
  | 'ledger_event';

export type MemoryMutationOperationName =
  | 'create_memory_session'
  | 'close_memory_session'
  | 'expire_memory_session'
  | 'revoke_memory_session'
  | 'dry_run_memory_mutation'
  | 'list_memory_mutation_events'
  | 'record_memory_mutation_event'
  | 'create_memory_patch_candidate'
  | 'dry_run_memory_patch_candidate'
  | 'review_memory_patch_candidate'
  | 'apply_memory_patch_candidate'
  | 'create_redaction_plan'
  | 'dry_run_redaction_plan'
  | 'execute_redaction_plan'
  | 'put_page'
  | 'delete_page'
  | 'upsert_profile_memory_entry'
  | 'write_profile_memory_entry'
  | 'delete_profile_memory_entry'
  | 'record_personal_episode'
  | 'write_personal_episode_entry'
  | 'delete_personal_episode_entry'
  | 'upsert_memory_realm'
  | 'attach_memory_realm_to_session'
  | 'create_memory_candidate_entry'
  | 'advance_memory_candidate_status'
  | 'reject_memory_candidate_entry'
  | 'delete_memory_candidate_entry'
  | 'promote_memory_candidate_entry'
  | 'supersede_memory_candidate_entry'
  | 'export_memory_artifact'
  | 'sync_memory_artifact'
  | 'repair_memory_ledger'
  | 'physical_delete_memory_record';

export interface MemoryMutationEvent {
  id: string;
  session_id: string;
  realm_id: string;
  actor: string;
  operation: MemoryMutationOperationName;
  target_kind: MemoryMutationTargetKind;
  target_id: string;
  scope_id: string | null;
  source_refs: string[];
  expected_target_snapshot_hash: string | null;
  current_target_snapshot_hash: string | null;
  result: MemoryMutationResult;
  conflict_info: Record<string, unknown> | null;
  dry_run: boolean;
  metadata: Record<string, unknown>;
  redaction_visibility: MemoryMutationRedactionVisibility;
  created_at: Date;
  decided_at: Date | null;
  applied_at: Date | null;
}

export interface MemoryMutationEventInput {
  id: string;
  session_id: string;
  realm_id: string;
  actor: string;
  operation: MemoryMutationOperationName;
  target_kind: MemoryMutationTargetKind;
  target_id: string;
  scope_id?: string | null;
  source_refs: string[];
  expected_target_snapshot_hash?: string | null;
  current_target_snapshot_hash?: string | null;
  result: MemoryMutationResult;
  conflict_info?: Record<string, unknown> | null;
  dry_run?: boolean;
  metadata?: Record<string, unknown>;
  redaction_visibility?: MemoryMutationRedactionVisibility;
  created_at?: Date | string | null;
  decided_at?: Date | string | null;
  applied_at?: Date | string | null;
}

export interface MemoryMutationEventFilters {
  session_id?: string;
  realm_id?: string;
  actor?: string;
  operation?: MemoryMutationOperationName;
  target_kind?: MemoryMutationTargetKind;
  target_id?: string;
  scope_id?: string;
  result?: MemoryMutationResult;
  created_since?: Date;
  created_until?: Date;
  limit?: number;
  offset?: number;
}

export type MemoryRealmScope = 'work' | 'personal' | 'mixed';

export type MemoryAccessMode = 'read_only' | 'read_write';

export interface MemoryRealm {
  id: string;
  name: string;
  description: string;
  scope: MemoryRealmScope;
  default_access: MemoryAccessMode;
  retention_policy: string;
  export_policy: string;
  agent_instructions: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryRealmInput {
  id: string;
  name: string;
  description?: string;
  scope: MemoryRealmScope;
  default_access?: MemoryAccessMode;
  retention_policy?: string;
  export_policy?: string;
  agent_instructions?: string;
  archived_at?: Date | string | null;
}

export interface MemoryRealmFilters {
  scope?: MemoryRealmScope;
  include_archived?: boolean;
  limit?: number;
  offset?: number;
}

export type MemorySessionStatus = 'active' | 'expired' | 'closed';

export interface MemorySession {
  id: string;
  task_id: string | null;
  status: MemorySessionStatus;
  actor_ref: string | null;
  created_at: Date;
  closed_at: Date | null;
  expires_at: Date | null;
}

export interface MemorySessionInput {
  id: string;
  task_id?: string | null;
  actor_ref?: string | null;
  expires_at?: Date | string | null;
}

export interface MemorySessionFilters {
  status?: MemorySessionStatus;
  task_id?: string;
  actor_ref?: string;
  realm_id?: string;
  created_since?: Date | string;
  created_until?: Date | string;
  limit?: number;
  offset?: number;
}

export interface MemorySessionAttachment {
  session_id: string;
  realm_id: string;
  access: MemoryAccessMode;
  instructions: string;
  attached_at: Date;
}

export interface MemorySessionAttachmentInput {
  session_id: string;
  realm_id: string;
  access: MemoryAccessMode;
  instructions?: string;
}

export interface MemorySessionAttachmentFilters {
  session_id?: string;
  realm_id?: string;
  limit?: number;
  offset?: number;
}

export type MemoryRedactionPlanStatus = 'draft' | 'approved' | 'applied' | 'rejected';

export type MemoryRedactionTargetObjectType =
  | 'page'
  | 'page_version'
  | 'profile_memory'
  | 'personal_episode'
  | 'memory_candidate'
  | 'retrieval_trace'
  | 'ingest_log';

export type MemoryRedactionPlanItemStatus = 'planned' | 'applied' | 'unsupported';

export interface MemoryRedactionPlan {
  id: string;
  scope_id: string;
  query: string;
  replacement_text: string;
  status: MemoryRedactionPlanStatus;
  requested_by: string | null;
  review_reason: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  applied_at: Date | null;
}

export interface MemoryRedactionPlanInput {
  id: string;
  scope_id: string;
  query: string;
  replacement_text?: string;
  status?: MemoryRedactionPlanStatus;
  requested_by?: string | null;
  review_reason?: string | null;
  created_at?: Date | string | null;
  reviewed_at?: Date | string | null;
  applied_at?: Date | string | null;
}

export interface MemoryRedactionPlanFilters {
  scope_id?: string;
  status?: MemoryRedactionPlanStatus;
  limit?: number;
  offset?: number;
}

export interface MemoryRedactionPlanStatusPatch {
  status: MemoryRedactionPlanStatus;
  expected_current_status?: MemoryRedactionPlanStatus;
  query?: string;
  replacement_text?: string;
  review_reason?: string | null;
  reviewed_at?: Date | string | null;
  applied_at?: Date | string | null;
}

export interface MemoryRedactionPlanItem {
  id: string;
  plan_id: string;
  target_object_type: MemoryRedactionTargetObjectType;
  target_object_id: string;
  field_path: string;
  before_hash: string | null;
  after_hash: string | null;
  status: MemoryRedactionPlanItemStatus;
  preview_text: string;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryRedactionPlanItemInput {
  id: string;
  plan_id: string;
  target_object_type: MemoryRedactionTargetObjectType;
  target_object_id: string;
  field_path: string;
  before_hash?: string | null;
  after_hash?: string | null;
  status?: MemoryRedactionPlanItemStatus;
  preview_text?: string;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
}

export interface MemoryRedactionPlanItemFilters {
  plan_id?: string;
  status?: MemoryRedactionPlanItemStatus;
  target_object_type?: MemoryRedactionTargetObjectType;
  target_object_id?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryRedactionPlanItemStatusPatch {
  status: MemoryRedactionPlanItemStatus;
  expected_current_status?: MemoryRedactionPlanItemStatus;
  before_hash?: string | null;
  after_hash?: string | null;
  updated_at?: Date | string | null;
}

export type MemoryCandidateType =
  | 'fact'
  | 'relationship'
  | 'note_update'
  | 'procedure'
  | 'profile_update'
  | 'open_question'
  | 'rationale';

export type MemoryCandidateGeneratedBy =
  | 'agent'
  | 'map_analysis'
  | 'dream_cycle'
  | 'manual'
  | 'import';

export type MemoryCandidateExtractionKind =
  | 'extracted'
  | 'inferred'
  | 'ambiguous'
  | 'manual';

export type MemoryCandidateSensitivity =
  | 'public'
  | 'work'
  | 'personal'
  | 'secret'
  | 'unknown';

export type MemoryCandidateStatus =
  | 'captured'
  | 'candidate'
  | 'staged_for_review'
  | 'rejected'
  | 'promoted'
  | 'superseded';

export type MemoryPatchFormat =
  | 'merge_patch'
  | 'json_patch'
  | 'unified_diff'
  | 'whole_record'
  | 'operation';

export type MemoryPatchBody = Record<string, unknown> | unknown[];

export type MemoryPatchOperationState =
  | 'proposed'
  | 'dry_run_validated'
  | 'approved_for_apply'
  | 'apply_in_progress'
  | 'applied'
  | 'conflicted'
  | 'failed';

export type MemoryPatchRiskClass =
  | 'low'
  | 'medium'
  | 'high'
  | 'critical'
  | 'unknown';

export type MemoryCandidateCreateStatus =
  | 'captured'
  | 'candidate'
  | 'staged_for_review';

export type MemoryCandidateStatusEventKind =
  | 'created'
  | 'advanced'
  | 'promoted'
  | 'rejected'
  | 'superseded';

export type MemoryCandidateTargetObjectType =
  | 'curated_note'
  | 'procedure'
  | 'profile_memory'
  | 'personal_episode'
  | 'other';

export type MemoryCandidatePromotionPreflightDecision = 'allow' | 'deny' | 'defer';

export type MemoryCandidatePromotionPreflightReason =
  | 'candidate_not_staged_for_review'
  | 'candidate_missing_provenance'
  | 'candidate_missing_target_object'
  | 'candidate_scope_conflict'
  | 'candidate_unknown_sensitivity'
  | 'candidate_requires_revalidation'
  | 'candidate_possible_duplicate'
  | 'candidate_ready_for_promotion';

export interface MemoryCandidateEntry {
  id: string;
  scope_id: string;
  candidate_type: MemoryCandidateType;
  proposed_content: string;
  source_refs: string[];
  generated_by: MemoryCandidateGeneratedBy;
  extraction_kind: MemoryCandidateExtractionKind;
  confidence_score: number;
  importance_score: number;
  recurrence_score: number;
  sensitivity: MemoryCandidateSensitivity;
  status: MemoryCandidateStatus;
  target_object_type: MemoryCandidateTargetObjectType | null;
  target_object_id: string | null;
  reviewed_at: Date | null;
  review_reason: string | null;
  patch_target_kind?: MemoryMutationTargetKind | null;
  patch_target_id?: string | null;
  patch_base_target_snapshot_hash?: string | null;
  patch_body?: MemoryPatchBody | null;
  patch_format?: MemoryPatchFormat | null;
  patch_operation_state?: MemoryPatchOperationState | null;
  patch_risk_class?: MemoryPatchRiskClass | null;
  patch_expected_resulting_target_snapshot_hash?: string | null;
  patch_provenance_summary?: string | null;
  patch_actor?: string | null;
  patch_originating_session_id?: string | null;
  patch_ledger_event_ids?: string[];
  created_at: Date;
  updated_at: Date;
}

export interface MemoryCandidateEntryInput {
  id: string;
  scope_id: string;
  candidate_type: MemoryCandidateType;
  proposed_content: string;
  source_refs: string[];
  generated_by: MemoryCandidateGeneratedBy;
  extraction_kind: MemoryCandidateExtractionKind;
  confidence_score: number;
  importance_score: number;
  recurrence_score: number;
  sensitivity: MemoryCandidateSensitivity;
  status: MemoryCandidateCreateStatus;
  target_object_type?: MemoryCandidateTargetObjectType | null;
  target_object_id?: string | null;
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
  patch_target_kind?: MemoryMutationTargetKind | null;
  patch_target_id?: string | null;
  patch_base_target_snapshot_hash?: string | null;
  patch_body?: MemoryPatchBody | null;
  patch_format?: MemoryPatchFormat | null;
  patch_operation_state?: MemoryPatchOperationState | null;
  patch_risk_class?: MemoryPatchRiskClass | null;
  patch_expected_resulting_target_snapshot_hash?: string | null;
  patch_provenance_summary?: string | null;
  patch_actor?: string | null;
  patch_originating_session_id?: string | null;
  patch_ledger_event_ids?: string[];
}

export interface MemoryCandidateScoredEntry {
  candidate: MemoryCandidateEntry;
  source_quality_score: number;
  effective_confidence_score: number;
  review_priority_score: number;
}

export interface MemoryCandidateFilters {
  scope_id?: string;
  status?: MemoryCandidateStatus;
  candidate_type?: MemoryCandidateType;
  target_object_type?: MemoryCandidateTargetObjectType;
  target_object_id?: string;
  patch_operation_state?: MemoryPatchOperationState;
  patch_target_kind?: MemoryMutationTargetKind;
  patch_target_id?: string;
  created_since?: Date;
  created_until?: Date;
  reviewed_since?: Date;
  reviewed_until?: Date;
  limit?: number;
  offset?: number;
}

export interface MemoryCandidateStatusEvent {
  id: string;
  candidate_id: string;
  scope_id: string;
  from_status: MemoryCandidateStatus | null;
  to_status: MemoryCandidateStatus;
  event_kind: MemoryCandidateStatusEventKind;
  interaction_id: string | null;
  reviewed_at: Date | null;
  review_reason: string | null;
  created_at: Date;
}

export interface MemoryCandidateStatusEventInput {
  id: string;
  candidate_id: string;
  scope_id: string;
  from_status?: MemoryCandidateStatus | null;
  to_status: MemoryCandidateStatus;
  event_kind: MemoryCandidateStatusEventKind;
  interaction_id?: string | null;
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
  created_at?: Date | string | null;
}

export interface MemoryCandidateStatusEventFilters {
  candidate_id?: string;
  scope_id?: string;
  event_kind?: MemoryCandidateStatusEventKind;
  to_status?: MemoryCandidateStatus;
  interaction_id?: string;
  created_since?: Date;
  created_until?: Date;
  limit?: number;
  offset?: number;
}

export interface MemoryCandidateStatusPatch {
  status: Exclude<MemoryCandidateStatus, 'promoted' | 'superseded'>;
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
}

export interface MemoryCandidatePromotionPatch {
  expected_current_status?: 'staged_for_review';
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
}

export interface MemoryCandidatePatchOperationStatePatch {
  patch_operation_state: MemoryPatchOperationState;
  expected_current_status?: MemoryCandidateStatus;
  expected_current_patch_operation_state?: MemoryPatchOperationState | null;
  expected_current_patch_ledger_event_ids?: string[];
  patch_ledger_event_ids?: string[];
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
}

export interface MemoryCandidatePromotionPreflightInput {
  id: string;
}

export type MemoryCandidateDuplicateReviewDecision =
  | 'no_match'
  | 'possible_duplicate'
  | 'likely_duplicate'
  | 'same_target_update';

export interface MemoryCandidateDuplicateReviewSummary {
  decision: MemoryCandidateDuplicateReviewDecision;
  top_match?: {
    kind: 'page' | 'memory_candidate';
    id: string;
    score: number;
    reasons: string[];
  };
}

export interface MemoryCandidatePromotionPreflightResult {
  candidate_id: string;
  decision: MemoryCandidatePromotionPreflightDecision;
  reasons: MemoryCandidatePromotionPreflightReason[];
  duplicate_review?: MemoryCandidateDuplicateReviewSummary;
  summary_lines: string[];
}

export interface MemoryCandidateSupersessionEntry {
  id: string;
  scope_id: string;
  superseded_candidate_id: string;
  replacement_candidate_id: string;
  reviewed_at: Date | null;
  review_reason: string | null;
  interaction_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryCandidateSupersessionInput {
  id: string;
  scope_id: string;
  superseded_candidate_id: string;
  replacement_candidate_id: string;
  expected_current_status: 'staged_for_review' | 'promoted';
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
  interaction_id?: string | null;
}

export type MemoryCandidateContradictionOutcome =
  | 'rejected'
  | 'unresolved'
  | 'superseded';

export type CanonicalHandoffTargetObjectType = Exclude<MemoryCandidateTargetObjectType, 'other'>;

export interface MemoryCandidateContradictionEntry {
  id: string;
  scope_id: string;
  candidate_id: string;
  challenged_candidate_id: string;
  outcome: MemoryCandidateContradictionOutcome;
  supersession_entry_id: string | null;
  reviewed_at: Date | null;
  review_reason: string | null;
  interaction_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryCandidateContradictionEntryInput {
  id: string;
  scope_id: string;
  candidate_id: string;
  challenged_candidate_id: string;
  outcome: MemoryCandidateContradictionOutcome;
  supersession_entry_id?: string | null;
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
  interaction_id?: string | null;
}

export interface CanonicalHandoffEntry {
  id: string;
  scope_id: string;
  candidate_id: string;
  target_object_type: CanonicalHandoffTargetObjectType;
  target_object_id: string;
  source_refs: string[];
  reviewed_at: Date | null;
  review_reason: string | null;
  interaction_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CanonicalHandoffEntryInput {
  id: string;
  scope_id: string;
  candidate_id: string;
  target_object_type: CanonicalHandoffTargetObjectType;
  target_object_id: string;
  source_refs: string[];
  reviewed_at?: Date | string | null;
  review_reason?: string | null;
  interaction_id?: string | null;
}

export interface CanonicalHandoffFilters {
  scope_id?: string;
  candidate_id?: string;
  target_object_type?: CanonicalHandoffTargetObjectType;
  limit?: number;
  offset?: number;
}

export interface PersonalEpisodeLookupRoute {
  route_kind: 'personal_episode_lookup';
  personal_episode_id: string;
  scope_id: string;
  title: string;
  source_kind: PersonalEpisodeSourceKind;
  start_time: Date;
  end_time: Date | null;
  summary: string;
  candidate_ids: string[];
  retrieval_route: string[];
  summary_lines: string[];
  source_refs: string[];
}

export interface PersonalEpisodeLookupRouteInput {
  scope_id?: string;
  title: string;
  source_kind?: PersonalEpisodeSourceKind;
  requested_scope?: Exclude<ScopeGateScope, 'unknown'>;
  query?: string;
}

export interface PersonalEpisodeLookupRouteResult {
  selection_reason: string;
  candidate_count: number;
  route: PersonalEpisodeLookupRoute | null;
}

export type PersonalWriteTargetKind = 'profile_memory' | 'personal_episode';

export interface PersonalWriteTargetRoute {
  route_kind: 'personal_write_target';
  target_kind: PersonalWriteTargetKind;
  scope_id: string;
  write_path: string[];
  summary_lines: string[];
}

export interface PersonalWriteTargetInput {
  target_kind: PersonalWriteTargetKind;
  requested_scope?: Exclude<ScopeGateScope, 'unknown'>;
  query?: string;
  subject?: string;
  title?: string;
}

export interface PersonalWriteTargetResult {
  selection_reason: string;
  candidate_count: number;
  route: PersonalWriteTargetRoute | null;
  scope_gate: ScopeGateDecisionResult;
}

export type RetrievalRouteIntent =
  | 'task_resume'
  | 'broad_synthesis'
  | 'precision_lookup'
  | 'mixed_scope_bridge'
  | 'personal_profile_lookup'
  | 'personal_episode_lookup';

export interface RetrievalRouteSelection {
  route_kind: RetrievalRouteIntent;
  retrieval_route: string[];
  summary_lines: string[];
  payload: unknown;
}

export interface RetrievalRouteSelectorInput {
  intent: RetrievalRouteIntent;
  task_id?: string | null;
  persist_trace?: boolean;
  requested_scope?: Exclude<ScopeGateScope, 'unknown'>;
  personal_route_kind?: 'profile' | 'episode';
  map_id?: string;
  scope_id?: string;
  kind?: string;
  query?: string;
  limit?: number;
  slug?: string;
  path?: string;
  section_id?: string;
  source_ref?: string;
  subject?: string;
  profile_type?: ProfileMemoryType;
  episode_title?: string;
  episode_source_kind?: PersonalEpisodeSourceKind;
}

export interface RetrievalRequestPlannerInput extends Omit<RetrievalRouteSelectorInput, 'intent'> {
  intent?: RetrievalRouteIntent;
  allow_decomposition?: boolean;
}

export interface RetrievalRequestPlanStep {
  step_id: string;
  intent: RetrievalRouteIntent;
  input: RetrievalRouteSelectorInput;
}

export interface RetrievalRequestPlan {
  selection_reason: 'decomposed_mixed_intent' | 'single_intent' | 'no_match';
  steps: RetrievalRequestPlanStep[];
}

export type MemoryScenario =
  | 'coding_continuation'
  | 'project_qa'
  | 'knowledge_qa'
  | 'auto_accumulation'
  | 'personal_recall'
  | 'mixed';

export type MemoryScenarioConfidence = 'high' | 'medium' | 'low';
export type MemoryScenarioScopeDecision = 'work' | 'personal' | 'mixed' | 'defer';
export type MemoryScenarioSourceKind =
  | 'chat'
  | 'code_event'
  | 'import'
  | 'meeting'
  | 'cron'
  | 'manual'
  | 'session_end'
  | 'trace_review';

export type MemoryScenarioKnownSubjectKind =
  | 'project'
  | 'system'
  | 'concept'
  | 'person'
  | 'company'
  | 'source'
  | 'file'
  | 'symbol'
  | 'task'
  | 'profile'
  | 'personal_episode';

export interface MemoryScenarioKnownSubject {
  ref: string;
  kind?: MemoryScenarioKnownSubjectKind;
}

export interface MemoryScenarioClassifierInput {
  query?: string;
  task_id?: string | null;
  repo_path?: string | null;
  requested_scope?: Exclude<MemoryScenarioScopeDecision, 'defer'>;
  source_kind?: MemoryScenarioSourceKind;
  known_subjects?: Array<string | MemoryScenarioKnownSubject>;
}

export interface MemoryScenarioDecomposedRoute {
  scenario: Exclude<MemoryScenario, 'mixed'>;
  confidence: MemoryScenarioConfidence;
  reason_codes: string[];
}

export interface MemoryScenarioClassifierResult {
  scenario: MemoryScenario;
  confidence: MemoryScenarioConfidence;
  scope_decision: MemoryScenarioScopeDecision;
  reason_codes: string[];
  requires_user_clarification: boolean;
  decomposed_routes: MemoryScenarioDecomposedRoute[];
}

export type MemoryActivationDecision =
  | 'answer_ground'
  | 'citation_only'
  | 'orientation_only'
  | 'verify_first'
  | 'suppress_if_valid'
  | 'candidate_only'
  | 'ignore';

export type MemoryArtifactKind =
  | 'current_artifact'
  | 'compiled_truth'
  | 'timeline'
  | 'source_record'
  | 'context_map'
  | 'codemap_pointer'
  | 'task_attempt_failed'
  | 'task_decision'
  | 'memory_candidate'
  | 'profile_memory'
  | 'personal_episode';

export type MemoryArtifactAuthority =
  | 'user_direct_statement'
  | 'verified_current_artifact'
  | 'canonical_compiled_truth'
  | 'source_or_timeline_evidence'
  | 'operational_memory'
  | 'derived_orientation'
  | 'unreviewed_candidate'
  | 'scope_denied';

export type MemoryNextTool =
  | 'get_page'
  | 'get_task_working_set'
  | 'resume_task'
  | 'record_attempt'
  | 'record_decision'
  | 'record_retrieval_trace'
  | 'reverify_code_claims'
  | 'query_context_map'
  | 'get_precision_lookup_route'
  | 'create_memory_candidate_entry'
  | 'rank_memory_candidate_entries'
  | 'evaluate_scope_gate'
  | 'answer_now';

export type MemoryWritebackHint =
  | 'none'
  | 'record_trace'
  | 'record_attempt'
  | 'record_decision'
  | 'refresh_working_set'
  | 'create_candidate'
  | 'update_canonical_direct'
  | 'defer_for_review'
  | 'sync_after_write';

export interface MemoryActivationArtifact {
  id: string;
  artifact_kind: MemoryArtifactKind;
  source_ref?: string;
  stale?: boolean;
  anchors_valid?: boolean;
  scope_policy?: ScopeGatePolicy;
}

export interface MemoryActivationPolicyInput {
  scenario: MemoryScenario;
  artifacts: MemoryActivationArtifact[];
}

export interface MemoryActivationPolicyDecision {
  artifact_id: string;
  decision: MemoryActivationDecision;
  authority: MemoryArtifactAuthority;
  reason_codes: string[];
  source_ref: string | null;
}

export interface MemoryActivationPolicyResult {
  decisions: MemoryActivationPolicyDecision[];
  next_tool: MemoryNextTool;
  writeback_hint: MemoryWritebackHint;
  stale_warnings: string[];
  verification_required: boolean;
  source_refs: string[];
  trace_required: boolean;
}

export type MemoryScenarioClassification = MemoryScenarioClassifierResult;

export interface MemoryPlannedActivationRule {
  planned_read: string;
  artifact_kind: MemoryArtifactKind;
  decision: MemoryActivationDecision;
  authority: MemoryArtifactAuthority;
  reason_codes: string[];
}

export interface ScenarioMemoryRequestInput extends MemoryScenarioClassifierInput {
  artifacts?: MemoryActivationArtifact[];
}

export interface ScenarioMemorySubplan {
  scenario: Exclude<MemoryScenario, 'mixed'>;
  primary_reads: string[];
  secondary_reads: string[];
  next_tool: MemoryNextTool;
  writeback_hint: MemoryWritebackHint;
  planned_activation_rules: MemoryPlannedActivationRule[];
}

export interface ScenarioMemoryRequestPlan {
  classification: MemoryScenarioClassification;
  primary_reads: string[];
  secondary_reads: string[];
  activation_decisions: MemoryActivationPolicyDecision[];
  next_tool: MemoryNextTool;
  writeback_hint: MemoryWritebackHint;
  stale_warnings: string[];
  verification_required: boolean;
  source_refs: string[];
  trace_required: boolean;
  decomposed_plans: ScenarioMemorySubplan[];
  planned_activation_rules: MemoryPlannedActivationRule[];
}

export type RetrievalSelectorKind =
  | 'page'
  | 'compiled_truth'
  | 'section'
  | 'line_span'
  | 'timeline_entry'
  | 'timeline_range'
  | 'source_ref'
  | 'task_working_set'
  | 'task_attempt'
  | 'task_decision'
  | 'profile_memory'
  | 'personal_episode';

export type RetrievalFreshness = 'current' | 'stale' | 'unknown';
export type ProbeAnswerKind = 'mention_existence' | 'slug_disambiguation' | 'none';
export type ContextReadMode = 'explicit' | 'auto';
export type ContextTimelineMode = 'auto' | 'include' | 'exclude';

export interface RetrievalSelector {
  selector_id?: string;
  kind: RetrievalSelectorKind;
  scope_id?: string;
  slug?: string;
  path?: string;
  section_id?: string;
  line_start?: number;
  line_end?: number;
  char_start?: number;
  char_end?: number;
  source_ref?: string;
  object_id?: string;
  source_refs?: string[];
  content_hash?: string;
  freshness?: RetrievalFreshness;
}

export interface RetrievalCanonicalTarget {
  kind: RetrievalSelectorKind;
  slug?: string;
  title?: string;
  type?: PageType;
  path?: string;
  section_id?: string;
  scope_id?: string;
}

export interface RetrievalMatchedChunk {
  slug: string;
  page_id: number;
  title: string;
  type: PageType;
  chunk_source: ChunkSource;
  score: number;
  stale: boolean;
}

export interface RetrieveContextCandidate {
  candidate_id: string;
  canonical_target: RetrievalCanonicalTarget;
  matched_chunks: RetrievalMatchedChunk[];
  why_matched: string[];
  activation: MemoryActivationDecision;
  read_priority: number;
  read_selector: RetrievalSelector;
}

export interface RetrieveContextAnswerability {
  answerable_from_probe: boolean;
  allowed_probe_answer_kind: ProbeAnswerKind;
  must_read_context: boolean;
  reason_codes: string[];
}

export interface RetrieveContextOrientation {
  derived_consulted: string[];
  recommended_reads: RetrievalSelector[];
  summary_lines: string[];
}

export interface RetrieveContextInput extends MemoryScenarioClassifierInput {
  selectors?: RetrievalSelector[];
  limit?: number;
  token_budget?: number;
  include_orientation?: boolean;
  persist_trace?: boolean;
}

export interface RetrieveContextResult {
  request_id: string;
  scenario: MemoryScenario;
  scope_gate?: ScopeGateDecisionResult;
  route: RetrievalRouteSelectorResult | null;
  answerability: RetrieveContextAnswerability;
  candidates: RetrieveContextCandidate[];
  required_reads: RetrievalSelector[];
  orientation: RetrieveContextOrientation;
  warnings: string[];
  trace?: RetrievalTrace | null;
}

export interface ContextAnswerReady {
  ready: boolean;
  answer_ground: RetrievalSelector[];
  unsupported_reasons: string[];
  citation_policy: string;
}

export interface CanonicalContextRead {
  selector: RetrievalSelector;
  authority: MemoryArtifactAuthority;
  title: string;
  text: string;
  source_refs: string[];
  token_estimate: number;
  has_more: boolean;
  continuation_selector?: RetrievalSelector;
}

export interface ContextEvidenceClaim {
  selector_id: string;
  claim_kind: 'compiled_truth' | 'timeline_evidence' | 'task_state' | 'profile_memory' | 'personal_episode';
  source_refs: string[];
}

export interface ContextConflict {
  selector_id: string;
  summary: string;
  source_refs: string[];
}

export interface ReadContextInput {
  query?: string;
  selectors?: RetrievalSelector[];
  reads?: ContextReadMode;
  token_budget?: number;
  max_selectors?: number;
  include_timeline?: ContextTimelineMode;
  include_source_refs?: boolean;
  persist_trace?: boolean;
  task_id?: string | null;
  requested_scope?: Exclude<ScopeGateScope, 'unknown'>;
}

export interface ReadContextResult {
  answer_ready: ContextAnswerReady;
  canonical_reads: CanonicalContextRead[];
  evidence_claims: ContextEvidenceClaim[];
  conflicts: ContextConflict[];
  warnings: string[];
  unread_required: RetrievalSelector[];
  continuations: RetrievalSelector[];
  scope_gate?: ScopeGateDecisionResult;
  trace?: RetrievalTrace | null;
}

export interface RetrievalRouteSelectorResult {
  selected_intent: RetrievalRouteIntent;
  selection_reason: string;
  candidate_count: number;
  route: RetrievalRouteSelection | null;
  scope_gate?: ScopeGateDecisionResult;
  trace?: RetrievalTrace | null;
}

export type ScopeGateScope = 'work' | 'personal' | 'mixed' | 'unknown';
export type ScopeGatePolicy = 'allow' | 'defer' | 'deny';

export type RetrievalTraceWriteOutcome =
  | 'no_durable_write'
  | 'operational_write'
  | 'candidate_created'
  | 'promoted'
  | 'rejected'
  | 'superseded';
export type ScopeGateIntent = RetrievalRouteIntent;

export interface ScopeGateDecisionInput {
  intent: ScopeGateIntent;
  requested_scope?: Exclude<ScopeGateScope, 'unknown'>;
  task_id?: string | null;
  query?: string;
  repo_path?: string;
  subject?: string;
  title?: string;
}

export interface ScopeGateDecisionResult {
  resolved_scope: ScopeGateScope;
  policy: ScopeGatePolicy;
  decision_reason: string;
  summary_lines: string[];
}

export interface WorkspaceSystemCard {
  card_kind: 'workspace_system';
  system_slug: string;
  title: string;
  repo?: string;
  build_command?: string;
  test_command?: string;
  entry_points: SystemEntryPoint[];
  summary_lines: string[];
}

export interface WorkspaceSystemCardInput {
  map_id?: string;
  scope_id?: string;
  kind?: string;
}

export interface WorkspaceSystemCardResult {
  selection_reason: string;
  candidate_count: number;
  card: WorkspaceSystemCard | null;
}

export interface WorkspaceProjectCard {
  card_kind: 'workspace_project';
  project_slug: string;
  title: string;
  path: string;
  repo?: string;
  status?: string;
  related_systems: string[];
  summary_lines: string[];
}

export interface WorkspaceProjectCardInput {
  map_id?: string;
  scope_id?: string;
  kind?: string;
}

export interface WorkspaceProjectCardResult {
  selection_reason: string;
  candidate_count: number;
  card: WorkspaceProjectCard | null;
}

export interface WorkspaceOrientationBundle {
  bundle_kind: 'workspace_orientation';
  title: string;
  map_id: string;
  status: string;
  summary_lines: string[];
  recommended_reads: ContextMapReportRead[];
  system_card: WorkspaceSystemCard | null;
  project_card: WorkspaceProjectCard | null;
}

export interface WorkspaceOrientationBundleInput {
  map_id?: string;
  scope_id?: string;
  kind?: string;
}

export interface WorkspaceOrientationBundleResult {
  selection_reason: string;
  candidate_count: number;
  bundle: WorkspaceOrientationBundle | null;
}

export interface WorkspaceCorpusCard {
  card_kind: 'workspace_corpus';
  title: string;
  map_id: string;
  status: string;
  anchor_slugs: string[];
  recommended_reads: ContextMapReportRead[];
  summary_lines: string[];
}

export interface WorkspaceCorpusCardInput {
  map_id?: string;
  scope_id?: string;
  kind?: string;
}

export interface WorkspaceCorpusCardResult {
  selection_reason: string;
  candidate_count: number;
  card: WorkspaceCorpusCard | null;
}

export interface AtlasOrientationCard {
  card_kind: 'atlas_orientation';
  title: string;
  atlas_entry_id: string;
  map_id: string;
  freshness: string;
  budget_hint: number;
  anchor_slugs: string[];
  recommended_reads: ContextMapReportRead[];
  summary_lines: string[];
}

export interface AtlasOrientationCardInput {
  atlas_id?: string;
  scope_id?: string;
  kind?: string;
  max_budget_hint?: number;
  allow_stale?: boolean;
}

export interface AtlasOrientationCardResult {
  selection_reason: string;
  candidate_count: number;
  card: AtlasOrientationCard | null;
}

export interface AtlasOrientationBundle {
  bundle_kind: 'atlas_orientation';
  title: string;
  atlas_entry_id: string;
  freshness: string;
  budget_hint: number;
  summary_lines: string[];
  report: ContextAtlasReport;
  card: AtlasOrientationCard;
}

export interface AtlasOrientationBundleInput {
  atlas_id?: string;
  scope_id?: string;
  kind?: string;
  max_budget_hint?: number;
  allow_stale?: boolean;
}

export interface AtlasOrientationBundleResult {
  selection_reason: string;
  candidate_count: number;
  bundle: AtlasOrientationBundle | null;
}

// Chunks
export interface Chunk {
  id: number;
  page_id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: ChunkSource;
  embedding: Float32Array | null;
  model: string;
  token_count: number | null;
  embedded_at: Date | null;
}

export interface ChunkInput {
  chunk_index: number;
  chunk_text: string;
  chunk_source: ChunkSource;
  embedding?: Float32Array;
  model?: string;
  token_count?: number;
}

// Search
export interface SearchResult {
  slug: string;
  page_id: number;
  title: string;
  type: PageType;
  chunk_text: string;
  chunk_source: ChunkSource;
  score: number;
  stale: boolean;
}

export interface SearchOpts {
  limit?: number;
  type?: PageType;
  exclude_slugs?: string[];
}

// Links
export interface Link {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
}

export interface GraphNode {
  slug: string;
  title: string;
  type: PageType;
  depth: number;
  links: { to_slug: string; link_type: string }[];
}

// Timeline
export interface TimelineEntry {
  id: number;
  page_id: number;
  date: string;
  source: string;
  summary: string;
  detail: string;
  created_at: Date;
}

export interface TimelineInput {
  date: string;
  source?: string;
  summary: string;
  detail?: string;
}

export interface TimelineOpts {
  limit?: number;
  offset?: number;
  after?: string;
  before?: string;
}

// Raw data
export interface RawData {
  source: string;
  data: Record<string, unknown>;
  fetched_at: Date;
}

// Versions
export interface PageVersion {
  id: number;
  page_id: number;
  compiled_truth: string;
  frontmatter: Record<string, unknown>;
  snapshot_at: Date;
}

// Stats + Health
export interface BrainStats {
  page_count: number;
  chunk_count: number;
  embedded_count: number;
  link_count: number;
  tag_count: number;
  timeline_entry_count: number;
  pages_by_type: Record<string, number>;
}

export interface BrainHealth {
  page_count: number;
  embed_coverage: number;
  stale_pages: number;
  orphan_pages: number;
  dead_links: number;
  missing_embeddings: number;
}

// Ingest log
export interface IngestLogEntry {
  id: number;
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
  created_at: Date;
}

export interface IngestLogInput {
  source_type: string;
  source_ref: string;
  pages_updated: string[];
  summary: string;
}

// Config
export interface EngineConfig {
  database_url?: string;
  database_path?: string;
  engine?: 'postgres' | 'sqlite' | 'pglite';
  poolSize?: number;
}

// Operational memory
export type TaskScope = 'work' | 'personal' | 'mixed';
export type TaskStatus = 'active' | 'paused' | 'blocked' | 'completed' | 'abandoned';
export type AttemptOutcome = 'failed' | 'partial' | 'succeeded' | 'abandoned';

export interface TaskThread {
  id: string;
  scope: TaskScope;
  title: string;
  goal: string;
  status: TaskStatus;
  repo_path: string | null;
  branch_name: string | null;
  current_summary: string;
  created_at: Date;
  updated_at: Date;
}

export interface TaskThreadInput {
  id: string;
  scope: TaskScope;
  title: string;
  goal?: string;
  status: TaskStatus;
  repo_path?: string | null;
  branch_name?: string | null;
  current_summary?: string;
}

export interface TaskThreadPatch {
  scope?: TaskScope;
  title?: string;
  goal?: string;
  status?: TaskStatus;
  repo_path?: string | null;
  branch_name?: string | null;
  current_summary?: string;
}

export interface TaskThreadFilters {
  scope?: TaskScope;
  status?: TaskStatus;
  limit?: number;
  offset?: number;
}

export interface TaskWorkingSet {
  task_id: string;
  active_paths: string[];
  active_symbols: string[];
  blockers: string[];
  open_questions: string[];
  next_steps: string[];
  verification_notes: string[];
  last_verified_at: Date | null;
  updated_at: Date;
}

export interface TaskWorkingSetInput {
  task_id: string;
  active_paths: string[];
  active_symbols: string[];
  blockers: string[];
  open_questions: string[];
  next_steps: string[];
  verification_notes: string[];
  last_verified_at?: Date | string | null;
}

export interface TaskAttempt {
  id: string;
  task_id: string;
  summary: string;
  outcome: AttemptOutcome;
  applicability_context: Record<string, unknown>;
  evidence: string[];
  created_at: Date;
}

export interface TaskAttemptInput {
  id: string;
  task_id: string;
  summary: string;
  outcome: AttemptOutcome;
  applicability_context?: Record<string, unknown>;
  evidence?: string[];
}

export interface TaskDecision {
  id: string;
  task_id: string;
  summary: string;
  rationale: string;
  consequences: string[];
  validity_context: Record<string, unknown>;
  created_at: Date;
}

export interface TaskDecisionInput {
  id: string;
  task_id: string;
  summary: string;
  rationale: string;
  consequences?: string[];
  validity_context?: Record<string, unknown>;
}

export interface RetrievalTrace {
  id: string;
  task_id: string | null;
  // widened from TaskScope — supports task-less traces
  scope: ScopeGateScope;
  route: string[];
  source_refs: string[];
  derived_consulted: string[];
  verification: string[];
  write_outcome: RetrievalTraceWriteOutcome;
  selected_intent: RetrievalRouteIntent | null;
  scope_gate_policy: ScopeGatePolicy | null;
  scope_gate_reason: string | null;
  outcome: string;
  created_at: Date;
}

export interface RetrievalTraceInput {
  id: string;
  task_id?: string | null;
  // widened from TaskScope — supports task-less traces
  scope: ScopeGateScope;
  route?: string[];
  source_refs?: string[];
  derived_consulted?: string[];
  verification?: string[];
  write_outcome?: RetrievalTraceWriteOutcome;
  selected_intent?: RetrievalRouteIntent | null;
  scope_gate_policy?: ScopeGatePolicy | null;
  scope_gate_reason?: string | null;
  outcome: string;
}

export interface CodeClaim {
  path?: string;
  symbol?: string;
  branch_name?: string;
  source_trace_id?: string;
}

export type CodeClaimVerificationStatus = 'current' | 'stale' | 'unverifiable';

export interface CodeClaimVerificationResult {
  claim: CodeClaim;
  status: CodeClaimVerificationStatus;
  reason: 'ok' | 'file_missing' | 'symbol_missing' | 'symbol_path_missing' | 'branch_mismatch' | 'branch_unknown' | 'repo_missing';
  checked_at: string;
}

export interface RetrievalTraceWindowFilters {
  since: Date;
  until: Date;
  task_id?: string;
  scope?: ScopeGateScope;
  limit?: number;
  offset?: number;
}

export interface AuditLinkedWriteCounts {
  handoff_count: number;
  supersession_count: number;
  contradiction_count: number;
  traces_with_any_linked_write: number;
  traces_without_linked_write: number;
}

export interface AuditApproximateCounts {
  candidate_creation_same_window: number;
  candidate_rejection_same_window: number;
  note: string;
}

export interface AuditCandidateStatusEventCounts {
  created_count: number;
  advanced_count: number;
  promoted_count: number;
  rejected_count: number;
  superseded_count: number;
  linked_event_count: number;
  unlinked_event_count: number;
  traces_with_candidate_events: number;
}

export interface AuditTaskCompliance {
  tasks_with_traces: number;
  tasks_without_traces: number;
  task_scan_capped_at: number | null;
  top_backlog: Array<{
    task_id: string;
    last_trace_at: string | null;
    last_route_kind: string | null;
  }>;
}

export interface AuditBrainLoopInput {
  since?: Date | string;
  until?: Date | string;
  task_id?: string;
  scope?: ScopeGateScope;
  limit?: number;
}

export interface AuditBrainLoopReport {
  window: { since: string; until: string };
  total_traces: number;
  by_selected_intent: Partial<Record<RetrievalRouteIntent | 'unknown_legacy', number>>;
  by_scope: Partial<Record<ScopeGateScope, number>>;
  by_scope_gate_policy: Partial<Record<ScopeGatePolicy, number>>;
  most_common_defer_reason: string | null;
  canonical_vs_derived: {
    canonical_ref_count: number;
    derived_ref_count: number;
    canonical_ratio: number;
  };
  linked_writes: AuditLinkedWriteCounts;
  candidate_status_events: AuditCandidateStatusEventCounts;
  approximate: AuditApproximateCounts;
  task_compliance: AuditTaskCompliance;
  summary_lines: string[];
}

// Errors
export class MBrainError extends Error {
  constructor(
    public problem: string,
    public cause_description: string,
    public fix: string,
    public docs_url?: string,
  ) {
    super(`${problem}: ${cause_description}. Fix: ${fix}`);
    this.name = 'MBrainError';
  }
}
