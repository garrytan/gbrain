import type { MemoryCandidateEntry, MemoryCandidateEntryInput, MemoryCandidateExtractionKind, MemoryCandidateSensitivity, MemoryCandidateStatus, MemoryCandidateTargetObjectType, MemoryCandidateType } from './memory-governance.ts';
import type { ChunkSource, PageType } from './page.ts';
import type { BroadSynthesisRoute, MixedScopeBridgeRoute, PrecisionLookupRoute } from './context-map-atlas.ts';
import type { PersonalEpisodeLookupRoute, PersonalEpisodeSourceKind, PersonalProfileLookupRoute, ProfileMemoryType } from './profile-episode.ts';
import type { RetrievalTrace } from './retrieval-trace.ts';

export type RetrievalRouteIntent =
  | 'task_resume'
  | 'broad_synthesis'
  | 'precision_lookup'
  | 'mixed_scope_bridge'
  | 'personal_profile_lookup'
  | 'personal_episode_lookup';

interface RetrievalRouteSelectionBase {
  retrieval_route: string[];
  summary_lines: string[];
}

interface TaskResumeRoutePayload {
  task_id: string;
}

export type RetrievalRouteSelection =
  | (RetrievalRouteSelectionBase & {
    route_kind: 'task_resume';
    payload: TaskResumeRoutePayload;
  })
  | (RetrievalRouteSelectionBase & {
    route_kind: 'broad_synthesis';
    payload: BroadSynthesisRoute;
  })
  | (RetrievalRouteSelectionBase & {
    route_kind: 'precision_lookup';
    payload: PrecisionLookupRoute;
  })
  | (RetrievalRouteSelectionBase & {
    route_kind: 'mixed_scope_bridge';
    payload: MixedScopeBridgeRoute;
  })
  | (RetrievalRouteSelectionBase & {
    route_kind: 'personal_profile_lookup';
    payload: PersonalProfileLookupRoute;
  })
  | (RetrievalRouteSelectionBase & {
    route_kind: 'personal_episode_lookup';
    payload: PersonalEpisodeLookupRoute;
  });

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

export type MemoryActivationLabel =
  | 'answer_ground'
  | 'citation_only'
  | 'orientation_only'
  | 'hint_only'
  | 'promote_first'
  | 'audit_only'
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
  | 'profile_memory'
  | 'personal_episode'
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
  | 'route_memory_writeback'
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

export type MemoryWritebackEvidenceKind =
  | 'direct_user_statement'
  | 'source_extracted'
  | 'agent_inferred'
  | 'ambiguous'
  | 'contradicts_existing'
  | 'code_sensitive'
  | 'task_mechanics';

export type MemoryWritebackDecision =
  | 'create_candidate'
  | 'canonical_write_allowed'
  | 'no_write'
  | 'defer';

export type MemoryWritebackIntendedOperation =
  | 'create_memory_candidate_entry'
  | 'put_page'
  | 'none';

export interface RouteMemoryWritebackInput {
  content: string;
  source_refs?: string[];
  corpus_lane?: CorpusLaneMetadata;
  source_kind?: MemoryScenarioSourceKind;
  evidence_kind: MemoryWritebackEvidenceKind;
  candidate_type?: MemoryCandidateType;
  target_object_type?: MemoryCandidateTargetObjectType;
  target_object_id?: string;
  target_snapshot_hash?: string | null;
  scope_id?: string;
  sensitivity?: MemoryCandidateSensitivity;
  confidence_score?: number;
  importance_score?: number;
  recurrence_score?: number;
  interaction_id?: string;
  allow_canonical_write?: boolean;
  apply?: boolean;
}

export interface RouteMemoryWritebackCandidateInput
  extends Omit<MemoryCandidateEntryInput, 'id'> {
  id?: string;
  interaction_id?: string | null;
}

