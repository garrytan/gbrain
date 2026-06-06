import type {
  MemoryActivationLabel,
  MemoryArtifactAuthority,
} from './retrieval-routing.ts';
import type {
  CanonicalHandoffTargetObjectType,
  MemoryCandidateStatus,
} from './memory-governance.ts';

export type ProjectionActivation = MemoryActivationLabel;
export type ProjectionAnchors = Record<string, unknown>;

export type DecisionProjectionRevalidationPath =
  | 'none'
  | 'read_canonical'
  | 'reverify_code'
  | 'review_candidate'
  | 'evaluate_scope_gate';

export type DecisionProjectionReversibility =
  | 'reversible'
  | 'hard_to_reverse'
  | 'irreversible'
  | 'unknown';

export interface DecisionProjectionTaskDecision {
  id: string;
  task_id: string;
  summary: string;
  rationale: string;
  consequences: string[];
  validity_context: ProjectionAnchors;
  created_at?: Date | string;
}

export interface DecisionProjectionTaskAttempt {
  id: string;
  task_id: string;
  summary: string;
  outcome: 'failed' | 'partial' | 'succeeded' | 'abandoned';
  applicability_context: ProjectionAnchors;
  evidence: string[];
  created_at?: Date | string;
}

export interface DecisionProjectionRetrievalTrace {
  id: string;
  task_id: string | null;
  source_refs: string[];
  route: string[];
}

export interface DecisionProjectionAssertionRecord {
  id: string;
  scope_id: string;
  claim_text: string;
  authority_state: 'unresolved' | 'candidate' | 'canonical' | 'conflicted' | 'rejected';
  lifecycle_state: 'active' | 'stale' | 'expired' | 'archived' | 'purged';
  target_id: string | null;
  source_refs: string[];
  valid_until: string | null;
}

export interface DecisionProjectionCanonicalHandoff {
  id: string;
  scope_id: string;
  candidate_id: string;
  target_object_type: CanonicalHandoffTargetObjectType;
  target_object_id: string;
  source_refs: string[];
  review_reason: string | null;
}

export interface DecisionProjectionMemoryCandidate {
  id: string;
  proposed_content: string;
  status: MemoryCandidateStatus;
  target_object_type: string | null;
  target_object_id: string | null;
  source_refs: string[];
  review_reason: string | null;
}

export interface DecisionProjectionSourceRecord {
  kind:
    | 'task_decision'
    | 'task_attempt'
    | 'retrieval_trace'
    | 'assertion'
    | 'canonical_handoff'
    | 'memory_candidate';
  id: string;
  authority: MemoryArtifactAuthority;
  source_refs: string[];
  lifecycle_state?: string | null;
}

export interface DecisionRejectedAlternative {
  source_ref: string;
  summary: string;
  reason: string;
}

export interface DecisionPacketProjection {
  id: string;
  decision: string;
  claim: string;
  rationale: string;
  rejected_alternatives: DecisionRejectedAlternative[];
  owner_or_source: string;
  source_refs: string[];
  canonical_target: string | null;
  target_snapshot_hash: string | null;
  valid_until: string | null;
  revalidation_path: DecisionProjectionRevalidationPath;
  reversibility: DecisionProjectionReversibility;
  affected_selectors: string[];
  activation: ProjectionActivation;
  authority: MemoryArtifactAuthority;
  source_records: DecisionProjectionSourceRecord[];
}

export interface DecisionPacketProjectionInput {
  task_decisions?: DecisionProjectionTaskDecision[];
  task_attempts?: DecisionProjectionTaskAttempt[];
  retrieval_traces?: DecisionProjectionRetrievalTrace[];
  assertions?: DecisionProjectionAssertionRecord[];
  canonical_handoffs?: DecisionProjectionCanonicalHandoff[];
  memory_candidates?: DecisionProjectionMemoryCandidate[];
}

export interface NegativeMemoryProjectionInput {
  task_attempts?: DecisionProjectionTaskAttempt[];
  memory_candidates?: DecisionProjectionMemoryCandidate[];
  current_anchors?: ProjectionAnchors;
  now?: Date | string;
}

export interface NegativeMemoryProjection {
  id: string;
  failed_under: ProjectionAnchors;
  why_failed: string;
  do_not_repeat_if: ProjectionAnchors;
  reopen_if: ProjectionAnchors;
  valid_until: string | null;
  source_refs: string[];
  owner_or_task: string;
  activation: ProjectionActivation;
  suppression_applies: boolean;
  reason_codes: string[];
}
