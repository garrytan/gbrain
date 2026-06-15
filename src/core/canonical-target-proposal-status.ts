import type { CanonicalTargetProposalStatus } from './types.ts';

const ALLOWED_CANONICAL_TARGET_PROPOSAL_STATUS_TRANSITIONS: Record<
  CanonicalTargetProposalStatus,
  readonly CanonicalTargetProposalStatus[]
> = {
  proposed: ['approved', 'rejected', 'blocked', 'superseded'],
  approved: ['bound', 'patch_staged', 'rejected', 'blocked', 'superseded'],
  patch_staged: ['bound', 'blocked', 'superseded'],
  blocked: ['superseded'],
  bound: [],
  rejected: [],
  superseded: [],
};

export function isAllowedCanonicalTargetProposalStatusUpdate(
  currentStatus: CanonicalTargetProposalStatus,
  nextStatus: CanonicalTargetProposalStatus,
): boolean {
  return ALLOWED_CANONICAL_TARGET_PROPOSAL_STATUS_TRANSITIONS[currentStatus].includes(nextStatus);
}
