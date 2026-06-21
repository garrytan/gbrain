import type {
  CandidateDebtInput,
  CandidateDebtMetrics,
  InboxLead,
  InboxLeadInput,
  InboxLeadResult,
  MemoryCandidateEntry,
  MemoryActivationLabel,
  ReadCandidateContextInput,
  ReadCandidateContextResult,
} from '../types.ts';
import type { CanonicalTargetProposalEntry } from '../types.ts';
import {
  classifyCandidateResolutionState,
  type CandidateResolutionProposal,
} from './candidate-resolution-state-service.ts';
import {
  buildCandidateGovernanceMetadata,
  candidateWhyNotAnswerGround,
} from './candidate-signal-service.ts';

export function buildInboxLeads(input: InboxLeadInput): InboxLeadResult {
  const handoffIds = new Set(input.canonical_handoff_candidate_ids ?? []);
  const leads: InboxLead[] = [];
  const suppressionReasonCodes: string[] = [];

  for (const candidate of input.candidates) {
    if (candidate.sensitivity === 'secret') {
      suppressionReasonCodes.push('secret_candidate_hidden');
      continue;
    }
    leads.push(buildInboxLead(candidate, handoffIds));
  }

  return {
    leads,
    suppressed_count: input.candidates.length - leads.length,
    suppression_reason_codes: dedupeStrings(suppressionReasonCodes),
    debt_metrics: computeCandidateDebtMetrics(input),
  };
}

export function computeCandidateDebtMetrics(input: CandidateDebtInput): CandidateDebtMetrics {
  const handoffIds = new Set(input.canonical_handoff_candidate_ids ?? []);
  const proposalsByCandidateId = activeProposalByCandidateId(input.canonical_target_proposals ?? []);
  const visibleCandidates = input.candidates.filter((candidate) => candidate.sensitivity !== 'secret');
  const reviewLatencies = visibleCandidates
    .flatMap((candidate) => {
      if (!candidate.reviewed_at) return [];
      const duration = candidate.reviewed_at.getTime() - candidate.created_at.getTime();
      return duration >= 0 ? [duration] : [];
    })
    .sort((left, right) => left - right);

  return {
    visible_candidate_count: visibleCandidates.length,
    missing_provenance_count: visibleCandidates.filter((candidate) =>
      !candidate.source_refs.some((sourceRef) => sourceRef.trim().length > 0)
    ).length,
    stale_promoted_without_handoff_count: visibleCandidates.filter((candidate) =>
      candidate.status === 'promoted' && !handoffIds.has(candidate.id)
    ).length,
    unresolved_exposed_count: visibleCandidates.filter((candidate) => {
      const resolution = classifyCandidateResolutionState({
        candidate,
        has_canonical_handoff: handoffIds.has(candidate.id),
        canonical_target_proposal: proposalsByCandidateId.get(candidate.id) ?? null,
      });
      return resolution.counts_as_unresolved_exposed;
    }).length,
    hard_blocked_by_proposal_count: visibleCandidates.filter((candidate) => {
      const resolution = classifyCandidateResolutionState({
        candidate,
        has_canonical_handoff: handoffIds.has(candidate.id),
        canonical_target_proposal: proposalsByCandidateId.get(candidate.id) ?? null,
      });
      return resolution.counts_as_hard_blocked_by_proposal;
    }).length,
    median_review_latency_ms: median(reviewLatencies),
  };
}

export function readCandidateContext(input: ReadCandidateContextInput): ReadCandidateContextResult {
  const denialReasons = candidateContextDenialReasons(input);
  const base = {
    candidate_id: input.candidate.id,
    activation: 'candidate_only' as const,
    activation_label: candidateActivationLabel(input.candidate),
    authority: 'unreviewed_candidate' as const,
    source_refs: input.candidate.source_refs,
    warnings: ['Candidate context is non-canonical; do not use as answer evidence.'],
    candidate_governance_metadata: denialReasons.length > 0
      ? redactedCandidateGovernanceMetadata(input.candidate)
      : buildCandidateGovernanceMetadata({
        candidate: input.candidate,
        why_not_answer_ground: candidateWhyNotAnswerGround(
          input.candidate,
          'candidate_context_is_non_canonical',
          ['candidate_context_requires_promotion_or_canonical_handoff'],
        ),
      }),
  };
  if (denialReasons.length > 0) {
    return {
      ...base,
      access: 'denied',
      content: null,
      reason_codes: denialReasons,
    };
  }

  return {
    ...base,
    access: 'allowed',
    content: input.candidate.proposed_content,
    reason_codes: ['candidate_context_explicitly_requested'],
  };
}

function redactedCandidateGovernanceMetadata(
  candidate: MemoryCandidateEntry,
): NonNullable<ReadCandidateContextResult['candidate_governance_metadata']> {
  return {
    answer_ground: false,
    why_not_answer_ground: candidateWhyNotAnswerGround(
      candidate,
      'candidate_context_is_non_canonical',
      ['candidate_context_denied'],
    ),
    verification: {
      status: 'unverified',
      method: null,
      source_refs_count: 0,
      verified_at_present: false,
    },
    target_binding: {
      state: 'redacted',
      handoff_present: false,
    },
    pressure: {
      score: 0,
      reasons: [],
      review_priority_hint: 'no_priority',
    },
  };
}

