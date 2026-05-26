import type { CanonicalWritePolicyClaim } from './write-policy.ts';
import { projectionOperationFor } from './mutation-planner.ts';

export interface ProjectionTarget {
  kind:
    | 'project_decision_timeline'
    | 'system_compiled_truth'
    | 'user_profile_projection'
    | 'personal_episode_summary'
    | 'task_handoff_projection'
    | 'contradiction_resolution';
  slug: string;
}

export interface ProjectionMutationInput {
  projection_target: ProjectionTarget;
  mutation_kind: string;
  content: string;
  assertion_ids: string[];
  assertion_evidence_ids: string[];
  extracted_claim_ids: string[];
  source_refs: string[];
}

export function projectionTargetForClaim(claim: CanonicalWritePolicyClaim): ProjectionTarget {
  if (claim.property === 'decision.timeline') {
    return {
      kind: 'project_decision_timeline',
      slug: `${claim.target_slug}/decisions`,
    };
  }
  if (claim.property.startsWith('compiled_truth.')) return { kind: 'system_compiled_truth', slug: claim.target_slug };
  if (claim.target_type === 'user' || claim.property.startsWith('profile.') || claim.property.startsWith('preference.')) {
    return { kind: 'user_profile_projection', slug: claim.target_slug };
  }
  if (claim.target_type === 'episode' || claim.property.startsWith('episode_summary.')) {
    return { kind: 'personal_episode_summary', slug: claim.target_slug };
  }
  if (claim.target_type === 'task' || claim.property.startsWith('handoff.') || claim.property.startsWith('resume.')) {
    return { kind: 'task_handoff_projection', slug: claim.target_slug };
  }
  if (claim.claim_type === 'conflict_resolution' || claim.property.startsWith('contradiction_resolution.')) {
    return { kind: 'contradiction_resolution', slug: claim.target_slug };
  }
  return { kind: 'system_compiled_truth', slug: claim.target_slug };
}

export function projectionContentForClaim(claim: CanonicalWritePolicyClaim): string {
  const value = claim.value_json;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.decision === 'string') return record.decision;
    if (typeof record.text === 'string') return record.text;
  }
  return JSON.stringify(claim.value_json);
}

export function buildProjectionMutation(input: {
  claim: CanonicalWritePolicyClaim;
  assertion_ids: string[];
  assertion_evidence_ids: string[];
  extracted_claim_ids: string[];
  source_refs: string[];
}): ProjectionMutationInput {
  return {
    projection_target: projectionTargetForClaim(input.claim),
    mutation_kind: projectionOperationFor(input.claim.property),
    content: projectionContentForClaim(input.claim),
    assertion_ids: input.assertion_ids,
    assertion_evidence_ids: input.assertion_evidence_ids,
    extracted_claim_ids: input.extracted_claim_ids,
    source_refs: input.source_refs,
  };
}
