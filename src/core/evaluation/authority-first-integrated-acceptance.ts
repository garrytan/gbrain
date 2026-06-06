import {
  runGraphFrontierEvaluationFixture,
  type GraphFrontierEvaluationFixture,
  type GraphFrontierEvaluationResult,
} from './graph-frontier-evaluation.ts';
import {
  classifyAutoPromoteLane,
  type AutoPromoteLane,
} from '../auto-promote/candidate-selector.ts';
import {
  defaultAutoPromoteConfig,
  type AutoPromoteConfig,
} from '../auto-promote/config.ts';
import { buildDecisionPacketProjections } from '../services/decision-packet-projection-service.ts';
import { buildEpisodeCapturePreview } from '../services/episode-capture-service.ts';
import { routeMemoryWriteback } from '../services/memory-writeback-router-service.ts';
import { buildNegativeMemoryProjections } from '../services/negative-memory-projection-service.ts';
import { runProofAgentMemory } from '../services/proof-agent-service.ts';
import { evaluateTrustContract } from '../services/trust-contract-service.ts';
import type {
  DecisionPacketProjection,
  DecisionPacketProjectionInput,
  EpisodeCapturePreview,
  EpisodeCapturePreviewInput,
  MemoryCandidateEntry,
  NegativeMemoryProjection,
  NegativeMemoryProjectionInput,
  ProofAgentReport,
  RouteMemoryWritebackInput,
  RouteMemoryWritebackResult,
} from '../types.ts';
import type {
  TrustContractDecision,
  TrustContractInput,
} from '../types/trust-contract.ts';

export const AUTHORITY_FIRST_ZERO_COUNTER_KEYS = [
  'noncanonical_answer_evidence_count',
  'candidate_answer_evidence_count',
  'graph_as_answer_evidence_count',
  'raw_episode_answer_evidence_count',
  'scope_leak_count',
  'secret_leak_count',
  'stale_verify_first_miss_count',
  'canonical_write_without_permission_count',
  'promotion_bypass_count',
  'prompt_injection_auto_write_count',
  'secret_canonicalization_count',
  'dream_canonical_write_attempt_count',
  'dream_self_consumption_count',
  'projection_mutation_count',
  'proof_mutation_count',
  'handoff_only_put_page_count',
  'excluded_candidate_runner_count',
  'graph_frontier_default_on_count',
] as const;

export type AuthorityFirstZeroCounterKey = typeof AUTHORITY_FIRST_ZERO_COUNTER_KEYS[number];

export type AuthorityFirstSurface =
  | 'read_context'
  | 'search_chunk'
  | 'query_chunk'
  | 'retrieve_context_candidate'
  | 'memory_inbox_candidate'
  | 'graph_path'
  | 'raw_episode'
  | 'dream_output'
  | 'profile_memory'
  | 'personal_episode'
  | 'current_artifact';

export interface AuthorityFirstAnswerEvidenceRef {
  ref: string;
  surface: AuthorityFirstSurface;
  authority: string;
  factual_answer_evidence: boolean;
  scope_allowed?: boolean;
  contains_secret?: boolean;
  stale?: boolean;
}

export interface AuthorityFirstRetrievalProbe {
  search_result_refs: string[];
  query_result_refs: string[];
  candidate_signal_refs: string[];
  required_reads: string[];
  answer_evidence_refs: string[];
}

export interface AuthorityFirstTrustCase {
  id: string;
  input: TrustContractInput;
  expected_activation: TrustContractDecision['activation'];
  expected_authority: TrustContractDecision['authority'];
}

export interface AuthorityFirstSecretCheck {
  id: string;
  contains_secret: boolean;
  exposed_to_answer: boolean;
  canonicalized: boolean;
}

export type AuthorityFirstWriteSource =
  | 'agent'
  | 'dream_cycle'
  | 'canonical_handoff'
  | 'prompt_injection';

export type AuthorityFirstWriteOperation =
  | 'put_page'
  | 'create_candidate'
  | 'route_memory_writeback'
  | 'none';

export interface AuthorityFirstWriteAttempt {
  id: string;
  source: AuthorityFirstWriteSource;
  operation: AuthorityFirstWriteOperation;
  router_decision: 'canonical_write_allowed' | 'create_candidate' | 'defer' | 'no_write' | 'not_routed';
  canonical_write_allowed: boolean;
  target_snapshot_hash: string | null;
  expected_content_hash: string | null;
  contains_secret: boolean;
  prompt_injection_risk: boolean;
  route?: 'canonical' | 'candidate' | 'handoff_only' | 'none';
}

