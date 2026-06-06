import { createHash } from 'node:crypto';
import type {
  MemoryActivationLabel,
  MemoryArtifactAuthority,
} from '../types.ts';
import type {
  TrustContractDecision,
  TrustContractInput,
  TrustFreshnessLabel,
  TrustRevalidationInstruction,
} from '../types/trust-contract.ts';

export const TRUST_CONTRACT_POLICY_VERSION = 'trust-contract:v1';

export function evaluateTrustContract(input: TrustContractInput): TrustContractDecision {
  const decision = evaluateActivation(input);

  return {
    artifact_id: input.id,
    ...decision,
    policy_version: TRUST_CONTRACT_POLICY_VERSION,
    policy_version_hash: hashPolicyDecision(input, decision),
    source_ref: input.source_ref ?? null,
  };
}

function evaluateActivation(
  input: TrustContractInput,
): Omit<TrustContractDecision, 'artifact_id' | 'policy_version' | 'policy_version_hash' | 'source_ref'> {
  if (input.artifact_kind === 'profile_memory' || input.artifact_kind === 'personal_episode') {
    if (input.scope_policy !== 'allow') {
      return decision(input, 'ignore', 'ignore', 'scope_denied', [
        input.scope_policy ? `scope_policy_${input.scope_policy}` : 'missing_scope_policy',
      ], 'unknown', 'evaluate_scope_gate');
    }
  }

  if (input.scope_policy === 'deny' || input.scope_policy === 'defer') {
    return decision(input, 'ignore', 'ignore', 'scope_denied', [
      `scope_policy_${input.scope_policy}`,
    ], 'unknown', 'evaluate_scope_gate');
  }

  switch (input.artifact_kind) {
  case 'current_artifact':
    return input.stale
      ? decision(input, 'verify_first', 'verify_first', 'verified_current_artifact', ['stale_artifact'], 'stale', 'reverify_code')
      : decision(input, 'answer_ground', 'answer_ground', 'verified_current_artifact', ['current_artifact'], 'current', 'none');
  case 'compiled_truth':
    return input.stale
      ? decision(input, 'verify_first', 'verify_first', 'canonical_compiled_truth', ['stale_compiled_truth'], 'stale', 'read_canonical')
      : decision(input, 'answer_ground', 'answer_ground', 'canonical_compiled_truth', ['compiled_truth'], 'current', 'none');
  case 'timeline':
  case 'source_record':
    return decision(input, 'citation_only', 'citation_only', 'source_or_timeline_evidence', [
      'source_or_timeline_evidence',
    ], 'not_applicable', 'read_canonical');
  case 'context_map':
  case 'graph_path':
    return decision(input, 'orientation_only', 'orientation_only', 'derived_orientation', [
      input.artifact_kind,
    ], 'not_applicable', 'read_canonical');
  case 'codemap_pointer':
    return input.stale
      ? decision(input, 'verify_first', 'verify_first', 'derived_orientation', ['stale_artifact'], 'stale', 'reverify_code')
      : decision(input, 'orientation_only', 'orientation_only', 'derived_orientation', ['codemap_pointer'], 'current', 'read_canonical');
  case 'task_attempt_failed':
    return input.anchors_valid === true
      ? decision(input, 'suppress_if_valid', 'suppress_if_valid', 'operational_memory', ['anchors_valid'], 'not_applicable', 'none')
      : decision(input, 'verify_first', 'verify_first', 'operational_memory', ['anchors_unverified'], 'unknown', 'review_candidate');
  case 'task_decision':
    return decision(input, 'answer_ground', 'answer_ground', 'operational_memory', ['task_decision'], 'current', 'none');
  case 'memory_candidate':
    return decision(
      input,
      'candidate_only',
      candidateActivationLabel(input),
      'unreviewed_candidate',
      ['memory_candidate'],
      'not_applicable',
      candidateRevalidation(input),
    );
  case 'profile_memory':
    return decision(input, 'answer_ground', 'answer_ground', 'profile_memory', [
      'scope_allowed_personal_memory',
    ], 'current', 'none');
  case 'personal_episode':
    return decision(input, 'answer_ground', 'answer_ground', 'personal_episode', [
      'scope_allowed_personal_memory',
    ], 'current', 'none');
  case 'assertion_surface':
    return assertionDecision(input);
  }
}

