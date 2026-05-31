import type { ContextAtlasReport, ContextMapReportRead } from './context-map-atlas.ts';
import type { SystemEntryPoint } from './page.ts';

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