export interface AuthorityFirstCandidatePromotion {
  candidate_id: string;
  governed_path: boolean;
  same_run: boolean;
}

export interface AuthorityFirstMemoryCandidateFixture
  extends Omit<MemoryCandidateEntry, 'created_at' | 'updated_at' | 'reviewed_at'> {
  created_at?: string;
  updated_at?: string;
  reviewed_at?: string | null;
  runner_executed?: boolean;
}

export interface AuthorityFirstDreamFixture {
  generated_candidate_ids: string[];
  same_cycle_promoted_candidate_ids: string[];
  canonical_write_attempt_ids: string[];
}

export interface AuthorityFirstProjectionFixture {
  decision_input: DecisionPacketProjectionInput;
  negative_input: NegativeMemoryProjectionInput;
  mutation_attempt_refs: string[];
}

export interface AuthorityFirstWritebackFixture {
  id: string;
  input: RouteMemoryWritebackInput;
  expected_decision: RouteMemoryWritebackResult['decision'];
  expected_intended_operation: RouteMemoryWritebackResult['intended_operation'];
}

export type AuthorityFirstSafetyCounters = Record<AuthorityFirstZeroCounterKey, number>;

export interface AuthorityFirstAnswerEvidenceBySurface {
  read_context_canonical: number;
  retrieve_context_probe: number;
  search_result: number;
  memory_candidate: number;
  graph_path: number;
  raw_episode: number;
  dream_candidate: number;
}

export interface AuthorityFirstSurfaceCounts {
  read_context_answer_evidence_count: number;
  search_hint_count: number;
  query_hint_count: number;
  retrieve_candidate_hint_count: number;
  candidate_hint_count: number;
  graph_planning_count: number;
  raw_episode_provenance_count: number;
  dream_candidate_count: number;
}

export interface AuthorityFirstCandidateLaneResult {
  candidate_id: string;
  lane: AutoPromoteLane;
  reason: string | null;
  runner_executed: boolean;
}

export interface AuthorityFirstIntegratedAcceptanceFixture {
  id: string;
  now: string;
  scope_id: string;
  graph_frontier_default: 'off' | 'on';
  retrieval_probe: AuthorityFirstRetrievalProbe;
  answer_evidence_refs: AuthorityFirstAnswerEvidenceRef[];
  trust_cases: AuthorityFirstTrustCase[];
  secret_checks: AuthorityFirstSecretCheck[];
  write_attempts: AuthorityFirstWriteAttempt[];
  candidate_promotions: AuthorityFirstCandidatePromotion[];
  memory_candidates: AuthorityFirstMemoryCandidateFixture[];
  auto_promote_policy?: Partial<AutoPromoteConfig>;
  episode_capture: EpisodeCapturePreviewInput;
  writeback_inputs: AuthorityFirstWritebackFixture[];
  dream: AuthorityFirstDreamFixture;
  projections: AuthorityFirstProjectionFixture;
  graph_evaluation: GraphFrontierEvaluationFixture;
  expected_proof_scenario_ids: string[];
  expected_zero_counters: AuthorityFirstSafetyCounters;
}

export interface AuthorityFirstIntegratedAcceptanceResult {
  fixture_id: string;
  status: 'passed' | 'failed';
  counters: AuthorityFirstSafetyCounters;
  surface_counts: AuthorityFirstSurfaceCounts;
  retrieval_probe: AuthorityFirstRetrievalProbe & {
    must_read_context: boolean;
    probe_answer_evidence_count: number;
  };
  trust_decisions: TrustContractDecision[];
  candidate_lanes: AuthorityFirstCandidateLaneResult[];
  projections: {
    decision_packets: DecisionPacketProjection[];
    negative_memory: NegativeMemoryProjection[];
  };
  answer_evidence: {
    by_surface: AuthorityFirstAnswerEvidenceBySurface;
  };
  episode_capture: {
    raw_capture_enabled: boolean;
    decisions: EpisodeCapturePreview['decisions'];
    provenance_only_count: number;
  };
  writeback_routes: Array<{
    id: string;
    decision: RouteMemoryWritebackResult['decision'];
    intended_operation: RouteMemoryWritebackResult['intended_operation'];
    applied: boolean;
    reasons: string[];
    missing_requirements: string[];
  }>;
  graph: {
    status: GraphFrontierEvaluationResult['status'];
    aggregate: GraphFrontierEvaluationResult['aggregate'];
  };
  proof: {
    status: ProofAgentReport['status'];
    scenario_ids: string[];
    authority_violations: number;
    mutations: number;
  };
  failures: string[];
}

