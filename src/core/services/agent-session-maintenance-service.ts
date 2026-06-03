import type { MemoryCandidateEntry } from '../types.ts';
import {
  buildMemoryCandidateReviewBacklog,
  type MemoryCandidateReviewBacklogGroup,
} from './memory-candidate-dedup-service.ts';

export interface AgentSessionMaintenanceReview {
  groups: MemoryCandidateReviewBacklogGroup[];
  auto_promote_handoff_candidates: string[];
  authority_warning: 'recurrence_increases_review_priority_not_truth';
}

export function buildAgentSessionMaintenanceReview(
  candidates: readonly MemoryCandidateEntry[],
): AgentSessionMaintenanceReview {
  const active = candidates.filter((candidate) =>
    candidate.status === 'candidate' || candidate.status === 'staged_for_review');
  const groups = buildMemoryCandidateReviewBacklog(active);

  return {
    groups,
    auto_promote_handoff_candidates: active
      .filter(isLowRiskAutoPromoteInput)
      .map((candidate) => candidate.id),
    authority_warning: 'recurrence_increases_review_priority_not_truth',
  };
}

function isLowRiskAutoPromoteInput(candidate: MemoryCandidateEntry): boolean {
  return candidate.extraction_kind === 'extracted'
    && candidate.sensitivity !== 'secret'
    && candidate.sensitivity !== 'unknown'
    && candidate.confidence_score >= 0.9
    && candidate.source_refs.filter((ref) => ref.trim().length > 0).length >= 2
    && candidate.status === 'candidate'
    && candidate.target_object_type !== null
    && typeof candidate.target_object_id === 'string'
    && candidate.target_object_id.trim().length > 0;
}
