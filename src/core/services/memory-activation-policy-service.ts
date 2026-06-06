import type {
  MemoryActivationArtifact,
  MemoryActivationPolicyDecision,
  MemoryActivationPolicyInput,
  MemoryActivationPolicyResult,
  MemoryNextTool,
  MemoryWritebackHint,
} from '../types.ts';
import { evaluateTrustContract } from './trust-contract-service.ts';

export function selectActivationPolicy(
  input: MemoryActivationPolicyInput,
): MemoryActivationPolicyResult {
  const decisions = input.artifacts.map(decideArtifactActivation);
  const verificationRequired = decisions.some((decision) => decision.decision === 'verify_first');

  return {
    decisions,
    next_tool: selectNextTool(decisions),
    writeback_hint: selectWritebackHint(input, decisions),
    stale_warnings: input.artifacts
      .filter((artifact) => artifact.stale === true)
      .map((artifact) => `stale:${artifact.id}`),
    verification_required: verificationRequired,
    source_refs: dedupe(input.artifacts.flatMap((artifact) => (
      artifact.source_ref ? [artifact.source_ref] : []
    ))),
    trace_required: decisions.some((decision) => decision.decision !== 'ignore'),
  };
}

function decideArtifactActivation(
  artifact: MemoryActivationArtifact,
): MemoryActivationPolicyDecision {
  const trustDecision = evaluateTrustContract(artifact);

  return {
    artifact_id: artifact.id,
    decision: trustDecision.activation,
    activation_label: trustDecision.activation_label,
    authority: trustDecision.authority,
    reason_codes: trustDecision.reason_codes,
    source_ref: artifact.source_ref ?? null,
  };
}

function selectNextTool(decisions: MemoryActivationPolicyDecision[]): MemoryNextTool {
  if (decisions.some((decision) => decision.authority === 'scope_denied')) {
    return 'evaluate_scope_gate';
  }
  if (decisions.some((decision) => decision.decision === 'verify_first')) {
    return 'reverify_code_claims';
  }
  if (decisions.some((decision) => decision.decision === 'orientation_only')) {
    return 'get_page';
  }
  if (decisions.some((decision) => decision.decision === 'candidate_only')) {
    return 'rank_memory_candidate_entries';
  }
  return 'answer_now';
}

function selectWritebackHint(
  input: MemoryActivationPolicyInput,
  decisions: MemoryActivationPolicyDecision[],
): MemoryWritebackHint {
  if (
    input.scenario === 'coding_continuation'
    || decisions.some((decision) => decision.decision === 'verify_first')
  ) {
    return 'record_trace';
  }
  if (decisions.some((decision) => decision.decision === 'candidate_only')) {
    return 'defer_for_review';
  }
  return 'none';
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