export interface AuthorityFirstIntegratedAcceptanceDeps {
  proofRunner?: typeof runProofAgentMemory;
}

export function runAuthorityFirstIntegratedAcceptance(
  fixture: AuthorityFirstIntegratedAcceptanceFixture,
  deps: AuthorityFirstIntegratedAcceptanceDeps = {},
): AuthorityFirstIntegratedAcceptanceResult {
  const trustDecisions = fixture.trust_cases.map((entry) => evaluateTrustContract(entry.input));
  const graphResult = runGraphFrontierEvaluationFixture(fixture.graph_evaluation);
  const proof = (deps.proofRunner ?? runProofAgentMemory)({ now: fixture.now });
  const candidateLanes = buildCandidateLaneResults(fixture);
  const episodeCapture = buildEpisodeCapturePreview(fixture.episode_capture);
  const writebackRoutes = fixture.writeback_inputs.map((entry) => ({
    fixture: entry,
    result: routeMemoryWriteback(entry.input),
  }));
  const decisionPackets = buildDecisionPacketProjections(fixture.projections.decision_input);
  const negativeMemory = buildNegativeMemoryProjections({
    ...fixture.projections.negative_input,
    now: fixture.projections.negative_input.now ?? fixture.now,
  });
  const counters = buildSafetyCounters(
    fixture,
    trustDecisions,
    graphResult,
    proof,
    candidateLanes,
    episodeCapture,
  );
  const surfaceCounts = buildSurfaceCounts(fixture);
  const answerEvidence = buildAnswerEvidenceBySurface(fixture);
  const proofScenarioIds = proof.scenarios.map((scenario) => scenario.id);
  const failures = [
    ...counterFailures(counters),
    ...expectedCounterFailures(counters, fixture.expected_zero_counters),
    ...trustExpectationFailures(fixture, trustDecisions),
    ...writebackExpectationFailures(writebackRoutes),
    ...projectionFailures(fixture, decisionPackets, negativeMemory),
    ...proofFailures(fixture, proof, proofScenarioIds),
    ...(graphResult.status === 'passed' ? [] : ['graph_frontier_evaluation_failed']),
  ];

  return {
    fixture_id: fixture.id,
    status: failures.length === 0 ? 'passed' : 'failed',
    counters,
    surface_counts: surfaceCounts,
    retrieval_probe: {
      ...fixture.retrieval_probe,
      must_read_context: fixture.retrieval_probe.required_reads.length > 0,
      probe_answer_evidence_count: fixture.retrieval_probe.answer_evidence_refs.length,
    },
    trust_decisions: trustDecisions,
    candidate_lanes: candidateLanes,
    projections: {
      decision_packets: decisionPackets,
      negative_memory: negativeMemory,
    },
    answer_evidence: {
      by_surface: answerEvidence,
    },
    episode_capture: {
      raw_capture_enabled: episodeCapture.raw_capture_enabled,
      decisions: episodeCapture.decisions,
      provenance_only_count: episodeCapture.decisions.filter((entry) => entry.authority === 'provenance_only').length,
    },
    writeback_routes: writebackRoutes.map((entry) => ({
      id: entry.fixture.id,
      decision: entry.result.decision,
      intended_operation: entry.result.intended_operation,
      applied: entry.result.applied,
      reasons: entry.result.reasons,
      missing_requirements: entry.result.missing_requirements,
    })),
    graph: {
      status: graphResult.status,
      aggregate: graphResult.aggregate,
    },
    proof: {
      status: proof.status,
      scenario_ids: proofScenarioIds,
      authority_violations: proof.authority_violations.length,
      mutations: proof.mutations.length,
    },
    failures,
  };
}

function buildCandidateLaneResults(
  fixture: AuthorityFirstIntegratedAcceptanceFixture,
): AuthorityFirstCandidateLaneResult[] {
  const policy = {
    ...defaultAutoPromoteConfig(),
    ...(fixture.auto_promote_policy ?? {}),
    eligibility: {
      ...defaultAutoPromoteConfig().eligibility,
      ...(fixture.auto_promote_policy?.eligibility ?? {}),
    },
    escalation: {
      ...defaultAutoPromoteConfig().escalation,
      ...(fixture.auto_promote_policy?.escalation ?? {}),
    },
  };

  return fixture.memory_candidates.map((candidate) => {
    const decision = classifyAutoPromoteLane(memoryCandidate(candidate, fixture.now), policy);
    return {
      candidate_id: candidate.id,
      lane: decision.lane,
      reason: decision.reason ?? null,
      runner_executed: candidate.runner_executed === true,
    };
  });
}

