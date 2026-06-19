import type { SecretRisk } from '../source-registry/raw-ingest.ts';
import type { AgentSessionEventInput, AgentSessionSourceKind } from './agent-session-memory.ts';
import type { CanonicalTargetProposalEntry, MemoryCandidateEntry } from './memory-governance.ts';
import type {
  CandidateSignalDispositionHint,
  CandidateSignalPressureReason,
  CandidateSignalPromotionHint,
  CandidateSignalReviewPriorityHint,
  CandidateSignalRelationToCanonical,
  MemoryActivationDecision,
  MemoryActivationLabel,
} from './retrieval-routing.ts';

export type EpisodeCaptureCategory =
  | 'decision'
  | 'failed_attempt'
  | 'task_resume_state'
  | 'code_claim_revalidation'
  | 'explicit_user_preference'
  | 'source_backed_project_fact'
  | 'other';

export type EpisodeCaptureDecision =
  | 'capture_candidate'
  | 'capture_episode'
  | 'capture_trace_only'
  | 'exclude';

export type EpisodeCaptureAuthority = 'provenance_only';

export interface EpisodeCapturePreviewInput
 {
  source_kind: AgentSessionSourceKind;
  session_id: string;
  client_name?: string;
  source_id?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
  now?: string;
  events: AgentSessionEventInput[];
  allow_broad_raw_capture?: boolean;
}

export interface EpisodeCaptureTargetHint {
  target_object_type: string | null;
  target_object_id: string | null;
}

export interface EpisodeCaptureSafety {
  secret_risk: SecretRisk;
  prompt_injection_flagged: boolean;
  redacted: boolean;
}

export interface EpisodeCapturePreviewDecision {
  event_id: string;
  event_kind: AgentSessionEventInput['event_kind'];
  category: EpisodeCaptureCategory;
  decision: EpisodeCaptureDecision;
  activation_label: MemoryActivationLabel;
  authority: EpisodeCaptureAuthority;
  preview_text: string;
  source_refs: string[];
  safety: EpisodeCaptureSafety;
  target_hint: EpisodeCaptureTargetHint;
  reason_codes: string[];
}

export interface EpisodeCapturePreview {
  raw_capture_enabled: boolean;
  source_refs: string[];
  allowed_count: number;
  excluded_count: number;
  safety: EpisodeCaptureSafety;
  decisions: EpisodeCapturePreviewDecision[];
}

export type InboxLeadContentVisibility = 'content_light' | 'gated' | 'hidden';

export interface InboxLead {
  candidate_id: string;
  status: MemoryCandidateEntry['status'];
  activation: MemoryActivationDecision;
  activation_label: MemoryActivationLabel;
  target_object_type: MemoryCandidateEntry['target_object_type'];
  target_object_id: MemoryCandidateEntry['target_object_id'];
  relation_to_canonical: CandidateSignalRelationToCanonical;
  promotion_hint: CandidateSignalPromotionHint;
  disposition_hint: CandidateSignalDispositionHint;
  pressure_reasons: CandidateSignalPressureReason[];
  review_priority_hint: CandidateSignalReviewPriorityHint;
  source_refs_count: number;
  content_visibility: InboxLeadContentVisibility;
  reason_codes: string[];
  created_at: string;
  updated_at: string;
}

export interface InboxLeadInput {
  candidates: MemoryCandidateEntry[];
  canonical_handoff_candidate_ids?: string[];
  now?: Date | string;
  include_audit?: boolean;
}

export interface InboxLeadResult {
  leads: InboxLead[];
  suppressed_count: number;
  suppression_reason_codes: string[];
  debt_metrics: CandidateDebtMetrics;
}

export interface CandidateDebtInput {
  candidates: MemoryCandidateEntry[];
  canonical_handoff_candidate_ids?: string[];
  canonical_target_proposals?: CanonicalTargetProposalEntry[];
  now?: Date | string;
}

export interface CandidateDebtMetrics {
  visible_candidate_count: number;
  missing_provenance_count: number;
  stale_promoted_without_handoff_count: number;
  unresolved_exposed_count: number;
  hard_blocked_by_proposal_count: number;
  median_review_latency_ms: number | null;
}

export type ReadCandidateContextAccess = 'allowed' | 'denied';
export type ReadCandidateContextPurpose = 'review' | 'promotion' | 'audit' | 'debug';

export interface ReadCandidateContextInput {
  candidate: MemoryCandidateEntry;
  purpose?: ReadCandidateContextPurpose;
  requested_scope?: 'work' | 'personal' | 'mixed';
  audit_reason?: string | null;
}

export interface ReadCandidateContextResult {
  candidate_id: string;
  access: ReadCandidateContextAccess;
  activation: MemoryActivationDecision;
  activation_label: MemoryActivationLabel;
  authority: 'unreviewed_candidate';
  content: string | null;
  source_refs: string[];
  warnings: string[];
  reason_codes: string[];
}
