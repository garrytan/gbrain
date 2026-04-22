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

export interface BroadSynthesisRoute {
  route_kind: 'broad_synthesis';
  map_id: string;
  query: string;
  status: string;
  retrieval_route: string[];
  focal_node_id: string | null;
  summary_lines: string[];
  matched_nodes: ContextMapQueryMatch[];
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
  task_id?: string;
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
export type ScopeGateIntent = RetrievalRouteIntent;

export interface ScopeGateDecisionInput {
  intent: ScopeGateIntent;
  requested_scope?: Exclude<ScopeGateScope, 'unknown'>;
  task_id?: string;
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
  scope: TaskScope;
  route: string[];
  source_refs: string[];
  verification: string[];
  outcome: string;
  created_at: Date;
}

export interface RetrievalTraceInput {
  id: string;
  task_id?: string | null;
  scope: TaskScope;
  route?: string[];
  source_refs?: string[];
  verification?: string[];
  outcome: string;
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