function memoryCandidate(
  candidate: AuthorityFirstMemoryCandidateFixture,
  now: string,
): MemoryCandidateEntry {
  return {
    ...candidate,
    reviewed_at: candidate.reviewed_at ? new Date(candidate.reviewed_at) : null,
    created_at: new Date(candidate.created_at ?? now),
    updated_at: new Date(candidate.updated_at ?? now),
  };
}

function buildAnswerEvidenceBySurface(
  fixture: AuthorityFirstIntegratedAcceptanceFixture,
): AuthorityFirstAnswerEvidenceBySurface {
  const answerRefs = fixture.answer_evidence_refs.filter((entry) => entry.factual_answer_evidence);
  return {
    read_context_canonical: answerRefs.filter((entry) =>
      entry.surface === 'read_context' && entry.authority === 'canonical_compiled_truth'
    ).length,
    retrieve_context_probe: fixture.retrieval_probe.answer_evidence_refs.length
      + answerRefs.filter((entry) => entry.surface === 'retrieve_context_candidate').length,
    search_result: answerRefs.filter((entry) =>
      entry.surface === 'search_chunk' || entry.surface === 'query_chunk'
    ).length,
    memory_candidate: answerRefs.filter((entry) => entry.surface === 'memory_inbox_candidate').length,
    graph_path: answerRefs.filter((entry) => entry.surface === 'graph_path').length,
    raw_episode: answerRefs.filter((entry) => entry.surface === 'raw_episode').length,
    dream_candidate: answerRefs.filter((entry) => entry.surface === 'dream_output').length,
  };
}

function buildSafetyCounters(
  fixture: AuthorityFirstIntegratedAcceptanceFixture,
  trustDecisions: TrustContractDecision[],
  graphResult: GraphFrontierEvaluationResult,
  proof: ProofAgentReport,
  candidateLanes: AuthorityFirstCandidateLaneResult[],
  episodeCapture: EpisodeCapturePreview,
): AuthorityFirstSafetyCounters {
  return {
    noncanonical_answer_evidence_count: fixture.retrieval_probe.answer_evidence_refs.length
      + fixture.answer_evidence_refs.filter(isNoncanonicalAnswerEvidence).length,
    candidate_answer_evidence_count: fixture.answer_evidence_refs.filter(isCandidateAnswerEvidence).length,
    graph_as_answer_evidence_count: graphResult.aggregate.graph_as_answer_evidence_count
      + fixture.answer_evidence_refs.filter(isGraphAnswerEvidence).length,
    raw_episode_answer_evidence_count: fixture.answer_evidence_refs.filter(isRawEpisodeAnswerEvidence).length,
    scope_leak_count: graphResult.aggregate.scope_leak_count
      + trustDecisions.filter(isScopeLeakDecision).length
      + fixture.answer_evidence_refs.filter(isScopeLeakEvidence).length,
    secret_leak_count: fixture.secret_checks.filter((entry) => entry.contains_secret && entry.exposed_to_answer).length
      + episodeCapture.decisions.filter((entry) =>
        entry.safety.secret_risk !== 'none' && entry.safety.redacted !== true
      ).length,
    stale_verify_first_miss_count: staleVerifyFirstMisses(fixture, trustDecisions),
    canonical_write_without_permission_count: fixture.write_attempts.filter(isCanonicalWriteWithoutPermission).length,
    promotion_bypass_count: fixture.candidate_promotions.filter((entry) => !entry.governed_path).length,
    prompt_injection_auto_write_count: fixture.write_attempts.filter((entry) =>
      entry.prompt_injection_risk && isCanonicalOperation(entry.operation)
    ).length,
    secret_canonicalization_count: fixture.secret_checks.filter((entry) => entry.contains_secret && entry.canonicalized).length
      + fixture.write_attempts.filter((entry) => entry.contains_secret && isCanonicalOperation(entry.operation)).length,
    dream_canonical_write_attempt_count: fixture.dream.canonical_write_attempt_ids.length
      + fixture.write_attempts.filter((entry) => entry.source === 'dream_cycle' && isCanonicalOperation(entry.operation)).length,
    dream_self_consumption_count: fixture.dream.same_cycle_promoted_candidate_ids.length
      + fixture.candidate_promotions.filter((entry) =>
        entry.same_run && fixture.dream.generated_candidate_ids.includes(entry.candidate_id)
      ).length,
    projection_mutation_count: fixture.projections.mutation_attempt_refs.length,
    proof_mutation_count: proof.mutations.length,
    handoff_only_put_page_count: fixture.write_attempts.filter((entry) =>
      entry.route === 'handoff_only' && entry.operation === 'put_page'
    ).length,
    excluded_candidate_runner_count: candidateLanes.filter((entry) =>
      entry.lane === 'excluded' && entry.runner_executed
    ).length,
    graph_frontier_default_on_count: fixture.graph_frontier_default === 'on' ? 1 : 0,
  };
}

