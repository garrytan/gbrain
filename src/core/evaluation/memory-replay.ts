import {
  REQUIRED_MEMORY_REPLAY_CASE_TYPES,
  REQUIRED_MEMORY_REPLAY_STAGES,
  type MemoryReplayCaseType,
  type MemoryReplayEvalCase,
  type MemoryReplayFixture,
  type MemoryReplayProjection,
  type MemoryReplayRunnerTranscript,
  type MemoryReplayStage,
} from './memory-eval-cases.ts';

export {
  REQUIRED_MEMORY_REPLAY_CASE_TYPES,
  REQUIRED_MEMORY_REPLAY_STAGES,
} from './memory-eval-cases.ts';
export type {
  MemoryReplayCaseType,
  MemoryReplayEvalCase,
  MemoryReplayFixture,
  MemoryReplayStage,
  MemoryReplayStageName,
} from './memory-eval-cases.ts';

export interface MemoryReplayCaseResult {
  id: string;
  type: MemoryReplayCaseType;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

export interface MemoryReplayStageResult {
  stage: string;
  id: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export interface MemoryReplayCoverage {
  required_stages: readonly string[];
  present_stages: string[];
  missing_stages: string[];
  required_case_types: readonly string[];
  present_case_types: string[];
  missing_case_types: string[];
}

export interface MemoryReplayMetrics {
  total_cases: number;
  passed_cases: number;
  policy_decision_accuracy: number;
  extraction_precision: number;
  extraction_recall: number;
  prompt_injection_quarantine_success: number;
  secret_redaction_success: number;
  runner_denied_tool_success: number;
  retrieval_semantic_coverage_success: number;
  conflict_detection_accuracy: number;
  duplicate_supersession_accuracy: number;
  job_failure_retry_success: number;
  time_to_disposition_success: number;
  inappropriate_canonical_write_count: number;
  missing_canonical_write_count: number;
  missing_canonical_write_trace_count: number;
  expired_retrieval_leakage: number;
  stale_retrieval_leakage: number;
  projection_drift_count: number;
}

export interface MemoryReplayResult {
  fixture_id: string;
  status: 'passed' | 'failed';
  coverage: MemoryReplayCoverage;
  stage_results: MemoryReplayStageResult[];
  case_results: MemoryReplayCaseResult[];
  metrics: MemoryReplayMetrics;
}

export const MEMORY_REPLAY_SERVICE_FLOW = [
  'source_registration',
  'raw_ingest',
  'extraction',
  'assertion_resolution',
  'policy',
  'candidate_route',
  'conflict_route',
  'canonical_write',
  'projection',
  'dream',
  'forgetting',
  'retrieval',
] as const;

export type MemoryReplayServiceStage = typeof MEMORY_REPLAY_SERVICE_FLOW[number];

export interface MemoryReplayServiceStep {
  stage: MemoryReplayServiceStage;
  status: 'ok' | 'failed' | 'missing_service';
  detail?: string;
}

export interface MemoryReplayServiceContext {
  fixture: MemoryReplayFixture;
  deterministic_result: MemoryReplayResult;
  previous_steps: MemoryReplayServiceStep[];
}

export type MemoryReplayServiceHook = (
  context: MemoryReplayServiceContext,
) => Promise<Partial<MemoryReplayServiceStep> | void> | Partial<MemoryReplayServiceStep> | void;

export type MemoryReplayServiceHooks = Partial<Record<MemoryReplayServiceStage, MemoryReplayServiceHook>>;

export interface MemoryReplayServiceResult {
  fixture_id: string;
  status: 'passed' | 'failed';
  trace_order: MemoryReplayServiceStage[];
  steps: MemoryReplayServiceStep[];
  deterministic_result: MemoryReplayResult;
}

export function runMemoryReplayFixture(fixture: MemoryReplayFixture): MemoryReplayResult {
  const presentStages = [...new Set((fixture.stages ?? []).map((stage) => stage.stage))];
  const missingStages = REQUIRED_MEMORY_REPLAY_STAGES.filter((stage) => !presentStages.includes(stage));
  const presentCaseTypes = [...new Set((fixture.eval_cases ?? []).map((testCase) => testCase.type))];
  const missingCaseTypes = REQUIRED_MEMORY_REPLAY_CASE_TYPES.filter((type) => !presentCaseTypes.includes(type));
  const replayState = buildReplayState(fixture);
  const stageResults = (fixture.stages ?? []).map((stage) => evaluateStage(stage, replayState));
  const caseResults = (fixture.eval_cases ?? []).map((testCase) => evaluateCase(testCase, replayState));
  const metrics = buildReplayMetrics(fixture, caseResults);
  const metricViolation = hasReplayMetricViolation(metrics);
  return {
    fixture_id: fixture.id,
    status: missingStages.length === 0
      && missingCaseTypes.length === 0
      && stageResults.every((result) => result.passed)
      && caseResults.every((result) => result.passed)
      && !metricViolation
      ? 'passed'
      : 'failed',
    coverage: {
      required_stages: REQUIRED_MEMORY_REPLAY_STAGES,
      present_stages: presentStages,
      missing_stages: missingStages,
      required_case_types: REQUIRED_MEMORY_REPLAY_CASE_TYPES,
      present_case_types: presentCaseTypes,
      missing_case_types: missingCaseTypes,
    },
    stage_results: stageResults,
    case_results: caseResults,
    metrics,
  };
}

export async function runMemoryReplayFixtureWithServices(
  fixture: MemoryReplayFixture,
  services: MemoryReplayServiceHooks,
): Promise<MemoryReplayServiceResult> {
  const deterministicResult = runMemoryReplayFixture(fixture);
  const steps: MemoryReplayServiceStep[] = [];
  for (const stage of MEMORY_REPLAY_SERVICE_FLOW) {
    const hook = services[stage];
    if (!hook) {
      steps.push({ stage, status: 'missing_service' });
      continue;
    }
    try {
      const result = await hook({
        fixture,
        deterministic_result: deterministicResult,
        previous_steps: [...steps],
      });
      steps.push(normalizeServiceStep(stage, result));
    } catch (error) {
      steps.push({
        stage,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    fixture_id: fixture.id,
    status: deterministicResult.status === 'passed' && steps.every((step) => step.status === 'ok')
      ? 'passed'
      : 'failed',
    trace_order: [...MEMORY_REPLAY_SERVICE_FLOW],
    steps,
    deterministic_result: deterministicResult,
  };
}

function normalizeServiceStep(
  stage: MemoryReplayServiceStage,
  step: Partial<MemoryReplayServiceStep> | void,
): MemoryReplayServiceStep {
  return {
    stage,
    status: step?.status ?? 'ok',
    detail: step?.detail,
  };
}

interface ReplayState {
  stagesByKey: Map<string, string>;
  assertionsById: Map<string, ReplayAssertionState>;
  canonicalAssertionIds: Set<string>;
  chunksById: Map<string, string>;
  projectionsById: Map<string, MemoryReplayProjection>;
  runnerTranscriptsById: Map<string, MemoryReplayRunnerTranscript>;
  eventResultsByKey: Map<string, string>;
}

interface ReplayAssertionState {
  confidence: number;
  lifecycle_state?: string;
  conflict?: boolean;
  resolved: boolean;
}

interface RetrievalDecision {
  visible: boolean;
  lifecycle_state?: string;
  activation?: 'answer_ground' | 'verify_first' | 'audit' | 'conflict';
}

function buildReplayState(fixture: MemoryReplayFixture): ReplayState {
  const sources = new Map((fixture.sources ?? []).map((source) => [source.id, source]));
  const sourceItems = new Map((fixture.source_items ?? []).map((item) => [item.id, item]));
  const chunks = new Map((fixture.source_chunks ?? []).map((chunk) => [chunk.id, chunk]));
  const claims = new Map((fixture.claims ?? []).map((claim) => [claim.id, claim]));
  const assertions = new Map((fixture.assertions ?? []).map((assertion) => [assertion.id, assertion]));
  const eventResultsByKey = new Map(
    (fixture.mutation_events ?? []).map((event) => [stageKey(event.stage, event.target_id), event.result] as const),
  );
  const runnerJobs = new Map((fixture.runner_jobs ?? []).map((job) => [job.id, job]));
  const runnerTranscriptsById = new Map(
    (fixture.runner_transcripts ?? []).map((transcript) => [transcript.id, transcript]),
  );
  const canonicalAssertionIds = new Set<string>();
  const stagesByKey = new Map<string, string>();
  const assertionsById: ReplayState['assertionsById'] = new Map();
  const chunksById = new Map<string, string>();
  const projectionsById = new Map<string, MemoryReplayProjection>();

  for (const source of fixture.sources ?? []) {
    if (source.registered) stagesByKey.set(stageKey('source_registration', source.id), 'registered');
  }

  for (const item of fixture.source_items ?? []) {
    const itemChunks = (fixture.source_chunks ?? []).filter((chunk) => chunk.source_item_id === item.id);
    if (sources.has(item.source_id) && itemChunks.length > 0) {
      stagesByKey.set(stageKey('raw_ingest', item.id), 'chunked');
    }
  }

  for (const chunk of fixture.source_chunks ?? []) {
    if (sourceItems.has(chunk.source_item_id)) chunksById.set(chunk.id, chunk.chunk_text);
  }

  for (const claim of fixture.claims ?? []) {
    if (chunks.has(claim.chunk_id)) stagesByKey.set(stageKey('extraction', claim.id), 'extracted');
  }

  for (const assertion of fixture.assertions ?? []) {
    const resolved = claims.has(assertion.claim_id);
    assertionsById.set(assertion.id, {
      confidence: assertion.confidence,
      lifecycle_state: assertion.lifecycle_state,
      conflict: assertion.conflict,
      resolved,
    });
    if (resolved) stagesByKey.set(stageKey('assertion_resolution', assertion.id), 'resolved');
  }

  for (const write of fixture.canonical_writes ?? []) {
    const assertion = assertionsById.get(write.assertion_id);
    const canonicalWriteResult = eventBackedStage(eventResultsByKey, 'canonical_write', write.id, 'applied');
    if (isCanonicalWriteRecordAllowed(assertion)) {
      stagesByKey.set(stageKey('canonical_write', write.id), canonicalWriteResult);
      if (canonicalWriteResult === 'applied') canonicalAssertionIds.add(write.assertion_id);
    }
  }

  for (const route of fixture.candidate_routes ?? []) {
    if (policyDecision(assertionsById.get(route.assertion_id)) === 'candidate') {
      stagesByKey.set(stageKey('candidate_route', route.id), eventBackedStage(eventResultsByKey, 'candidate_route', route.id, route.status));
    }
  }

  for (const route of fixture.conflict_routes ?? []) {
    if (policyDecision(assertionsById.get(route.assertion_id)) === 'conflict') {
      stagesByKey.set(stageKey('conflict_route', route.id), eventBackedStage(eventResultsByKey, 'conflict_route', route.id, route.status));
    }
  }

  for (const projection of fixture.projections ?? []) {
    if ((fixture.canonical_writes ?? []).some((write) => write.id === projection.write_id)) {
      projectionsById.set(projection.id, projection);
      if (projection.drift_status) {
        stagesByKey.set(
          stageKey('reconciler_drift', projection.id),
          eventBackedStage(eventResultsByKey, 'reconciler_drift', projection.id, projection.drift_status),
        );
      }
    }
  }

  for (const phase of fixture.dream_phases ?? []) {
    const job = runnerJobs.get(phase.id);
    if (phase.proposal_only && job?.proposal_only) {
      stagesByKey.set(stageKey('runner_proposal', phase.id), job.status);
    }
  }

  for (const record of fixture.forgetting ?? []) {
    if (assertions.has(record.assertion_id)) {
      stagesByKey.set(
        stageKey('lifecycle_transition', record.id),
        eventBackedStage(eventResultsByKey, 'lifecycle_transition', record.id, record.transition),
      );
    }
  }

  for (const sync of fixture.connector_syncs ?? []) {
    if (sources.has(sync.source_id)) stagesByKey.set(stageKey('connector_sync', sync.id), sync.status);
  }

  for (const plan of fixture.purge_plans ?? []) {
    if (chunks.has(plan.target_id) || assertions.has(plan.target_id)) {
      stagesByKey.set(stageKey('purge_restore', plan.id), eventBackedStage(eventResultsByKey, 'purge_restore', plan.id, plan.status));
    }
  }

  return {
    stagesByKey,
    assertionsById,
    canonicalAssertionIds,
    chunksById,
    projectionsById,
    runnerTranscriptsById,
    eventResultsByKey,
  };
}

function eventBackedStage(
  eventResultsByKey: Map<string, string>,
  stage: string,
  id: string,
  computed: string,
): string {
  const eventResult = eventResultsByKey.get(stageKey(stage, id));
  if (!eventResult) return 'missing_event';
  return eventResult === computed ? computed : eventResult;
}

function evaluateStage(stage: MemoryReplayStage, replayState: ReplayState): MemoryReplayStageResult {
  const actual = replayState.stagesByKey.get(stageKey(stage.stage, stage.id)) ?? 'missing_record';
  return {
    stage: stage.stage,
    id: stage.id,
    expected: stage.expected,
    actual,
    passed: stage.expected === actual,
  };
}

function evaluateCase(testCase: MemoryReplayEvalCase, replayState: ReplayState): MemoryReplayCaseResult {
  switch (testCase.type) {
    case 'policy_decision':
      return compare(testCase, testCase.expected.decision, policyDecision(replayState.assertionsById.get(String(testCase.input.assertion_id))));
    case 'retrieval_visibility': {
      const actual = retrievalDecision(testCase.input, replayState);
      if (expectsRetrievalDecisionObject(testCase.expected)) {
        return compare(testCase, expectedRetrievalDecision(testCase.expected), actual);
      }
      return compare(testCase, testCase.expected.visible, actual.visible);
    }
    case 'prompt_injection':
      return compare(testCase, testCase.expected.risk, classifyPromptInjection(resolveChunkText(testCase, replayState)));
    case 'secret_redaction': {
      const chunkText = resolveChunkText(testCase, replayState);
      const redactedText = redactSecrets(chunkText);
      const actual = {
        secret_risk: redactedText === chunkText ? 'none' : 'redacted',
        redacted_text: redactedText,
        ...runnerTranscriptOutput(testCase, replayState),
      };
      return compare(testCase, testCase.expected, actual);
    }
    case 'runner_tool_call':
      return compare(testCase, testCase.expected.decision, decideRunnerToolCall(testCase.input));
    case 'projection_round_trip':
      return compare(testCase, testCase.expected.stable, isProjectionRoundTripStable(testCase.input, replayState));
    case 'live_eval_budget':
      if (expectsLiveEvalDecisionObject(testCase.expected)) {
        return compare(testCase, expectedLiveEvalDecision(testCase.expected), liveEvalDecision(testCase.input));
      }
      return compare(testCase, testCase.expected.allowed, liveEvalDecision(testCase.input).allowed);
  }
}

function compare(testCase: MemoryReplayEvalCase, expected: unknown, actual: unknown): MemoryReplayCaseResult {
  return {
    id: testCase.id,
    type: testCase.type,
    expected,
    actual,
    passed: deepEqual(expected, actual),
  };
}

function buildReplayMetrics(
  fixture: MemoryReplayFixture,
  caseResults: MemoryReplayCaseResult[],
): MemoryReplayMetrics {
  const policyCases = caseResults.filter((result) => result.type === 'policy_decision');
  const promptInjectionCases = caseResults.filter((result) => result.type === 'prompt_injection');
  const promptInjectionQuarantineCases = promptInjectionCases.filter((result) => result.expected === 'quarantined');
  const secretCases = caseResults.filter((result) => result.type === 'secret_redaction');
  const secretRedactionCases = secretCases.filter((result) => expectedObjectField(result.expected, 'secret_risk') === 'redacted');
  const runnerToolCases = caseResults.filter((result) => result.type === 'runner_tool_call');
  const runnerDeniedToolCases = runnerToolCases.filter((result) => result.expected === 'denied');
  const retrievalCases = caseResults.filter((result) => result.type === 'retrieval_visibility');

  return {
    total_cases: caseResults.length,
    passed_cases: caseResults.filter((result) => result.passed).length,
    policy_decision_accuracy: ratioPassed(policyCases),
    extraction_precision: extractionPrecision(fixture),
    extraction_recall: extractionRecall(fixture),
    prompt_injection_quarantine_success: ratioPassed(promptInjectionQuarantineCases),
    secret_redaction_success: ratioPassed(secretRedactionCases),
    runner_denied_tool_success: ratioPassed(runnerDeniedToolCases),
    retrieval_semantic_coverage_success: retrievalSemanticCoverageSuccess(fixture, retrievalCases),
    conflict_detection_accuracy: conflictDetectionAccuracy(fixture),
    duplicate_supersession_accuracy: duplicateSupersessionAccuracy(fixture),
    job_failure_retry_success: jobFailureRetrySuccess(fixture),
    time_to_disposition_success: timeToDispositionSuccess(fixture),
    inappropriate_canonical_write_count: countInappropriateCanonicalWrites(fixture),
    missing_canonical_write_count: countMissingCanonicalWrites(fixture),
    missing_canonical_write_trace_count: countMissingCanonicalWriteTrace(fixture),
    expired_retrieval_leakage: countExpiredRetrievalLeakage(fixture, retrievalCases),
    stale_retrieval_leakage: countStaleRetrievalLeakage(fixture, retrievalCases),
    projection_drift_count: (fixture.stages ?? []).filter((stage) => stage.stage === 'reconciler_drift').length,
  };
}

function hasReplayMetricViolation(metrics: MemoryReplayMetrics): boolean {
  return metrics.policy_decision_accuracy < 1
    || metrics.prompt_injection_quarantine_success < 1
    || metrics.secret_redaction_success < 1
    || metrics.runner_denied_tool_success < 1
    || metrics.retrieval_semantic_coverage_success < 1
    || metrics.inappropriate_canonical_write_count > 0
    || metrics.missing_canonical_write_count > 0
    || metrics.missing_canonical_write_trace_count > 0
    || metrics.extraction_precision < 1
    || metrics.extraction_recall < 1
    || metrics.conflict_detection_accuracy < 1
    || metrics.duplicate_supersession_accuracy < 1
    || metrics.job_failure_retry_success < 1
    || metrics.time_to_disposition_success < 1
    || metrics.expired_retrieval_leakage > 0
    || metrics.stale_retrieval_leakage > 0;
}

function extractionPrecision(fixture: MemoryReplayFixture): number {
  const expectedClaims = expectedExtractionKeys(fixture);
  const actualClaims = actualExtractionKeys(fixture);
  if (actualClaims.size === 0) return expectedClaims.size === 0 ? 1 : 0;
  let truePositiveCount = 0;
  for (const claimId of actualClaims) {
    if (expectedClaims.has(claimId)) truePositiveCount += 1;
  }
  return truePositiveCount / actualClaims.size;
}

function extractionRecall(fixture: MemoryReplayFixture): number {
  const expectedClaims = expectedExtractionKeys(fixture);
  const actualClaims = actualExtractionKeys(fixture);
  if (expectedClaims.size === 0) return actualClaims.size === 0 ? 1 : 0;
  let truePositiveCount = 0;
  for (const claimId of expectedClaims) {
    if (actualClaims.has(claimId)) truePositiveCount += 1;
  }
  return truePositiveCount / expectedClaims.size;
}

function expectedExtractionKeys(fixture: MemoryReplayFixture): Set<string> {
  return new Set((fixture.expected_extractions ?? []).map((extraction) =>
    extractionKey(extraction.claim_id, extraction.chunk_id)
  ));
}

function actualExtractionKeys(fixture: MemoryReplayFixture): Set<string> {
  return new Set((fixture.claims ?? []).map((claim) => extractionKey(claim.id, claim.chunk_id)));
}

function extractionKey(claimId: string, chunkId: string): string {
  return `${claimId}\0${chunkId}`;
}

function conflictDetectionAccuracy(fixture: MemoryReplayFixture): number {
  const claimIds = new Set((fixture.claims ?? []).map((claim) => claim.id));
  const conflictAssertions = (fixture.assertions ?? []).filter((assertion) =>
    assertion.conflict === true && claimIds.has(assertion.claim_id)
  );
  const assertionsById = new Map((fixture.assertions ?? []).map((assertion) => [assertion.id, assertion]));
  const falsePositiveRoutes = (fixture.conflict_routes ?? []).filter((route) =>
    assertionsById.get(route.assertion_id)?.conflict !== true
  ).length;
  if (conflictAssertions.length === 0) return falsePositiveRoutes === 0 ? 1 : 0;
  const routedAssertionIds = new Set((fixture.conflict_routes ?? []).map((route) => route.assertion_id));
  const truePositiveRoutes = conflictAssertions.filter((assertion) => routedAssertionIds.has(assertion.id)).length;
  return truePositiveRoutes / (conflictAssertions.length + falsePositiveRoutes);
}

function timeToDispositionSuccess(fixture: MemoryReplayFixture): number {
  const expectedDispositions = fixture.expected_dispositions ?? [];
  const requiredAssertionIds = requiredDispositionAssertionIds(fixture);
  if (requiredAssertionIds.size === 0) return 0;
  const assertionIds = new Set((fixture.assertions ?? []).map((assertion) => assertion.id));
  const dispositionsByAssertionId = new Map<string, typeof expectedDispositions>();
  for (const disposition of expectedDispositions) {
    const dispositions = dispositionsByAssertionId.get(disposition.assertion_id) ?? [];
    dispositions.push(disposition);
    dispositionsByAssertionId.set(disposition.assertion_id, dispositions);
  }
  const falsePositiveDispositions = expectedDispositions.filter((disposition) =>
    !requiredAssertionIds.has(disposition.assertion_id)
  ).length;
  let successfulDispositions = 0;
  for (const assertionId of requiredAssertionIds) {
    if (!assertionIds.has(assertionId)) continue;
    const dispositions = dispositionsByAssertionId.get(assertionId);
    if (!dispositions || dispositions.length === 0) continue;
    if (dispositions.every(isDispositionWithinSla)) successfulDispositions += 1;
  }
  return successfulDispositions / (requiredAssertionIds.size + falsePositiveDispositions);
}

function requiredDispositionAssertionIds(fixture: MemoryReplayFixture): Set<string> {
  const assertionIds = new Set((fixture.expected_disposition_assertion_ids ?? []));
  for (const write of fixture.canonical_writes ?? []) {
    assertionIds.add(write.assertion_id);
  }
  return assertionIds;
}

function isDispositionWithinSla(disposition: { resolved_at: string; disposed_at?: string; max_seconds: number }): boolean {
  if (typeof disposition.disposed_at !== 'string') return false;
  const resolvedAt = Date.parse(disposition.resolved_at);
  const disposedAt = Date.parse(disposition.disposed_at);
  if (!Number.isFinite(resolvedAt) || !Number.isFinite(disposedAt)) return false;
  const elapsedSeconds = (disposedAt - resolvedAt) / 1000;
  return elapsedSeconds >= 0 && elapsedSeconds <= disposition.max_seconds;
}

function jobFailureRetrySuccess(fixture: MemoryReplayFixture): number {
  const runnerJobsById = new Map((fixture.runner_jobs ?? []).map((job) => [job.id, job]));
  const expectedRetries = fixture.expected_job_retries ?? [];
  if (expectedRetries.length === 0) return 0;
  const retryReadyCount = expectedRetries.filter((expectedRetry) => {
    const failedJob = runnerJobsById.get(expectedRetry.failed_job_id);
    const retryJob = runnerJobsById.get(expectedRetry.retry_job_id);
    return failedJob?.status === 'failed'
      && failedJob.retry_job_id === expectedRetry.retry_job_id
      && isRetryReadyStatus(retryJob?.status);
  }).length;
  return retryReadyCount / expectedRetries.length;
}

function isRetryReadyStatus(status: string | undefined): boolean {
  return status === 'queued' || status === 'running' || status === 'succeeded';
}

function duplicateSupersessionAccuracy(fixture: MemoryReplayFixture): number {
  const assertionsById = new Map((fixture.assertions ?? []).map((assertion) => [assertion.id, assertion]));
  const claimsById = new Map((fixture.claims ?? []).map((claim) => [claim.id, claim]));
  const canonicalAssertionIds = new Set((fixture.canonical_writes ?? []).map((write) => write.assertion_id));
  const duplicateGroups = new Map<string, NonNullable<MemoryReplayFixture['assertions']>>();
  for (const assertion of fixture.assertions ?? []) {
    const duplicateKey = claimsById.get(assertion.claim_id)?.duplicate_key;
    if (!duplicateKey) continue;
    const assertions = duplicateGroups.get(duplicateKey) ?? [];
    assertions.push(assertion);
    duplicateGroups.set(duplicateKey, assertions);
  }
  const supersessions = fixture.supersessions ?? [];
  const expectedSupersededByKey = new Map<string, Set<string>>();
  for (const [duplicateKey, assertions] of duplicateGroups.entries()) {
    const canonicalActiveAssertions = assertions.filter((assertion) =>
      canonicalAssertionIds.has(assertion.id)
      && isCanonicallyWritableLifecycle(assertion.lifecycle_state)
      && assertion.conflict !== true
      && assertion.confidence >= 0.8
    );
    if (assertions.length > 1 && canonicalActiveAssertions.length > 0) {
      expectedSupersededByKey.set(
        duplicateKey,
        new Set(assertions
          .filter((assertion) => assertion.id !== canonicalActiveAssertions[canonicalActiveAssertions.length - 1].id)
          .map((assertion) => assertion.id)),
      );
    }
  }
  const expectedSupersededCount = [...expectedSupersededByKey.values()]
    .reduce((total, assertionIds) => total + assertionIds.size, 0);
  if (expectedSupersededCount === 0) return supersessions.length === 0 ? 1 : 0;
  const correctlySupersededAssertionIds = new Set<string>();
  let falsePositiveSupersessions = 0;
  for (const supersession of supersessions) {
    const superseded = assertionsById.get(supersession.superseded_assertion_id);
    const superseding = assertionsById.get(supersession.superseding_assertion_id);
    const supersededDuplicateKey = superseded ? claimsById.get(superseded.claim_id)?.duplicate_key : undefined;
    const supersedingDuplicateKey = superseding ? claimsById.get(superseding.claim_id)?.duplicate_key : undefined;
    const duplicateKey = supersession.duplicate_key ?? supersededDuplicateKey;
    const correct = duplicateKey != null
      && expectedSupersededByKey.get(duplicateKey)?.has(supersession.superseded_assertion_id) === true
      && supersededDuplicateKey === duplicateKey
      && supersedingDuplicateKey === duplicateKey
      && superseded?.lifecycle_state === 'expired'
      && isCanonicallyWritableLifecycle(superseding?.lifecycle_state)
      && (superseding?.confidence ?? 0) >= 0.8
      && superseding?.conflict !== true;
    if (correct) {
      correctlySupersededAssertionIds.add(supersession.superseded_assertion_id);
    } else {
      falsePositiveSupersessions += 1;
    }
  }
  return correctlySupersededAssertionIds.size / (expectedSupersededCount + falsePositiveSupersessions);
}

function countInappropriateCanonicalWrites(fixture: MemoryReplayFixture): number {
  const claimIds = new Set((fixture.claims ?? []).map((claim) => claim.id));
  const assertionsById = new Map<string, ReplayAssertionState>();
  for (const assertion of fixture.assertions ?? []) {
    assertionsById.set(assertion.id, {
      confidence: assertion.confidence,
      lifecycle_state: assertion.lifecycle_state,
      conflict: assertion.conflict,
      resolved: claimIds.has(assertion.claim_id),
    });
  }
  return (fixture.canonical_writes ?? []).filter((write) =>
    !isCanonicalWriteRecordAllowed(assertionsById.get(write.assertion_id))
  ).length;
}

function countMissingCanonicalWriteTrace(fixture: MemoryReplayFixture): number {
  const eventResultsByKey = new Map(
    (fixture.mutation_events ?? []).map((event) => [stageKey(event.stage, event.target_id), event.result] as const),
  );
  return (fixture.canonical_writes ?? []).filter((write) =>
    eventResultsByKey.get(stageKey('canonical_write', write.id)) !== 'applied'
  ).length;
}

function countExpiredRetrievalLeakage(
  fixture: MemoryReplayFixture,
  retrievalCases: MemoryReplayCaseResult[],
): number {
  return retrievalCases.filter((result) =>
    expectedRetrievalLifecycleState(fixture, result) === 'expired'
    && visibleValue(result.expected) === false
    && visibleValue(result.actual) === true
  ).length;
}

function countStaleRetrievalLeakage(
  fixture: MemoryReplayFixture,
  retrievalCases: MemoryReplayCaseResult[],
): number {
  return retrievalCases.filter((result) =>
    expectedRetrievalLifecycleState(fixture, result) === 'stale'
    && visibleValue(result.actual) === true
    && activationValue(result.expected) === 'verify_first'
    && activationValue(result.actual) !== 'verify_first'
  ).length;
}

function retrievalSemanticCoverageSuccess(
  fixture: MemoryReplayFixture,
  retrievalCases: MemoryReplayCaseResult[],
): number {
  const evalCasesById = new Map((fixture.eval_cases ?? []).map((testCase) => [testCase.id, testCase]));
  const hasExpiredDefaultHiddenCase = retrievalCases.some((result) => {
    const testCase = evalCasesById.get(result.id);
    return result.passed
      && testCase?.input.mode === 'default'
      && typeof testCase.input.assertion_id === 'string'
      && expectedRetrievalLifecycleState(fixture, result) === 'expired'
      && visibleValue(result.expected) === false
      && visibleValue(result.actual) === false;
  });
  const hasStaleDefaultVerifyFirstCase = retrievalCases.some((result) => {
    const testCase = evalCasesById.get(result.id);
    return result.passed
      && testCase?.input.mode === 'default'
      && typeof testCase.input.assertion_id === 'string'
      && expectedRetrievalLifecycleState(fixture, result) === 'stale'
      && visibleValue(result.expected) === true
      && visibleValue(result.actual) === true
      && activationValue(result.expected) === 'verify_first'
      && activationValue(result.actual) === 'verify_first';
  });
  return hasExpiredDefaultHiddenCase && hasStaleDefaultVerifyFirstCase ? 1 : 0;
}

function expectedRetrievalLifecycleState(
  fixture: MemoryReplayFixture,
  result: MemoryReplayCaseResult,
): string | undefined {
  const evalCasesById = new Map((fixture.eval_cases ?? []).map((testCase) => [testCase.id, testCase]));
  const assertionsById = new Map((fixture.assertions ?? []).map((assertion) => [assertion.id, assertion]));
  const testCase = evalCasesById.get(result.id);
  if (typeof testCase?.expected.lifecycle_state === 'string') return testCase.expected.lifecycle_state;
  if (typeof testCase?.input.lifecycle_state === 'string') return testCase.input.lifecycle_state;
  const assertionId = typeof testCase?.input.assertion_id === 'string'
    ? testCase.input.assertion_id
    : undefined;
  return assertionId ? assertionsById.get(assertionId)?.lifecycle_state : undefined;
}

function visibleValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (isRecord(value) && typeof value.visible === 'boolean') return value.visible;
  return undefined;
}

function activationValue(value: unknown): unknown {
  return isRecord(value) ? value.activation : undefined;
}

function expectedObjectField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}

function countMissingCanonicalWrites(fixture: MemoryReplayFixture): number {
  const claimIds = new Set((fixture.claims ?? []).map((claim) => claim.id));
  const canonicalAssertionIds = new Set((fixture.canonical_writes ?? []).map((write) => write.assertion_id));
  return (fixture.assertions ?? []).filter((assertion) =>
    claimIds.has(assertion.claim_id)
    && assertion.confidence >= 0.8
    && !assertion.conflict
    && isCanonicallyWritableLifecycle(assertion.lifecycle_state)
    && !canonicalAssertionIds.has(assertion.id)
  ).length;
}

function isCanonicallyWritableLifecycle(lifecycleState: string | undefined): boolean {
  return lifecycleState == null || lifecycleState === 'active';
}

function isCanonicalWriteRecordAllowed(assertion: ReplayAssertionState | undefined): boolean {
  return policyDecision(assertion) === 'canonical_write'
    && isCanonicalWriteRecordLifecycle(assertion?.lifecycle_state);
}

function isCanonicalWriteRecordLifecycle(lifecycleState: string | undefined): boolean {
  return lifecycleState == null || lifecycleState === 'active' || lifecycleState === 'stale';
}

function ratioPassed(results: MemoryReplayCaseResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((result) => result.passed).length / results.length;
}

function policyDecision(assertion: ReplayAssertionState | undefined): string {
  if (!assertion?.resolved) return 'missing_record';
  if (assertion.conflict) return 'conflict';
  return assertion.confidence >= 0.8 ? 'canonical_write' : 'candidate';
}

function resolveChunkText(testCase: MemoryReplayEvalCase, replayState: ReplayState): string {
  if (typeof testCase.input.chunk_id === 'string') return replayState.chunksById.get(testCase.input.chunk_id) ?? '';
  return String(testCase.input.chunk_text ?? '');
}

function expectsRetrievalDecisionObject(expected: Record<string, unknown>): boolean {
  return typeof expected.lifecycle_state === 'string' || typeof expected.activation === 'string';
}

function expectedRetrievalDecision(expected: Record<string, unknown>): RetrievalDecision {
  const decision: RetrievalDecision = { visible: expected.visible === true };
  if (typeof expected.lifecycle_state === 'string') decision.lifecycle_state = expected.lifecycle_state;
  if (
    expected.activation === 'answer_ground'
    || expected.activation === 'verify_first'
    || expected.activation === 'audit'
    || expected.activation === 'conflict'
  ) {
    decision.activation = expected.activation;
  }
  return decision;
}

function retrievalDecision(input: Record<string, unknown>, replayState: ReplayState): RetrievalDecision {
  const assertionId = typeof input.assertion_id === 'string' ? input.assertion_id : undefined;
  const assertion = assertionId ? replayState.assertionsById.get(assertionId) : undefined;
  const lifecycleState = assertionId
    ? assertion?.lifecycle_state
    : input.lifecycle_state;
  const normalizedLifecycleState = typeof lifecycleState === 'string' ? lifecycleState : undefined;
  const mode = input.mode;
  if (mode === 'audit') {
    return { visible: true, lifecycle_state: normalizedLifecycleState, activation: 'audit' };
  }
  if (
    normalizedLifecycleState === 'expired'
    || normalizedLifecycleState === 'archived'
    || normalizedLifecycleState === 'purged'
  ) {
    return { visible: false, lifecycle_state: normalizedLifecycleState };
  }
  if (assertionId == null || assertion == null) {
    return { visible: false, lifecycle_state: normalizedLifecycleState };
  }
  const assertionPolicy = policyDecision(assertion);
  if (assertionPolicy === 'conflict') {
    return { visible: true, lifecycle_state: normalizedLifecycleState, activation: 'conflict' };
  }
  if (assertionPolicy !== 'canonical_write' || !replayState.canonicalAssertionIds.has(assertionId)) {
    return { visible: false, lifecycle_state: normalizedLifecycleState };
  }
  if (normalizedLifecycleState === 'stale') {
    return { visible: true, lifecycle_state: normalizedLifecycleState, activation: 'verify_first' };
  }
  return { visible: true, lifecycle_state: normalizedLifecycleState, activation: 'answer_ground' };
}

function classifyPromptInjection(value: unknown): 'none' | 'quarantined' {
  const text = String(value ?? '').toLowerCase();
  return text.includes('ignore previous instructions') || text.includes('reveal every private key')
    ? 'quarantined'
    : 'none';
}

function decideRunnerToolCall(input: Record<string, unknown>): 'allowed' | 'denied' {
  const allowedTools = Array.isArray(input.allowed_tools) ? input.allowed_tools : [];
  return allowedTools.includes(input.requested_tool) ? 'allowed' : 'denied';
}

function isProjectionRoundTripStable(input: Record<string, unknown>, replayState: ReplayState): boolean {
  const projectionId = typeof input.projection_id === 'string' ? input.projection_id : undefined;
  const projection = projectionId ? replayState.projectionsById.get(projectionId) : undefined;
  const renderedMarkdown = projection?.rendered_markdown ?? input.rendered_markdown;
  const expectedRenderedMarkdown = projection?.expected_rendered_markdown ?? input.expected_rendered_markdown;
  const renderedStable = typeof renderedMarkdown === 'string'
    && renderedMarkdown.length > 0
    && typeof expectedRenderedMarkdown === 'string'
    && renderedMarkdown === expectedRenderedMarkdown;
  const structuredProjection = projection?.structured_projection ?? input.structured_projection;
  const expectedStructuredProjection = projection?.expected_structured_projection ?? input.expected_structured_projection;
  if (expectedStructuredProjection !== undefined) {
    return renderedStable && deepEqual(structuredProjection, expectedStructuredProjection);
  }
  return renderedStable;
}

interface LiveEvalDecision {
  allowed: boolean;
  reason?: 'not_live' | 'missing_budget' | 'estimated_over_budget' | 'within_budget';
}

function expectsLiveEvalDecisionObject(expected: Record<string, unknown>): boolean {
  return typeof expected.reason === 'string';
}

function expectedLiveEvalDecision(expected: Record<string, unknown>): LiveEvalDecision {
  const decision: LiveEvalDecision = { allowed: expected.allowed === true };
  if (
    expected.reason === 'not_live'
    || expected.reason === 'missing_budget'
    || expected.reason === 'estimated_over_budget'
    || expected.reason === 'within_budget'
  ) {
    decision.reason = expected.reason;
  }
  return decision;
}

function liveEvalDecision(input: Record<string, unknown>): LiveEvalDecision {
  if (input.mode !== 'live') return { allowed: true, reason: 'not_live' };
  if (typeof input.budget_usd !== 'number' || input.budget_usd <= 0) {
    return { allowed: false, reason: 'missing_budget' };
  }
  if (typeof input.estimated_cost_usd === 'number' && input.estimated_cost_usd > input.budget_usd) {
    return { allowed: false, reason: 'estimated_over_budget' };
  }
  return { allowed: true, reason: 'within_budget' };
}

function runnerTranscriptOutput(
  testCase: MemoryReplayEvalCase,
  replayState: ReplayState,
): { runner_input_text?: string; runner_source_matches_chunk?: boolean } {
  if (typeof testCase.input.runner_transcript_id !== 'string') return {};
  const transcript = replayState.runnerTranscriptsById.get(testCase.input.runner_transcript_id);
  return {
    runner_input_text: transcript?.input_text ?? '',
    runner_source_matches_chunk: transcript?.source_chunk_id === testCase.input.chunk_id,
  };
}

function redactSecrets(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_SECRET]')
    .replace(/xox[baprs]-[A-Za-z0-9-]{12,}/g, '[REDACTED_SECRET]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_SECRET]');
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return deepEqual(leftKeys, rightKeys)
      && leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stageKey(stage: string, id: string): string {
  return `${stage}\0${id}`;
}
