import type {
  MemoryActivationDecision,
  MemoryActivationLabel,
  MemoryActivationPolicyDecision,
  RetrievalFreshness,
  RetrievalSelectorKind,
  ScopeGatePolicy,
  ScopeGateScope,
} from './retrieval-routing.ts';
import type { DecisionProjectionRevalidationPath, NegativeMemoryProjection } from './decision-projections.ts';

export interface MemoryWhySelectorRef {
  selector_id: string;
  kind?: RetrievalSelectorKind | string;
  source_refs?: string[];
}

export interface MemoryWhyCandidateRef {
  candidate_id: string;
  activation: MemoryActivationDecision | 'candidate_only';
  reason_codes?: string[];
}

export interface MemoryWhyFreshnessEntry {
  artifact_id: string;
  freshness: RetrievalFreshness | 'not_applicable';
  revalidation: DecisionProjectionRevalidationPath | 'promote_candidate' | 'review_candidate';
  reason_codes: string[];
}

export interface MemoryWhyScopePolicySnapshot {
  policy: ScopeGatePolicy;
  resolved_scope: ScopeGateScope;
  reason?: string | null;
}

export interface MemoryWhyInput {
  considered_selectors?: MemoryWhySelectorRef[];
  selected_selectors?: MemoryWhySelectorRef[];
  omitted_candidate_refs?: string[];
  candidate_signals?: MemoryWhyCandidateRef[];
  activation_decisions?: MemoryActivationPolicyDecision[];
  freshness_snapshot?: MemoryWhyFreshnessEntry[];
  negative_memory?: NegativeMemoryProjection[];
  graph_paths_considered?: string[];
  scope_policy_snapshot?: MemoryWhyScopePolicySnapshot | null;
  trace_refs?: string[];
  verbose?: boolean;
}

export interface MemoryWhyCounts {
  canonical_reads_used: number;
  omitted_candidate_refs: number;
  revalidation_required: number;
  suppressions_applied: number;
}

export interface MemoryWhyVerboseReport {
  considered_selectors: string[];
  selected_selectors: string[];
  omitted_candidate_refs: string[];
  suppression_reason_codes: string[];
  activation_decisions: Array<{
    artifact_id: string;
    decision: MemoryActivationDecision;
    activation_label: MemoryActivationLabel;
    reason_codes: string[];
  }>;
  freshness_snapshot: MemoryWhyFreshnessEntry[];
  graph_paths_considered: string[];
  scope_policy_snapshot: MemoryWhyScopePolicySnapshot | null;
  trace_refs: string[];
}

export interface MemoryWhyReport {
  concise_lines: string[];
  counts: MemoryWhyCounts;
  authority_violations: string[];
  verbose?: MemoryWhyVerboseReport;
}

export interface ProofAgentInput {
  verbose?: boolean;
  now?: Date | string;
}

export type ProofAgentScenarioStatus = 'pass' | 'fail';

export interface ProofAgentScenarioReport {
  id: string;
  title: string;
  status: ProofAgentScenarioStatus;
  activation: MemoryActivationDecision | MemoryActivationLabel;
  authority: string;
  reason_codes: string[];
  mutations: string[];
  failures: string[];
}

export interface ProofAgentReport {
  status: ProofAgentScenarioStatus;
  generated_at: string;
  scenarios: ProofAgentScenarioReport[];
  memory_why: MemoryWhyReport;
  authority_violations: string[];
  mutations: string[];
}