function buildSurfaceCounts(
  fixture: AuthorityFirstIntegratedAcceptanceFixture,
): AuthorityFirstSurfaceCounts {
  return {
    read_context_answer_evidence_count: fixture.answer_evidence_refs.filter((entry) =>
      entry.surface === 'read_context' && entry.factual_answer_evidence
    ).length,
    search_hint_count: fixture.retrieval_probe.search_result_refs.length
      + fixture.answer_evidence_refs.filter((entry) => entry.surface === 'search_chunk').length,
    query_hint_count: fixture.retrieval_probe.query_result_refs.length
      + fixture.answer_evidence_refs.filter((entry) => entry.surface === 'query_chunk').length,
    retrieve_candidate_hint_count: fixture.retrieval_probe.candidate_signal_refs.length
      + fixture.answer_evidence_refs.filter((entry) => entry.surface === 'retrieve_context_candidate').length,
    candidate_hint_count: fixture.answer_evidence_refs.filter((entry) =>
      entry.surface === 'memory_inbox_candidate'
    ).length,
    graph_planning_count: fixture.answer_evidence_refs.filter((entry) => entry.surface === 'graph_path').length,
    raw_episode_provenance_count: fixture.answer_evidence_refs.filter((entry) => entry.surface === 'raw_episode').length,
    dream_candidate_count: fixture.answer_evidence_refs.filter((entry) => entry.surface === 'dream_output').length
      + fixture.dream.generated_candidate_ids.length,
  };
}

function isNoncanonicalAnswerEvidence(entry: AuthorityFirstAnswerEvidenceRef): boolean {
  return entry.factual_answer_evidence && !isAllowedAnswerEvidence(entry);
}

function isCandidateAnswerEvidence(entry: AuthorityFirstAnswerEvidenceRef): boolean {
  return entry.factual_answer_evidence
    && (entry.surface === 'memory_inbox_candidate'
      || entry.surface === 'retrieve_context_candidate'
      || entry.authority === 'unreviewed_candidate');
}

function isGraphAnswerEvidence(entry: AuthorityFirstAnswerEvidenceRef): boolean {
  return entry.factual_answer_evidence && entry.surface === 'graph_path';
}

function isRawEpisodeAnswerEvidence(entry: AuthorityFirstAnswerEvidenceRef): boolean {
  return entry.factual_answer_evidence && entry.surface === 'raw_episode';
}

function isScopeLeakEvidence(entry: AuthorityFirstAnswerEvidenceRef): boolean {
  return entry.factual_answer_evidence && entry.scope_allowed === false;
}

function isScopeLeakDecision(decision: TrustContractDecision): boolean {
  return decision.authority === 'scope_denied' && decision.activation === 'answer_ground';
}

function staleVerifyFirstMisses(
  fixture: AuthorityFirstIntegratedAcceptanceFixture,
  decisions: TrustContractDecision[],
): number {
  const decisionById = new Map(decisions.map((decision) => [decision.artifact_id, decision]));
  return fixture.trust_cases.filter((entry) =>
    entry.input.stale === true && decisionById.get(entry.input.id)?.activation !== 'verify_first'
  ).length
    + fixture.answer_evidence_refs.filter((entry) =>
      entry.factual_answer_evidence && entry.stale === true && entry.surface === 'current_artifact'
    ).length;
}