export interface RouteMemoryWritebackResult {
  decision: MemoryWritebackDecision;
  intended_operation: MemoryWritebackIntendedOperation;
  applied: boolean;
  reasons: string[];
  missing_requirements: string[];
  normalized_signal: {
    evidence_kind: MemoryWritebackEvidenceKind;
    source_kind: MemoryScenarioSourceKind | null;
    scope_id: string;
    sensitivity: MemoryCandidateSensitivity;
    candidate_type: MemoryCandidateType | null;
    extraction_kind: MemoryCandidateExtractionKind | null;
    target_object_type: MemoryCandidateTargetObjectType | null;
    target_object_id: string | null;
  };
  candidate_input?: RouteMemoryWritebackCandidateInput;
  created_candidate?: MemoryCandidateEntry;
  duplicate_review?: unknown;
  canonical_write_requirements?: {
    source_refs: string[];
    target_object_type: MemoryCandidateTargetObjectType;
    target_object_id: string;
    expected_content_hash: string | null;
    sensitivity: MemoryCandidateSensitivity;
  };
  writeback_governance_metadata?: WritebackGovernanceMetadata;
}

export interface MemoryActivationArtifact {
  id: string;
  artifact_kind: MemoryArtifactKind;
  source_ref?: string;
  stale?: boolean;
  anchors_valid?: boolean;
  scope_policy?: ScopeGatePolicy;
  candidate_status?: MemoryCandidateStatus;
  target_object_type?: MemoryCandidateTargetObjectType;
  source_refs_count?: number;
}

export interface MemoryActivationPolicyInput {
  scenario: MemoryScenario;
  artifacts: MemoryActivationArtifact[];
}

export interface MemoryActivationPolicyDecision {
  artifact_id: string;
  decision: MemoryActivationDecision;
  activation_label: MemoryActivationLabel;
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
  | 'frontmatter'
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

export type CorpusLaneArtifactKind =
  | 'note'
  | 'worktree'
  | 'transcript'
  | 'import'
  | 'source_record'
  | 'derived';

export interface CorpusLaneMetadata {
  lane_id: string;
  source_record?: string;
  import_origin?: string;
  artifact_kind?: CorpusLaneArtifactKind;
}

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
  corpus_lane?: CorpusLaneMetadata;
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
  corpus_lane?: CorpusLaneMetadata;
}

export interface RetrievalMatchedChunk {
  slug: string;
  page_id: number;
  title: string;
  type: PageType;
  chunk_source: ChunkSource;
  score: number;
  stale: boolean;
  corpus_lane?: CorpusLaneMetadata;
}

export type EvidenceSourceRefKind =
  | 'user'
  | 'task'
  | 'corpus_lane'
  | 'source_record'
  | 'import_origin'
  | 'other';

export interface RetrieveContextCandidateEvidenceMetadata {
  evidence_role: 'probe_candidate_pointer';
  authority: 'not_answer_evidence' | 'selector_planning_only';
  activation: MemoryActivationDecision;
  freshness: RetrievalFreshness;
  content_hash?: string;
  source_ref_count: number;
  source_ref_kinds: EvidenceSourceRefKind[];
  corpus_lane?: CorpusLaneMetadata;
  scope_gate?: ScopeGateDecisionResult;
  rank_reason: string[];
}

export interface RetrieveContextCandidate {
  candidate_id: string;
  canonical_target: RetrievalCanonicalTarget;
  matched_chunks: RetrievalMatchedChunk[];
  why_matched: string[];
  activation: MemoryActivationDecision;
  read_priority: number;
  read_selector: RetrievalSelector;
  evidence_metadata?: RetrieveContextCandidateEvidenceMetadata;
}

export type CandidateSignalPolicyMode = 'normal' | 'expanded' | 'strict' | 'audit';

export type CandidateSignalAuthority =
  | 'unreviewed_candidate'
  | 'approved_pending_canonicalization';

export type CandidateSignalRelationToCanonical =
  | 'same_target'
  | 'updates'
  | 'conflicts'
  | 'supports'
  | 'adjacent'
  | 'unknown';

