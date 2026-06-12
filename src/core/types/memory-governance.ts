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
  | 'physical_delete_memory_record'
  | 'governed_canonical_write'
  | 'pause_source_processing'
  | 'revoke_source_consent'
  | 'rerun_memory_job';

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

export type MemoryCandidateVerificationStatus = 'unverified' | 'verified' | 'refuted';

export type MemoryCandidateVerificationMethod =
  | 'command_execution'
  | 'db_query'
  | 'file_inspection'
  | 'source_recheck'
  | 'user_confirmation'
  | 'external_lookup';

export type MemoryCandidatePromotionPreflightDecision = 'allow' | 'deny' | 'defer';

export type MemoryCandidatePromotionPreflightReason =
  | 'candidate_not_staged_for_review'
  | 'candidate_missing_provenance'
  | 'candidate_missing_target_object'
  | 'candidate_scope_conflict'
  | 'candidate_unknown_sensitivity'
  | 'candidate_requires_revalidation'
  | 'candidate_refuted'
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
  verification_status: MemoryCandidateVerificationStatus;
  verification_method: MemoryCandidateVerificationMethod | null;
  verification_evidence: string | null;
  verification_source_refs: string[];
  verified_at: Date | null;
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

export interface MemoryCandidateVerificationPatch {
  verification_status: Exclude<MemoryCandidateVerificationStatus, 'unverified'>;
  verification_method: MemoryCandidateVerificationMethod;
  verification_evidence: string;
  verification_source_refs?: string[];
  verified_at?: Date | string | null;
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
  duplicate_review: MemoryCandidateDuplicateReviewSummary;
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