function isAllowedAnswerEvidence(entry: AuthorityFirstAnswerEvidenceRef): boolean {
  if (!entry.factual_answer_evidence) return true;
  if (entry.surface === 'read_context') {
    return entry.authority === 'canonical_compiled_truth' || entry.authority === 'source_or_timeline_evidence';
  }
  if (entry.surface === 'profile_memory' || entry.surface === 'personal_episode') {
    return entry.scope_allowed === true
      && (entry.authority === 'profile_memory' || entry.authority === 'personal_episode');
  }
  if (entry.surface === 'current_artifact') {
    return entry.stale !== true && entry.authority === 'verified_current_artifact';
  }
  return false;
}

function isCanonicalWriteWithoutPermission(entry: AuthorityFirstWriteAttempt): boolean {
  if (entry.operation !== 'put_page') return false;
  return entry.router_decision !== 'canonical_write_allowed'
    || entry.canonical_write_allowed !== true
    || !entry.target_snapshot_hash
    || !entry.expected_content_hash;
}

function isCanonicalOperation(operation: AuthorityFirstWriteOperation): boolean {
  return operation === 'put_page';
}

function counterFailures(counters: AuthorityFirstSafetyCounters): string[] {
  return AUTHORITY_FIRST_ZERO_COUNTER_KEYS
    .filter((key) => counters[key] !== 0)
    .map((key) => `${key}:${counters[key]}`);
}

function expectedCounterFailures(
  counters: AuthorityFirstSafetyCounters,
  expected: AuthorityFirstSafetyCounters,
): string[] {
  return AUTHORITY_FIRST_ZERO_COUNTER_KEYS
    .filter((key) => expected[key] !== counters[key])
    .map((key) => `expected_${key}:${expected[key]}_actual:${counters[key]}`);
}

function trustExpectationFailures(
  fixture: AuthorityFirstIntegratedAcceptanceFixture,
  decisions: TrustContractDecision[],
): string[] {
  return fixture.trust_cases.flatMap((entry, index) => {
    const decision = decisions[index];
    if (!decision) return [`missing_trust_decision:${entry.id}`];
    const failures: string[] = [];
    if (decision.activation !== entry.expected_activation) {
      failures.push(`trust_activation:${entry.id}:${decision.activation}`);
    }
    if (decision.authority !== entry.expected_authority) {
      failures.push(`trust_authority:${entry.id}:${decision.authority}`);
    }
    if (!decision.policy_version_hash) {
      failures.push(`trust_policy_hash_missing:${entry.id}`);
    }
    if (decision.reason_codes.length === 0) {
      failures.push(`trust_reason_codes_missing:${entry.id}`);
    }
    return failures;
  });
}

function writebackExpectationFailures(
  routes: Array<{ fixture: AuthorityFirstWritebackFixture; result: RouteMemoryWritebackResult }>,
): string[] {
  return routes.flatMap(({ fixture, result }) => {
    const failures: string[] = [];
    if (result.decision !== fixture.expected_decision) {
      failures.push(`writeback_decision:${fixture.id}:${result.decision}`);
    }
    if (result.intended_operation !== fixture.expected_intended_operation) {
      failures.push(`writeback_operation:${fixture.id}:${result.intended_operation}`);
    }
    if (result.applied !== false) {
      failures.push(`writeback_applied:${fixture.id}`);
    }
    return failures;
  });
}

function projectionFailures(
  fixture: AuthorityFirstIntegratedAcceptanceFixture,
  decisionPackets: DecisionPacketProjection[],
  negativeMemory: NegativeMemoryProjection[],
): string[] {
  const failures: string[] = [];
  if (fixture.projections.decision_input.task_decisions?.length && decisionPackets.length === 0) {
    failures.push('decision_packet_projection_missing');
  }
  if (fixture.projections.negative_input.task_attempts?.length && negativeMemory.length === 0) {
    failures.push('negative_memory_projection_missing');
  }
  return failures;
}

function proofFailures(
  fixture: AuthorityFirstIntegratedAcceptanceFixture,
  proof: ProofAgentReport,
  scenarioIds: string[],
): string[] {
  const failures: string[] = [];
  if (proof.status !== 'pass') failures.push(`proof_status:${proof.status}`);
  if (proof.authority_violations.length > 0) failures.push('proof_authority_violations_present');
  if (proof.mutations.length > 0) failures.push('proof_mutations_present');
  if (JSON.stringify(scenarioIds) !== JSON.stringify(fixture.expected_proof_scenario_ids)) {
    failures.push('proof_scenario_ids_mismatch');
  }
  return failures;
}