function assertionDecision(
  input: TrustContractInput,
): Omit<TrustContractDecision, 'artifact_id' | 'policy_version' | 'policy_version_hash' | 'source_ref'> {
  const assertion = input.assertion ?? {};
  const lifecycle = assertion.lifecycle;
  const freshness = assertionFreshness(input);

  if (assertion.scope_matches !== true) {
    return decision(input, 'ignore', 'ignore', 'scope_denied', [
      assertion.scope_matches === false ? 'scope_mismatch' : 'missing_scope_match',
    ], freshness, 'evaluate_scope_gate');
  }
  if (assertion.authority !== 'canonical') {
    return decision(input, 'candidate_only', 'audit_only', 'unreviewed_candidate', [
      'assertion_not_canonical',
    ], freshness, 'review_candidate');
  }
  if (lifecycle !== 'active') {
    return decision(input, 'verify_first', 'verify_first', 'canonical_compiled_truth', [
      lifecycle ? `assertion_${lifecycle}` : 'missing_assertion_lifecycle',
    ], freshness, assertion.code_claim ? 'reverify_code' : 'read_canonical');
  }
  if (freshness === 'stale') {
    return decision(input, 'verify_first', 'verify_first', 'canonical_compiled_truth', [
      'canonical_stale',
    ], freshness, assertion.code_claim ? 'reverify_code' : 'read_canonical');
  }
  return decision(input, 'answer_ground', 'answer_ground', 'canonical_compiled_truth', [
    'canonical_active',
  ], 'current', 'none');
}

function decision(
  input: TrustContractInput,
  activation: TrustContractDecision['activation'],
  activationLabel: MemoryActivationLabel,
  authority: MemoryArtifactAuthority,
  reasonCodes: string[],
  freshness: TrustFreshnessLabel,
  revalidation: TrustRevalidationInstruction,
): Omit<TrustContractDecision, 'artifact_id' | 'policy_version' | 'policy_version_hash' | 'source_ref'> {
  return {
    activation,
    activation_label: activationLabel,
    authority,
    freshness,
    revalidation,
    reason_codes: reasonCodes,
  };
}

function candidateActivationLabel(input: TrustContractInput): MemoryActivationLabel {
  if (input.candidate_status === 'rejected' || input.candidate_status === 'superseded') {
    return 'audit_only';
  }
  if (
    input.target_object_type === 'curated_note'
    && (input.source_refs_count ?? 0) > 0
  ) {
    return 'promote_first';
  }
  return 'hint_only';
}

function candidateRevalidation(input: TrustContractInput): TrustRevalidationInstruction {
  if (input.candidate_status === 'rejected' || input.candidate_status === 'superseded') {
    return 'review_candidate';
  }
  if (
    input.target_object_type === 'curated_note'
    && (input.source_refs_count ?? 0) > 0
  ) {
    return 'promote_candidate';
  }
  return 'review_candidate';
}

function assertionFreshness(input: TrustContractInput): TrustFreshnessLabel {
  if (input.stale === true || input.assertion?.lifecycle === 'stale') return 'stale';
  if (input.assertion?.lifecycle === undefined) return 'unknown';
  if (input.assertion.lifecycle === 'active') return 'current';
  return 'not_applicable';
}

function hashPolicyDecision(
  input: TrustContractInput,
  decision: Omit<TrustContractDecision, 'artifact_id' | 'policy_version' | 'policy_version_hash' | 'source_ref'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      policy_version: TRUST_CONTRACT_POLICY_VERSION,
      artifact_kind: input.artifact_kind,
      stale: input.stale ?? null,
      anchors_valid: input.anchors_valid ?? null,
      scope_policy: input.scope_policy ?? null,
      candidate_status: input.candidate_status ?? null,
      target_object_type: input.target_object_type ?? null,
      source_refs_count: input.source_refs_count ?? null,
      assertion: input.assertion ?? null,
      activation: decision.activation,
      authority: decision.authority,
      freshness: decision.freshness,
      revalidation: decision.revalidation,
      reason_codes: decision.reason_codes,
    }))
    .digest('hex');
}
