import type {
  CanonicalTargetProposalEntry,
  CanonicalTargetProposalStatus,
  MemoryCandidateEntry,
  MemoryCandidateStatus,
} from '../types.ts';

export type CandidateResolutionState =
  | 'terminal'
  | 'promoted_with_handoff'
  | 'promoted_without_handoff'
  | 'proposal_pending'
  | 'binding_pending'
  | 'proposal_bound'
  | 'hard_blocked_by_proposal'
  | 'actionable_unresolved';

export type CandidateResolutionPressureReason =
  | 'missing_provenance'
  | 'stale_promoted_without_handoff'
  | 'unresolved_exposed_candidate'
  | 'canonical_target_proposal_pending'
  | 'canonical_target_binding_pending'
  | 'canonical_target_proposal_bound'
  | 'canonical_target_proposal_hard_blocked'
  | 'canonical_target_proposal_blocked';

export interface CandidateResolutionCandidate {
  status: MemoryCandidateStatus | string;
  source_refs?: string[] | null;
}

export interface CandidateResolutionProposal {
  status: CanonicalTargetProposalStatus | string;
  status_reason: string | null;
}

export interface CandidateResolutionStateInput {
  candidate: Pick<MemoryCandidateEntry, 'status' | 'source_refs'> | CandidateResolutionCandidate;
  has_canonical_handoff: boolean;
  canonical_target_proposal?: Pick<CanonicalTargetProposalEntry, 'status' | 'status_reason'> | CandidateResolutionProposal | null;
}

export interface CandidateResolutionStateResult {
  state: CandidateResolutionState;
  counts_as_unresolved_exposed: boolean;
  counts_as_promoted_without_handoff: boolean;
  counts_as_hard_blocked_by_proposal: boolean;
  pressure_reasons: CandidateResolutionPressureReason[];
}

const TERMINAL_CANDIDATE_STATUSES = new Set<string>(['rejected', 'superseded']);
const HARD_BLOCKED_PROPOSAL_REASONS = new Set<string>(['unstable_subject_identity']);

export function classifyCandidateResolutionState(
  input: CandidateResolutionStateInput,
): CandidateResolutionStateResult {
  const pressureReasons: CandidateResolutionPressureReason[] = [];
  if (!hasSourceRefs(input.candidate.source_refs)) {
    pressureReasons.push('missing_provenance');
  }

  if (TERMINAL_CANDIDATE_STATUSES.has(input.candidate.status)) {
    return result('terminal', false, false, false, pressureReasons);
  }

  if (input.has_canonical_handoff) {
    return result('promoted_with_handoff', false, false, false, pressureReasons);
  }

  if (input.candidate.status === 'promoted') {
    pressureReasons.push('stale_promoted_without_handoff');
    return result('promoted_without_handoff', false, true, false, pressureReasons);
  }

  const proposal = input.canonical_target_proposal ?? null;
  if (proposal) {
    return classifyProposalState(proposal, pressureReasons);
  }

  pressureReasons.push('unresolved_exposed_candidate');
  return result('actionable_unresolved', true, false, false, pressureReasons);
}

export function isHardBlockedCanonicalTargetProposal(
  proposal: Pick<CanonicalTargetProposalEntry, 'status' | 'status_reason'> | CandidateResolutionProposal | null | undefined,
): boolean {
  return proposal?.status === 'blocked'
    && typeof proposal.status_reason === 'string'
    && HARD_BLOCKED_PROPOSAL_REASONS.has(proposal.status_reason);
}

function classifyProposalState(
  proposal: Pick<CanonicalTargetProposalEntry, 'status' | 'status_reason'> | CandidateResolutionProposal,
  pressureReasons: CandidateResolutionPressureReason[],
): CandidateResolutionStateResult {
  switch (proposal.status) {
    case 'proposed':
      pressureReasons.push('canonical_target_proposal_pending');
      return result('proposal_pending', false, false, false, pressureReasons);
    case 'approved':
    case 'patch_staged':
      pressureReasons.push('canonical_target_binding_pending');
      return result('binding_pending', false, false, false, pressureReasons);
    case 'bound':
      pressureReasons.push('canonical_target_proposal_bound');
      return result('proposal_bound', false, false, false, pressureReasons);
    case 'blocked':
      if (isHardBlockedCanonicalTargetProposal(proposal)) {
        pressureReasons.push('canonical_target_proposal_hard_blocked');
        return result('hard_blocked_by_proposal', false, false, true, pressureReasons);
      }
      pressureReasons.push('canonical_target_proposal_blocked', 'unresolved_exposed_candidate');
      return result('actionable_unresolved', true, false, false, pressureReasons);
    case 'rejected':
    case 'superseded':
    default:
      pressureReasons.push('unresolved_exposed_candidate');
      return result('actionable_unresolved', true, false, false, pressureReasons);
  }
}

function hasSourceRefs(sourceRefs: string[] | null | undefined): boolean {
  return Array.isArray(sourceRefs)
    && sourceRefs.some((sourceRef) => typeof sourceRef === 'string' && sourceRef.trim().length > 0);
}

function result(
  state: CandidateResolutionState,
  countsAsUnresolvedExposed: boolean,
  countsAsPromotedWithoutHandoff: boolean,
  countsAsHardBlockedByProposal: boolean,
  pressureReasons: CandidateResolutionPressureReason[],
): CandidateResolutionStateResult {
  return {
    state,
    counts_as_unresolved_exposed: countsAsUnresolvedExposed,
    counts_as_promoted_without_handoff: countsAsPromotedWithoutHandoff,
    counts_as_hard_blocked_by_proposal: countsAsHardBlockedByProposal,
    pressure_reasons: dedupe(pressureReasons),
  };
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}
