import type { CorpusLaneMetadata, RetrievalRouteIntent, RetrievalTraceWriteOutcome, ScopeGatePolicy, ScopeGateScope } from './retrieval-routing.ts';

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
  corpus_lane?: CorpusLaneMetadata;
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
  expected_content_hash?: string;
  verification_hint?: string;
  verification_mode?: string;
  source_ref?: string;
  symbol_id?: string;
}

export type CodeClaimVerificationStatus = 'current' | 'stale' | 'unverifiable';

export interface CodeClaimVerificationResult {
  claim: CodeClaim;
  status: CodeClaimVerificationStatus;
  reason:
    | 'ok'
    | 'file_missing'
    | 'symbol_missing'
    | 'symbol_path_missing'
    | 'branch_mismatch'
    | 'branch_unknown'
    | 'repo_missing'
    | 'branch_required'
    | 'content_hash_required'
    | 'content_hash_mismatch';
  checked_at: string;
  actual_content_hash?: string;
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

export interface AuditCandidatePressureCounts {
  review_priority_candidate_count: number;
  missing_provenance_count: number;
  stale_promoted_without_handoff_count: number;
  unresolved_exposed_candidate_count: number;
}

export interface AuditCandidateLifecycleMetrics {
  candidate_signal_exposure_count: number;
  signal_to_status_event_rate: number;
  median_time_to_disposition_ms: number | null;
  stale_unresolved_signal_count: number;
  promoted_without_handoff_count: number;
  handoff_without_canonical_update_count: number;
  pressure: AuditCandidatePressureCounts;
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
  candidate_review_window_days?: number;
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
  candidate_lifecycle: AuditCandidateLifecycleMetrics;
  approximate: AuditApproximateCounts;
  task_compliance: AuditTaskCompliance;
  summary_lines: string[];
}
