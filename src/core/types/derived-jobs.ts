export type DerivedArtifactKind =
  | 'page_chunks'
  | 'note_manifest'
  | 'note_sections'
  | 'context_map'
  | 'context_atlas';

export type DerivedJobStatus = 'pending' | 'running' | 'failed' | 'superseded';
export type DerivedIndexStatus = 'pending' | 'ready' | 'failed';

export interface DerivedJob {
  id: string;
  scope_id: string;
  slug: string;
  artifact_kind: DerivedArtifactKind;
  target_content_hash: string;
  manifest_path: string | null;
  derived_parameters: Record<string, unknown>;
  status: DerivedJobStatus;
  attempts: number;
  last_error: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DerivedJobInput {
  scope_id: string;
  slug: string;
  artifact_kind: DerivedArtifactKind;
  target_content_hash: string;
  manifest_path?: string | null;
  derived_parameters?: Record<string, unknown>;
  extractor_version?: string;
  derived_schema_version?: string;
}

export interface DerivedJobLeaseInput {
  lease_owner: string;
  lease_duration_ms?: number;
}

export interface DerivedJobFailureInput {
  id: string;
  error: string;
  lease_owner?: string;
  max_attempts?: number;
}

export interface DerivedJobLeaseReleaseInput {
  id: string;
  lease_owner: string;
}

export interface DerivedJobFilters {
  scope_id?: string;
  slug?: string;
  artifact_kind?: DerivedArtifactKind;
  status?: DerivedJobStatus;
  manifest_path?: string;
  limit?: number;
  offset?: number;
}

export interface DerivedIndexState {
  scope_id: string;
  slug: string;
  artifact_kind: DerivedArtifactKind;
  target_content_hash: string;
  indexed_content_hash: string | null;
  status: DerivedIndexStatus;
  extractor_version: string;
  derived_schema_version: string;
  last_error: string | null;
  updated_at: Date;
}

export interface DerivedIndexStateFilters {
  scope_id?: string;
  slug?: string;
  artifact_kind?: DerivedArtifactKind;
  status?: DerivedIndexStatus;
  limit?: number;
  offset?: number;
}