export type CandidateSignalPromotionHint =
  | 'no_action'
  | 'inspect_candidate'
  | 'advance_to_review'
  | 'consider_preflight'
  | 'needs_provenance'
  | 'needs_target'
  | 'needs_canonical_target_proposal'
  | 'approve_or_reject_canonical_target_proposal'
  | 'complete_canonical_target_binding'
  | 'needs_scope_decision'
  | 'already_promoted_needs_handoff'
  | 'handoff_ready_for_curated_update';

export type CandidateSignalDispositionHint =
  | 'keep_candidate'
  | 'reject_low_value'
  | 'reject_missing_provenance'
  | 'reject_scope_conflict'
  | 'supersede_with_newer_candidate'
  | 'revalidate_stale_claim'
  | 'hide_from_default_retrieval'
  | 'requires_redaction_review';

export type CandidateSignalPressureReason =
  | 'missing_provenance'
  | 'missing_target'
  | 'stale_promoted_without_handoff'
  | 'unresolved_exposed_candidate'
  | 'canonical_target_proposal_hard_blocked'
  | 'high_recurrence';

export type CandidateSignalReviewPriorityHint =
  | 'no_priority'
  | 'inspect_candidate'
  | 'advance_to_review'
  | 'record_canonical_handoff'
  | 'reject_missing_provenance'
  | 'bind_target_before_review'
  | 'needs_canonical_target_proposal'
  | 'approve_or_reject_canonical_target_proposal'
  | 'complete_canonical_target_binding';

export interface CandidateSignalPolicy {
  mode: CandidateSignalPolicyMode;
  reason_codes: string[];
  included_count: number;
  suppressed_count: number;
}

export type CandidateTargetBindingState =
  | 'bound'
  | 'targetless'
  | 'proposal_pending'
  | 'binding_pending'
  | 'proposal_bound'
  | 'hard_blocked_by_proposal'
  | 'promoted_without_handoff'
  | 'promoted_with_handoff'
  | 'terminal'
  | 'redacted';

export interface CandidateGovernanceMetadata {
  answer_ground: false;
  why_not_answer_ground: string[];
  verification: {
    status: MemoryCandidateEntry['verification_status'];
    method: MemoryCandidateEntry['verification_method'] | string | null;
    source_refs_count: number;
    verified_at_present: boolean;
  };
  target_binding: {
    state: CandidateTargetBindingState;
    handoff_present: boolean;
    target_object_type?: MemoryCandidateTargetObjectType | null;
    target_object_id?: string | null;
    proposal_status?: string | null;
    proposal_status_reason?: string | null;
  };
  pressure: {
    score: number;
    reasons: CandidateSignalPressureReason[];
    review_priority_hint: CandidateSignalReviewPriorityHint;
  };
}

export interface CandidateSignal {
  candidate_id: string;
  status: MemoryCandidateStatus;
  authority: CandidateSignalAuthority;
  activation: 'candidate_only';
  target_object_type: MemoryCandidateTargetObjectType | null;
  target_object_id: string | null;
  relation_to_canonical: CandidateSignalRelationToCanonical;
  score: number;
  score_reasons: string[];
  promotion_hint: CandidateSignalPromotionHint;
  disposition_hint: CandidateSignalDispositionHint;
  pressure_score: number;
  pressure_reasons: CandidateSignalPressureReason[];
  review_priority_hint: CandidateSignalReviewPriorityHint;
  summary: string;
  candidate_governance_metadata?: CandidateGovernanceMetadata;
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
  graph_paths_considered?: string[];
}

export type RetrieveContextReadPlanMode = 'bounded_evidence';

export type RetrieveContextReadPlanGapReason =
  | 'no_canonical_read_candidates'
  | 'candidate_pool_exceeds_read_budget'
  | 'orientation_reads_deferred'
  | 'candidate_signals_are_non_canonical'
  | 'retrieval_backend_partial_failure'
  | 'retrieval_backend_failed';

