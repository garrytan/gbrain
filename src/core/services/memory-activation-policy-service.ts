import type {
  MemoryActivationArtifact,
  MemoryActivationPolicyDecision,
  MemoryActivationPolicyInput,
  MemoryActivationPolicyResult,
  MemoryArtifactAuthority,
  MemoryNextTool,
  MemoryWritebackHint,
} from '../types.ts';

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
  if (artifact.artifact_kind === 'profile_memory' || artifact.artifact_kind === 'personal_episode') {
    if (artifact.scope_policy !== 'allow') {
      return buildDecision(artifact, 'ignore', 'scope_denied', [
        artifact.scope_policy ? `scope_policy_${artifact.scope_policy}` : 'missing_scope_policy',
      ]);
    }
  }

  if (artifact.scope_policy === 'deny' || artifact.scope_policy === 'defer') {
    return buildDecision(artifact, 'ignore', 'scope_denied', [
      `scope_policy_${artifact.scope_policy}`,
    ]);
  }

  switch (artifact.artifact_kind) {
  case 'current_artifact':
    return artifact.stale
      ? buildDecision(artifact, 'verify_first', 'verified_current_artifact', ['stale_artifact'])
      : buildDecision(artifact, 'answer_ground', 'verified_current_artifact', ['current_artifact']);
  case 'compiled_truth':
    return artifact.stale
      ? buildDecision(artifact, 'verify_first', 'canonical_compiled_truth', ['stale_compiled_truth'])
      : buildDecision(artifact, 'answer_ground', 'canonical_compiled_truth', ['compiled_truth']);
  case 'timeline':
  case 'source_record':
    return buildDecision(artifact, 'citation_only', 'source_or_timeline_evidence', [
      'source_or_timeline_evidence',
    ]);
  case 'context_map':
    return buildDecision(artifact, 'orientation_only', 'derived_orientation', ['context_map']);
  case 'codemap_pointer':
    return artifact.stale
      ? buildDecision(artifact, 'verify_first', 'derived_orientation', ['stale_artifact'])
      : buildDecision(artifact, 'orientation_only', 'derived_orientation', ['codemap_pointer']);
  case 'task_attempt_failed':
    return artifact.anchors_valid === true
      ? buildDecision(artifact, 'suppress_if_valid', 'operational_memory', ['anchors_valid'])
      : buildDecision(artifact, 'verify_first', 'operational_memory', ['anchors_unverified']);
  case 'task_decision':
    return buildDecision(artifact, 'answer_ground', 'operational_memory', ['task_decision']);
  case 'memory_candidate':
    return buildDecision(artifact, 'candidate_only', 'unreviewed_candidate', ['memory_candidate']);
  case 'profile_memory':
    return buildDecision(artifact, 'answer_ground', 'profile_memory', [
      'scope_allowed_personal_memory',
    ]);
  case 'personal_episode':
    return buildDecision(artifact, 'answer_ground', 'personal_episode', [
      'scope_allowed_personal_memory',
    ]);
  }
}

function buildDecision(
  artifact: MemoryActivationArtifact,
  decision: MemoryActivationPolicyDecision['decision'],
  authority: MemoryArtifactAuthority,
  reason_codes: string[],
): MemoryActivationPolicyDecision {
  return {
    artifact_id: artifact.id,
    decision,
    authority,
    reason_codes,
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
