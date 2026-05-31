import type { ScopeGateDecisionResult, ScopeGateScope } from './retrieval-routing.ts';

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