function buildInboxLead(
  candidate: MemoryCandidateEntry,
  handoffIds: Set<string>,
): InboxLead {
  const terminalAudit = candidate.status === 'rejected' || candidate.status === 'superseded';
  const promotedNeedsHandoff = candidate.status === 'promoted' && !handoffIds.has(candidate.id);
  const missingProvenance = !candidate.source_refs.some((sourceRef) => sourceRef.trim().length > 0);
  const pressureReasons = [
    ...(missingProvenance ? ['missing_provenance' as const] : []),
    ...(promotedNeedsHandoff ? ['stale_promoted_without_handoff' as const] : []),
    ...(!isTerminal(candidate) && !handoffIds.has(candidate.id) ? ['unresolved_exposed_candidate' as const] : []),
    ...(candidate.recurrence_score > 0 ? ['high_recurrence' as const] : []),
  ];
  const reviewPriorityHint = promotedNeedsHandoff
    ? 'record_canonical_handoff'
    : missingProvenance
      ? 'reject_missing_provenance'
      : 'advance_to_review';

  return {
    candidate_id: candidate.id,
    status: candidate.status,
    activation: 'candidate_only',
    activation_label: terminalAudit ? 'audit_only' : 'promote_first',
    target_object_type: candidate.target_object_type,
    target_object_id: candidate.target_object_id,
    relation_to_canonical: candidate.target_object_id ? 'same_target' : 'unknown',
    promotion_hint: promotedNeedsHandoff
      ? 'already_promoted_needs_handoff'
      : missingProvenance
        ? 'needs_provenance'
        : 'advance_to_review',
    disposition_hint: terminalAudit ? 'hide_from_default_retrieval' : 'keep_candidate',
    pressure_reasons: pressureReasons,
    review_priority_hint: reviewPriorityHint,
    source_refs_count: candidate.source_refs.filter((sourceRef) => sourceRef.trim().length > 0).length,
    content_visibility: 'gated',
    reason_codes: [
      `status:${candidate.status}`,
      ...(terminalAudit ? ['audit_only'] : ['content_gated']),
      ...pressureReasons,
    ],
    created_at: candidate.created_at.toISOString(),
    updated_at: candidate.updated_at.toISOString(),
    candidate_governance_metadata: buildCandidateGovernanceMetadata({
      candidate,
      why_not_answer_ground: candidateWhyNotAnswerGround(candidate, 'memory_inbox_candidate_is_non_canonical'),
      has_canonical_handoff: handoffIds.has(candidate.id),
      pressure_score: roundScore(Math.min(1, pressureReasons.length * 0.25)),
      pressure_reasons: pressureReasons,
      review_priority_hint: reviewPriorityHint,
    }),
  };
}

function candidateContextDenialReasons(input: ReadCandidateContextInput): string[] {
  const reasons: string[] = [];
  if (!input.purpose) reasons.push('purpose_required');
  if (input.candidate.sensitivity === 'secret') reasons.push('secret_candidate_denied');
  if (
    input.candidate.sensitivity === 'personal'
    && input.requested_scope !== 'personal'
    && input.requested_scope !== 'mixed'
  ) {
    reasons.push('personal_scope_required');
  }
  if (
    (input.candidate.sensitivity === 'personal' || input.candidate.sensitivity === 'unknown')
    && !input.audit_reason?.trim()
  ) {
    reasons.push('audit_reason_required');
  }
  return reasons;
}

function candidateActivationLabel(candidate: MemoryCandidateEntry): MemoryActivationLabel {
  return candidate.status === 'rejected' || candidate.status === 'superseded'
    ? 'audit_only'
    : 'promote_first';
}

function isTerminal(candidate: MemoryCandidateEntry): boolean {
  return candidate.status === 'rejected'
    || candidate.status === 'superseded'
    || candidate.status === 'promoted';
}

function activeProposalByCandidateId(
  proposals: Array<Pick<
    CanonicalTargetProposalEntry,
    'source_candidate_id' | 'linked_candidate_ids' | 'status'
  > & { bound_candidate_ids?: string[]; status_reason?: string | null }>,
): Map<string, CandidateResolutionProposal> {
  const output = new Map<string, CandidateResolutionProposal>();
  for (const proposal of proposals) {
    if (!isActiveProposalStatus(proposal.status)) continue;
    for (const candidateId of proposalCandidateIds(proposal)) {
      if (!output.has(candidateId)) {
        output.set(candidateId, {
          status: proposal.status,
          status_reason: proposal.status_reason ?? null,
        });
      }
    }
  }
  return output;
}

function proposalCandidateIds(
  proposal: Pick<CanonicalTargetProposalEntry, 'source_candidate_id' | 'linked_candidate_ids'> & { bound_candidate_ids?: string[] },
): string[] {
  return [
    proposal.source_candidate_id,
    ...proposal.linked_candidate_ids,
    ...(proposal.bound_candidate_ids ?? []),
  ];
}

function isActiveProposalStatus(status: string): boolean {
  return status === 'proposed'
    || status === 'approved'
    || status === 'patch_staged'
    || status === 'bound'
    || status === 'blocked';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle]!;
  return Math.round((values[middle - 1]! + values[middle]!) / 2);
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}
