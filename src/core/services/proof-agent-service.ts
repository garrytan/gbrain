import { buildDecisionPacketProjections } from './decision-packet-projection-service.ts';
import { buildMemoryWhy } from './memory-why-service.ts';
import { buildNegativeMemoryProjections } from './negative-memory-projection-service.ts';
import { evaluateTrustContract } from './trust-contract-service.ts';
import type {
  MemoryActivationPolicyDecision,
  NegativeMemoryProjection,
  ProofAgentInput,
  ProofAgentReport,
  ProofAgentScenarioReport,
} from '../types.ts';

export function runProofAgentMemory(input: ProofAgentInput = {}): ProofAgentReport {
  const generatedAt = isoTimestamp(input.now);
  const decisionScenario = proveDecisionReuse();
  const negativeMemory = buildProofNegativeMemory(input.now);
  const negativeScenario = proveFailedAttemptAvoidance(negativeMemory);
  const staleScenario = proveStaleCodeVerifyFirst();
  const candidateScenario = proveCandidateExclusion();
  const memoryWhy = buildMemoryWhy({
    selected_selectors: [
      { selector_id: 'compiled_truth:workspace:default:systems/mbrain-proof', kind: 'compiled_truth' },
    ],
    candidate_signals: [
      {
        candidate_id: 'candidate:proof-excluded',
        activation: 'candidate_only',
        reason_codes: ['memory_candidate'],
      },
    ],
    activation_decisions: [staleActivationDecision()],
    negative_memory: negativeMemory,
    trace_refs: ['retrieval_trace:proof-agent-memory'],
    verbose: input.verbose,
  });
  const memoryWhyScenario = scenario(
    'memory_why_explanation',
    'Memory-why concise explanation',
    memoryWhy.concise_lines.length <= 5 && memoryWhy.authority_violations.length === 0,
    'citation_only',
    'operational_memory',
    ['memory_why_concise', 'authority_violations_absent'],
  );
  const scenarios = [
    decisionScenario,
    negativeScenario,
    staleScenario,
    candidateScenario,
    memoryWhyScenario,
  ];
  const authorityViolations = memoryWhy.authority_violations;
  const mutations = scenarios.flatMap((entry) => entry.mutations);
  const status = scenarios.every((entry) => entry.status === 'pass')
    && authorityViolations.length === 0
    && mutations.length === 0
    ? 'pass'
    : 'fail';

  return {
    status,
    generated_at: generatedAt,
    scenarios,
    memory_why: memoryWhy,
    authority_violations: authorityViolations,
    mutations,
  };
}

function proveDecisionReuse(): ProofAgentScenarioReport {
  const [packet] = buildDecisionPacketProjections({
    task_decisions: [{
      id: 'decision-proof',
      task_id: 'task-proof',
      summary: 'Use authority-first memory boundaries.',
      rationale: 'Canonical evidence must remain the answer boundary.',
      consequences: ['Candidates and graph paths stay non-authoritative.'],
      validity_context: {
        scope_id: 'workspace:default',
        canonical_target: 'systems/mbrain-proof',
        affected_selectors: ['compiled_truth:workspace:default:systems/mbrain-proof'],
        revalidation_path: 'read_canonical',
      },
    }],
    assertions: [{
      id: 'assertion-proof',
      scope_id: 'workspace:default',
      claim_text: 'Use authority-first memory boundaries.',
      authority_state: 'canonical',
      lifecycle_state: 'active',
      target_id: 'systems/mbrain-proof',
      source_refs: ['source-record:proof'],
      valid_until: null,
    }],
    retrieval_traces: [{
      id: 'trace-proof',
      task_id: 'task-proof',
      source_refs: ['retrieval_trace:trace-proof'],
      route: ['retrieve_context', 'compiled_truth'],
    }],
  });
  return scenario(
    'decision_reuse',
    'Decision reuse from canonical packet',
    packet?.activation === 'answer_ground' && packet.authority === 'canonical_compiled_truth',
    packet?.activation ?? 'ignore',
    packet?.authority ?? 'none',
    packet?.source_records.map((record) => record.kind) ?? ['missing_packet'],
  );
}

function buildProofNegativeMemory(now: Date | string | undefined): NegativeMemoryProjection[] {
  return buildNegativeMemoryProjections({
    task_attempts: [{
      id: 'attempt-proof',
      task_id: 'task-proof',
      summary: 'Old install-free test command failed.',
      outcome: 'failed',
      applicability_context: {
        repo: 'mbrain',
        command: 'bun test',
        error_class: 'missing_dependency',
        valid_until: '2026-12-31T00:00:00.000Z',
      },
      evidence: ['missing_dependency'],
    }],
    current_anchors: {
      repo: 'mbrain',
      command: 'bun test',
      error_class: 'missing_dependency',
    },
    now: now ?? '2026-06-06T00:00:00.000Z',
  });
}

function proveFailedAttemptAvoidance(
  negativeMemory: NegativeMemoryProjection[],
): ProofAgentScenarioReport {
  const record = negativeMemory[0];
  return scenario(
    'failed_attempt_avoidance',
    'Failed-attempt avoidance through conditional negative memory',
    record?.activation === 'suppress_if_valid' && record.suppression_applies === true,
    record?.activation ?? 'ignore',
    'operational_memory',
    record?.reason_codes ?? ['missing_negative_memory'],
  );
}

function proveStaleCodeVerifyFirst(): ProofAgentScenarioReport {
  const decision = evaluateTrustContract({
    id: 'code:mbrain-proof',
    artifact_kind: 'current_artifact',
    source_ref: 'code:mbrain-proof',
    stale: true,
  });
  return scenario(
    'stale_code_verify_first',
    'Stale code claim requires verification',
    decision.activation === 'verify_first' && decision.revalidation === 'reverify_code',
    decision.activation,
    decision.authority,
    decision.reason_codes,
  );
}

function proveCandidateExclusion(): ProofAgentScenarioReport {
  const decision = evaluateTrustContract({
    id: 'candidate:proof-excluded',
    artifact_kind: 'memory_candidate',
    source_ref: 'memory-candidate:proof-excluded',
    candidate_status: 'candidate',
    target_object_type: 'curated_note',
    source_refs_count: 1,
  });
  return scenario(
    'candidate_exclusion',
    'Candidate excluded from answer grounding',
    decision.activation === 'candidate_only'
      && decision.activation_label === 'promote_first'
      && decision.authority === 'unreviewed_candidate',
    decision.activation,
    decision.authority,
    decision.reason_codes,
  );
}

function staleActivationDecision(): MemoryActivationPolicyDecision {
  return {
    artifact_id: 'code:mbrain-proof',
    decision: 'verify_first',
    activation_label: 'verify_first',
    authority: 'verified_current_artifact',
    reason_codes: ['stale_artifact'],
    source_ref: 'code:mbrain-proof',
  };
}

function scenario(
  id: string,
  title: string,
  passed: boolean,
  activation: ProofAgentScenarioReport['activation'],
  authority: string,
  reasonCodes: string[],
): ProofAgentScenarioReport {
  return {
    id,
    title,
    status: passed ? 'pass' : 'fail',
    activation,
    authority,
    reason_codes: reasonCodes,
    mutations: [],
    failures: passed ? [] : [`${id}_proof_failed`],
  };
}

function isoTimestamp(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}