export interface RetrieveContextReadPlan {
  mode: RetrieveContextReadPlanMode;
  max_depth: number;
  max_selectors: number;
  selected_selectors: string[];
  selected_selector_snapshots?: RetrievalSelector[];
  deferred_candidate_ids: string[];
  gap_reasons: RetrieveContextReadPlanGapReason[];
  next_actions: string[];
  backend_gap?: RetrieveContextBackendGap;
}

export interface RetrieveContextBackendGap {
  status: 'partial_failure' | 'failed';
  reason_code: Extract<RetrieveContextReadPlanGapReason, 'retrieval_backend_partial_failure' | 'retrieval_backend_failed'>;
  failed_query_count: number;
  successful_query_count: number;
  total_query_count: number;
  failure_messages?: string[];
}

export interface RetrieveContextGraphFrontierOptions {
  enabled: boolean;
  max_depth?: number;
  fanout_cap?: number;
}

export interface RetrieveContextInput extends MemoryScenarioClassifierInput {
  selectors?: RetrievalSelector[];
  limit?: number;
  token_budget?: number;
  include_orientation?: boolean;
  graph_frontier?: RetrieveContextGraphFrontierOptions;
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
  read_plan: RetrieveContextReadPlan;
  orientation: RetrieveContextOrientation;
  candidate_signal_policy: CandidateSignalPolicy;
  candidate_signals: CandidateSignal[];
  create_safety?: RetrieveContextCreateSafety;
  warnings: string[];
  trace?: RetrievalTrace | null;
}

export interface RetrieveContextCreateSafety {
  status: 'exists' | 'unknown' | 'no_canonical_candidate';
  matched_candidate_ids: string[];
  matched_selector_ids: string[];
  reasons: string[];
  write_permission_granted: false;
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
  corpus_lane?: CorpusLaneMetadata;
  token_estimate: number;
  has_more: boolean;
  continuation_selector?: RetrievalSelector;
  evidence_metadata?: CanonicalContextReadEvidenceMetadata;
}

export interface CanonicalContextReadEvidenceMetadata {
  evidence_role: 'answer_ground';
  authority: MemoryArtifactAuthority;
  selector_id: string;
  content_hash?: string;
  source_ref_count: number;
  source_ref_kinds: EvidenceSourceRefKind[];
  freshness: RetrievalFreshness;
  token_estimate: number;
  corpus_lane?: CorpusLaneMetadata;
  window?: {
    line_start?: number;
    line_end?: number;
    char_start?: number;
    char_end?: number;
  };
  continuation_status: 'complete' | 'continued';
}

export interface WritebackGovernanceMetadata {
  route_decision: MemoryWritebackDecision;
  intended_operation: MemoryWritebackIntendedOperation;
  apply_mode: 'no_write' | 'plan_only' | 'candidate_created' | 'deferred_candidate_created' | 'canonical_requirements_returned';
  route_reasons: string[];
  missing_requirements: string[];
  blockers: string[];
  provenance: {
    source_refs_count: number;
    answer_grounding_source_refs_count: number;
    corpus_lane_refs_count: number;
  };
  target_snapshot: {
    input_state: 'omitted' | 'hash' | 'null_absent_assertion';
    expected_content_hash?: string | null;
  };
  sensitivity: MemoryCandidateSensitivity;
  candidate_only_reason?: string;
  control_plane_apply_reason?: string;
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

export type RetrievalSelectorWarningCode =
  | 'stale_selector'
  | 'stale_continuation'
  | 'scope_blocked'
  | 'derived_pending'
  | 'derived_failed';

export interface RetrievalSelectorWarning {
  code: RetrievalSelectorWarningCode;
  severity: 'warning';
  selector_id: string;
  selector: RetrievalSelector;
  slug?: string;
  expected_content_hash?: string;
  current_content_hash?: string | null;
  scope_gate?: ScopeGateDecisionResult;
  message: string;
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
  selector_warnings?: RetrievalSelectorWarning[];
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
