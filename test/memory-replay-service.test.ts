import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import {
  MEMORY_REPLAY_SERVICE_FLOW,
  REQUIRED_MEMORY_REPLAY_STAGES,
  runMemoryReplayFixtureWithServices,
  runMemoryReplayFixture,
} from '../src/core/evaluation/memory-replay.ts';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/mbrain-postgres-runtime/full-lifecycle.fixture.json', import.meta.url),
  'utf8',
));

describe('memory replay evaluation', () => {
  test('deterministic lifecycle fixture covers every required stage and passes replay smoke', () => {
    const result = runMemoryReplayFixture(fixture);

    expect(result.fixture_id).toBe('mbrain-postgres-runtime-full-lifecycle');
    expect(result.coverage.required_stages).toEqual(REQUIRED_MEMORY_REPLAY_STAGES);
    expect(result.coverage.missing_stages).toEqual([]);
    expect(result.status).toBe('passed');
    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.metrics).toMatchObject({
      total_cases: 8,
      passed_cases: 8,
      policy_decision_accuracy: 1,
      prompt_injection_quarantine_success: 1,
      secret_redaction_success: 1,
      runner_denied_tool_success: 1,
      retrieval_semantic_coverage_success: 1,
      extraction_precision: 1,
      extraction_recall: 1,
      conflict_detection_accuracy: 1,
      duplicate_supersession_accuracy: 1,
      job_failure_retry_success: 1,
      time_to_disposition_success: 1,
      inappropriate_canonical_write_count: 0,
      missing_canonical_write_count: 0,
      missing_canonical_write_trace_count: 0,
      expired_retrieval_leakage: 0,
      stale_retrieval_leakage: 0,
      projection_drift_count: 1,
    });
  });

  test('policy matrix replay catches changed decisions', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      assertions: fixture.assertions.map((assertion: Record<string, unknown>) =>
        assertion.id === 'assertion:low-confidence'
          ? { ...assertion, confidence: 0.99 }
          : assertion
      ),
    });

    expect(result.status).toBe('failed');
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'policy-candidate-low-confidence',
        type: 'policy_decision',
        passed: false,
        expected: 'candidate',
        actual: 'canonical_write',
      }),
    );
    expect(result.metrics.inappropriate_canonical_write_count).toBe(0);
    expect(result.metrics.missing_canonical_write_count).toBe(1);
  });

  test('replay fails when expected extraction claims are missing', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      claims: fixture.claims.filter((claim: Record<string, unknown>) => claim.id !== 'claim:timezone'),
    });

    expect(result.metrics.extraction_precision).toBe(1);
    expect(result.metrics.extraction_recall).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('replay fails when unexpected claims are extracted', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      claims: [
        ...fixture.claims,
        { id: 'claim:hallucinated', chunk_id: 'chunk:gmail:message-1:preference' },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.extraction_precision).toBeLessThan(1);
    expect(result.metrics.extraction_recall).toBe(1);
    expect(result.status).toBe('failed');
  });

  test('replay fails when extracted claims point at the wrong source chunk', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      claims: fixture.claims.map((claim: Record<string, unknown>) =>
        claim.id === 'claim:timezone'
          ? { ...claim, chunk_id: 'chunk:gmail:message-1:injection' }
          : claim
      ),
    });

    expect(result.metrics.extraction_precision).toBeLessThan(1);
    expect(result.metrics.extraction_recall).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('replay metrics count missing canonical writes for active high-confidence assertions', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      canonical_writes: [],
    });

    expect(result.status).toBe('failed');
    expect(result.stage_results).toContainEqual(
      expect.objectContaining({
        stage: 'canonical_write',
        id: 'write:people/ada',
        expected: 'applied',
        actual: 'missing_record',
        passed: false,
      }),
    );
    expect(result.metrics.missing_canonical_write_count).toBe(2);
  });

  test('replay fails when only the missing canonical write metric is violated', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      claims: [
        ...fixture.claims,
        { id: 'claim:unwritten-preference', chunk_id: 'chunk:gmail:message-1:preference' },
      ],
      assertions: [
        ...fixture.assertions,
        {
          id: 'assertion:unwritten-preference',
          claim_id: 'claim:unwritten-preference',
          confidence: 0.93,
          lifecycle_state: 'active',
        },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.missing_canonical_write_count).toBe(1);
    expect(result.status).toBe('failed');
  });

  test('replay metrics count unexpected canonical write records as fail-closed', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      canonical_writes: [
        ...fixture.canonical_writes,
        { id: 'write:low-confidence', assertion_id: 'assertion:low-confidence' },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.inappropriate_canonical_write_count).toBe(1);
    expect(result.status).toBe('failed');
  });

  test('canonical write trace metric catches unbacked writes that are not declared stages', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      stages: fixture.stages.filter((stage: Record<string, unknown>) =>
        !(stage.stage === 'canonical_write' && stage.id === 'write:code/runtime-stale')
      ),
      mutation_events: fixture.mutation_events.filter((event: Record<string, unknown>) =>
        !(event.stage === 'canonical_write' && event.target_id === 'write:code/runtime-stale')
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.coverage.missing_stages).toEqual([]);
    expect(result.metrics.missing_canonical_write_trace_count).toBe(1);
    expect(result.status).toBe('failed');
  });

  test('replay rejects canonical writes for lifecycle-ineligible assertions', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      assertions: [
        ...fixture.assertions,
        {
          id: 'assertion:archived',
          claim_id: 'claim:preference',
          confidence: 0.91,
          lifecycle_state: 'archived',
        },
        {
          id: 'assertion:purged',
          claim_id: 'claim:preference',
          confidence: 0.91,
          lifecycle_state: 'purged',
        },
      ],
      canonical_writes: [
        ...fixture.canonical_writes,
        { id: 'write:expired', assertion_id: 'assertion:expired' },
        { id: 'write:archived', assertion_id: 'assertion:archived' },
        { id: 'write:purged', assertion_id: 'assertion:purged' },
      ],
      expected_dispositions: [
        ...fixture.expected_dispositions,
        {
          assertion_id: 'assertion:expired',
          resolved_at: '2026-05-20T00:00:00.000Z',
          disposed_at: '2026-05-20T00:05:00.000Z',
          max_seconds: 600,
        },
        {
          assertion_id: 'assertion:archived',
          resolved_at: '2026-05-20T00:00:00.000Z',
          disposed_at: '2026-05-20T00:05:00.000Z',
          max_seconds: 600,
        },
        {
          assertion_id: 'assertion:purged',
          resolved_at: '2026-05-20T00:00:00.000Z',
          disposed_at: '2026-05-20T00:05:00.000Z',
          max_seconds: 600,
        },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.inappropriate_canonical_write_count).toBe(3);
    expect(result.status).toBe('failed');
  });

  test('replay metrics count expired retrieval leakage when default retrieval exposes expired assertions', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      assertions: fixture.assertions.map((assertion: Record<string, unknown>) =>
        assertion.id === 'assertion:expired'
          ? { ...assertion, lifecycle_state: 'active' }
          : assertion
      ),
      canonical_writes: [
        ...fixture.canonical_writes,
        { id: 'write:expired', assertion_id: 'assertion:expired' },
      ],
      mutation_events: [
        ...fixture.mutation_events,
        { id: 'event:canonical-write-expired', stage: 'canonical_write', target_id: 'write:expired', result: 'applied' },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'expired-hidden-from-default-retrieval',
        type: 'retrieval_visibility',
        expected: { visible: false, lifecycle_state: 'expired' },
        actual: { visible: true, lifecycle_state: 'active', activation: 'answer_ground' },
        passed: false,
      }),
    );
    expect(result.metrics.expired_retrieval_leakage).toBe(1);
  });

  test('replay metrics count stale leakage when stale assertions become answer-grounding', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      assertions: fixture.assertions.map((assertion: Record<string, unknown>) =>
        assertion.id === 'assertion:stale-code'
          ? { ...assertion, lifecycle_state: 'active' }
          : assertion
      ),
    });

    expect(result.status).toBe('failed');
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'stale-verify-first-from-default-retrieval',
        type: 'retrieval_visibility',
        expected: { visible: true, lifecycle_state: 'stale', activation: 'verify_first' },
        actual: { visible: true, lifecycle_state: 'active', activation: 'answer_ground' },
        passed: false,
      }),
    );
    expect(result.metrics.stale_retrieval_leakage).toBe(1);
  });

  test('replay fails when expired default retrieval coverage is omitted', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      eval_cases: fixture.eval_cases.filter((testCase: Record<string, unknown>) =>
        testCase.id !== 'expired-hidden-from-default-retrieval'
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.retrieval_semantic_coverage_success).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('replay fails when stale verify-first retrieval coverage is omitted', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      eval_cases: fixture.eval_cases.filter((testCase: Record<string, unknown>) =>
        testCase.id !== 'stale-verify-first-from-default-retrieval'
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.retrieval_semantic_coverage_success).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('stale verify-first coverage requires an assertion-backed canonical trace', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      canonical_writes: fixture.canonical_writes.filter((write: Record<string, unknown>) =>
        write.id !== 'write:code/runtime-stale'
      ),
      mutation_events: fixture.mutation_events.filter((event: Record<string, unknown>) =>
        !(event.stage === 'canonical_write' && event.target_id === 'write:code/runtime-stale')
      ),
      stages: fixture.stages.filter((stage: Record<string, unknown>) =>
        !(stage.stage === 'canonical_write' && stage.id === 'write:code/runtime-stale')
      ),
      eval_cases: fixture.eval_cases.map((testCase: Record<string, unknown>) =>
        testCase.id === 'stale-verify-first-from-default-retrieval'
          ? {
              ...testCase,
              input: { mode: 'default', lifecycle_state: 'stale' },
            }
          : testCase
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'stale-verify-first-from-default-retrieval',
        actual: { visible: false, lifecycle_state: 'stale' },
        passed: false,
      }),
    );
    expect(result.metrics.retrieval_semantic_coverage_success).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('replay fails when only conflict detection accuracy is degraded', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      claims: [
        ...fixture.claims,
        { id: 'claim:conflict-unrouted', chunk_id: 'chunk:gmail:message-1:preference' },
      ],
      assertions: [
        ...fixture.assertions,
        {
          id: 'assertion:conflict-unrouted',
          claim_id: 'claim:conflict-unrouted',
          confidence: 0.92,
          conflict: true,
          lifecycle_state: 'active',
        },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.conflict_detection_accuracy).toBe(0.5);
    expect(result.status).toBe('failed');
  });

  test('replay fails when conflict routing has false positives', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      conflict_routes: [
        ...fixture.conflict_routes,
        { id: 'conflict:false-positive', assertion_id: 'assertion:preference', status: 'open' },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.conflict_detection_accuracy).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('replay fails when superseded duplicate assertions stay active', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      assertions: fixture.assertions.map((assertion: Record<string, unknown>) =>
        assertion.id === 'assertion:old-role'
          ? { ...assertion, lifecycle_state: 'active' }
          : assertion
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.duplicate_supersession_accuracy).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('replay fails when duplicate assertions have no supersession record', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      supersessions: [],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.duplicate_supersession_accuracy).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('replay fails when supersession links unrelated duplicate keys', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      supersessions: fixture.supersessions.map((supersession: Record<string, unknown>) => ({
        ...supersession,
        superseding_assertion_id: 'assertion:preference',
      })),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.duplicate_supersession_accuracy).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('replay fails when a duplicate group leaves an extra active canonical assertion unsuperseded', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      claims: [
        ...fixture.claims,
        {
          id: 'claim:third-role',
          chunk_id: 'chunk:gmail:message-1:preference',
          duplicate_key: 'people/ada#role',
        },
      ],
      assertions: [
        ...fixture.assertions,
        {
          id: 'assertion:third-role',
          claim_id: 'claim:third-role',
          confidence: 0.91,
          lifecycle_state: 'active',
        },
      ],
      canonical_writes: [
        ...fixture.canonical_writes,
        { id: 'write:people/ada-role-third', assertion_id: 'assertion:third-role' },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.duplicate_supersession_accuracy).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('default retrieval gates candidates and surfaces conflicts explicitly', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      eval_cases: [
        ...fixture.eval_cases,
        {
          id: 'candidate-hidden-from-default-retrieval',
          type: 'retrieval_visibility',
          input: { assertion_id: 'assertion:low-confidence', mode: 'default' },
          expected: { visible: false, lifecycle_state: 'active' },
        },
        {
          id: 'conflict-surfaced-from-default-retrieval',
          type: 'retrieval_visibility',
          input: { assertion_id: 'assertion:timezone', mode: 'default' },
          expected: { visible: true, lifecycle_state: 'active', activation: 'conflict' },
        },
      ],
    });

    expect(result.status).toBe('passed');
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'candidate-hidden-from-default-retrieval',
        actual: { visible: false, lifecycle_state: 'active' },
        passed: true,
      }),
    );
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'conflict-surfaced-from-default-retrieval',
        actual: { visible: true, lifecycle_state: 'active', activation: 'conflict' },
        passed: true,
      }),
    );
  });

  test('structured replay comparisons ignore object key order', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      eval_cases: fixture.eval_cases.map((testCase: Record<string, unknown>) =>
        testCase.id === 'secret-redaction-before-runner'
          ? {
              ...testCase,
              expected: {
                runner_input_text: 'The token is [REDACTED_SECRET] and must not leave the raw boundary.',
                runner_source_matches_chunk: true,
                redacted_text: 'The token is [REDACTED_SECRET] and must not leave the raw boundary.',
                secret_risk: 'redacted',
              },
            }
          : testCase
      ),
    });

    expect(result.status).toBe('passed');
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'secret-redaction-before-runner',
        passed: true,
      }),
    );
  });

  test('runner denied-tool success only measures denied-tool cases', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      eval_cases: [
        ...fixture.eval_cases,
        {
          id: 'runner-allowed-tool-regression',
          type: 'runner_tool_call',
          input: { allowed_tools: [], requested_tool: 'exec' },
          expected: { decision: 'allowed' },
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'runner-denied-tool-fails-closed',
        passed: true,
      }),
    );
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'runner-allowed-tool-regression',
        passed: false,
      }),
    );
    expect(result.metrics.runner_denied_tool_success).toBe(1);
  });

  test('replay fails when runner tool coverage omits a denied-tool sample', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      eval_cases: [
        ...fixture.eval_cases.filter((testCase: Record<string, unknown>) =>
          testCase.id !== 'runner-denied-tool-fails-closed'
        ),
        {
          id: 'runner-allowed-tool-smoke',
          type: 'runner_tool_call',
          input: { allowed_tools: ['read_context'], requested_tool: 'read_context' },
          expected: { decision: 'allowed' },
        },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.runner_denied_tool_success).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('replay fails when prompt-injection coverage omits a quarantine sample', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      eval_cases: [
        ...fixture.eval_cases.filter((testCase: Record<string, unknown>) =>
          testCase.id !== 'prompt-injection-quarantine'
        ),
        {
          id: 'prompt-benign-smoke',
          type: 'prompt_injection',
          input: { chunk_id: 'chunk:gmail:message-1:preference' },
          expected: { risk: 'none' },
        },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.prompt_injection_quarantine_success).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('replay fails when secret coverage omits a redaction sample', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      eval_cases: [
        ...fixture.eval_cases.filter((testCase: Record<string, unknown>) =>
          testCase.id !== 'secret-redaction-before-runner'
        ),
        {
          id: 'secret-benign-smoke',
          type: 'secret_redaction',
          input: { chunk_id: 'chunk:gmail:message-1:preference' },
          expected: {
            secret_risk: 'none',
            redacted_text: 'Ada prefers concise reports.',
          },
        },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.secret_redaction_success).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('replay fails when failed runner jobs have no retry path', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      runner_jobs: fixture.runner_jobs.map((job: Record<string, unknown>) =>
        job.id === 'runner:failed-import'
          ? { id: job.id, status: job.status }
          : job
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.job_failure_retry_success).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('replay fails when expected failed-job retry coverage disappears', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      runner_jobs: fixture.runner_jobs.filter((job: Record<string, unknown>) =>
        job.id !== 'runner:failed-import' && job.id !== 'runner:retry-import'
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.job_failure_retry_success).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('replay fails when retry expectations and retry evidence both disappear', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      runner_jobs: fixture.runner_jobs.filter((job: Record<string, unknown>) =>
        job.id !== 'runner:failed-import' && job.id !== 'runner:retry-import'
      ),
      expected_job_retries: [],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.job_failure_retry_success).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('replay fails when failed runner retry only creates a proposal', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      runner_jobs: fixture.runner_jobs.map((job: Record<string, unknown>) =>
        job.id === 'runner:retry-import'
          ? { ...job, status: 'proposal_only', proposal_only: true }
          : job
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.job_failure_retry_success).toBe(0);
    expect(result.status).toBe('failed');
  });

  test('replay fails when expected disposition evidence is missing', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      expected_dispositions: fixture.expected_dispositions.filter((disposition: Record<string, unknown>) =>
        disposition.assertion_id !== 'assertion:timezone'
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.time_to_disposition_success).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('replay fails when disposition exceeds the fixture SLA', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      expected_dispositions: fixture.expected_dispositions.map((disposition: Record<string, unknown>) =>
        disposition.assertion_id === 'assertion:preference'
          ? { ...disposition, disposed_at: '2026-05-20T00:30:00.000Z' }
          : disposition
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.time_to_disposition_success).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('canonical write dispositions are required even when omitted from manual required ids', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      expected_disposition_assertion_ids: fixture.expected_disposition_assertion_ids.filter((assertionId: string) =>
        assertionId !== 'assertion:new-role'
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.time_to_disposition_success).toBe(1);
    expect(result.status).toBe('passed');
  });

  test('replay fails when a canonical write disposition is fully omitted', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      expected_disposition_assertion_ids: fixture.expected_disposition_assertion_ids.filter((assertionId: string) =>
        assertionId !== 'assertion:new-role'
      ),
      expected_dispositions: fixture.expected_dispositions.filter((disposition: Record<string, unknown>) =>
        disposition.assertion_id !== 'assertion:new-role'
      ),
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.time_to_disposition_success).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('replay fails when a duplicate disposition row exceeds the fixture SLA', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      expected_dispositions: [
        ...fixture.expected_dispositions,
        {
          assertion_id: 'assertion:preference',
          resolved_at: '2026-05-20T00:00:00.000Z',
          disposed_at: '2026-05-20T00:30:00.000Z',
          max_seconds: 600,
        },
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.time_to_disposition_success).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('replay fails when an earlier duplicate disposition row exceeds the fixture SLA', () => {
    const lateDisposition = {
      assertion_id: 'assertion:preference',
      resolved_at: '2026-05-20T00:00:00.000Z',
      disposed_at: '2026-05-20T00:30:00.000Z',
      max_seconds: 600,
    };
    const result = runMemoryReplayFixture({
      ...fixture,
      expected_dispositions: [
        lateDisposition,
        ...fixture.expected_dispositions,
      ],
    });

    expect(result.stage_results.every((stage) => stage.passed)).toBe(true);
    expect(result.case_results.every((testCase) => testCase.passed)).toBe(true);
    expect(result.metrics.time_to_disposition_success).toBeLessThan(1);
    expect(result.status).toBe('failed');
  });

  test('replay catches stage expectations that disagree with computed fixture state', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      stages: fixture.stages.map((stage: Record<string, unknown>) =>
        stage.stage === 'canonical_write'
          ? { ...stage, expected: 'skipped' }
          : stage
      ),
    });

    expect(result.status).toBe('failed');
    expect(result.stage_results).toContainEqual(
      expect.objectContaining({
        stage: 'canonical_write',
        id: 'write:people/ada',
        expected: 'skipped',
        actual: 'applied',
        passed: false,
      }),
    );
  });

  test('replay fails when a declared lifecycle stage has no backing fixture record', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      forgetting: [],
    });

    expect(result.status).toBe('failed');
    expect(result.stage_results).toContainEqual(
      expect.objectContaining({
        stage: 'lifecycle_transition',
        id: 'lifecycle:expired',
        expected: 'expired',
        actual: 'missing_record',
        passed: false,
      }),
    );
  });

  test('replay fails when a declared candidate route has no backing fixture record', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      candidate_routes: [],
    });

    expect(result.status).toBe('failed');
    expect(result.stage_results).toContainEqual(
      expect.objectContaining({
        stage: 'candidate_route',
        id: 'candidate:low-confidence',
        expected: 'created',
        actual: 'missing_record',
        passed: false,
      }),
    );
  });

  test('replay fails when a declared conflict route has no backing fixture record', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      conflict_routes: [],
    });

    expect(result.status).toBe('failed');
    expect(result.stage_results).toContainEqual(
      expect.objectContaining({
        stage: 'conflict_route',
        id: 'conflict:timezone',
        expected: 'open',
        actual: 'missing_record',
        passed: false,
      }),
    );
  });

  test('replay fails when a canonical write has no backing mutation event', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      mutation_events: [],
    });

    expect(result.status).toBe('failed');
    expect(result.stage_results).toContainEqual(
      expect.objectContaining({
        stage: 'canonical_write',
        id: 'write:people/ada',
        expected: 'applied',
        actual: 'missing_event',
        passed: false,
      }),
    );
  });

  test('replay fails when a runner proposal has no backing runner job', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      runner_jobs: [],
    });

    expect(result.status).toBe('failed');
    expect(result.stage_results).toContainEqual(
      expect.objectContaining({
        stage: 'runner_proposal',
        id: 'runner:forgetting-review',
        expected: 'proposal_only',
        actual: 'missing_record',
        passed: false,
      }),
    );
  });

  test('projection round trip compares rendered content instead of accepting any non-empty markdown', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      projections: fixture.projections.map((projection: Record<string, unknown>) =>
        projection.id === 'projection:people/ada'
          ? { ...projection, rendered_markdown: '---\ntitle: Ada\n---\nWrong content.\n' }
          : projection
      ),
    });

    expect(result.status).toBe('failed');
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'projection-round-trip-stable',
        type: 'projection_round_trip',
        expected: true,
        actual: false,
        passed: false,
      }),
    );
  });

  test('projection round trip compares structured projection fields', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      projections: fixture.projections.map((projection: Record<string, unknown>) =>
        projection.id === 'projection:people/ada'
          ? {
              ...projection,
              structured_projection: { title: 'Ada', body: 'Ada prefers verbose reports.' },
            }
          : projection
      ),
    });

    expect(result.status).toBe('failed');
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'projection-round-trip-stable',
        type: 'projection_round_trip',
        expected: true,
        actual: false,
        passed: false,
      }),
    );
  });

  test('replay fails closed when required regression case types are missing', () => {
    const result = runMemoryReplayFixture({
      id: 'missing-case-types',
      stages: fixture.stages,
      eval_cases: [],
    });

    expect(result.status).toBe('failed');
    expect(result.coverage.missing_stages).toEqual([]);
    expect(result.coverage.missing_case_types).toEqual([
      'policy_decision',
      'retrieval_visibility',
      'prompt_injection',
      'secret_redaction',
      'runner_tool_call',
      'projection_round_trip',
      'live_eval_budget',
    ]);
    expect(result.metrics.total_cases).toBe(0);
    expect(result.metrics.policy_decision_accuracy).toBe(0);
    expect(result.metrics.prompt_injection_quarantine_success).toBe(0);
    expect(result.metrics.secret_redaction_success).toBe(0);
    expect(result.metrics.runner_denied_tool_success).toBe(0);
  });

  test('live runner evals require an explicit budget', () => {
    const result = runMemoryReplayFixture({
      id: 'live-budget-smoke',
      stages: fixture.stages,
      eval_cases: [
        {
          id: 'live-budget-required',
          type: 'live_eval_budget',
          input: { mode: 'live', budget_usd: null },
          expected: { allowed: false },
        },
      ],
    });

    expect(result.status).toBe('failed');
    expect(result.coverage.missing_case_types).toEqual(expect.arrayContaining([
      'policy_decision',
      'secret_redaction',
    ]));
    expect(result.case_results[0]).toMatchObject({
      actual: false,
      expected: false,
      passed: true,
    });
  });

  test('live runner evals abort before estimated budget overrun', () => {
    const result = runMemoryReplayFixture({
      id: 'live-budget-overrun-smoke',
      stages: fixture.stages,
      eval_cases: [
        {
          id: 'live-budget-overrun',
          type: 'live_eval_budget',
          input: { mode: 'live', budget_usd: 0.25, estimated_cost_usd: 0.75 },
          expected: { allowed: false, reason: 'estimated_over_budget' },
        },
      ],
    });

    expect(result.case_results[0]).toMatchObject({
      actual: { allowed: false, reason: 'estimated_over_budget' },
      expected: { allowed: false, reason: 'estimated_over_budget' },
      passed: true,
    });
  });

  test('secret redaction before runner fails when runner transcript receives raw secret text', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      runner_transcripts: fixture.runner_transcripts.map((transcript: Record<string, unknown>) =>
        transcript.id === 'runner-transcript:secret-redaction'
          ? {
              ...transcript,
              input_text: 'The token is sk-testsecret123456 and must not leave the raw boundary.',
            }
          : transcript
      ),
    });

    expect(result.status).toBe('failed');
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'secret-redaction-before-runner',
        type: 'secret_redaction',
        expected: {
          secret_risk: 'redacted',
          redacted_text: 'The token is [REDACTED_SECRET] and must not leave the raw boundary.',
          runner_input_text: 'The token is [REDACTED_SECRET] and must not leave the raw boundary.',
          runner_source_matches_chunk: true,
        },
        actual: {
          secret_risk: 'redacted',
          redacted_text: 'The token is [REDACTED_SECRET] and must not leave the raw boundary.',
          runner_input_text: 'The token is sk-testsecret123456 and must not leave the raw boundary.',
          runner_source_matches_chunk: true,
        },
        passed: false,
      }),
    );
  });

  test('secret redaction before runner fails when runner transcript is not linked to the source chunk', () => {
    const result = runMemoryReplayFixture({
      ...fixture,
      runner_transcripts: fixture.runner_transcripts.map((transcript: Record<string, unknown>) =>
        transcript.id === 'runner-transcript:secret-redaction'
          ? {
              ...transcript,
              source_chunk_id: 'chunk:gmail:message-1:unrelated',
            }
          : transcript
      ),
    });

    expect(result.status).toBe('failed');
    expect(result.case_results).toContainEqual(
      expect.objectContaining({
        id: 'secret-redaction-before-runner',
        type: 'secret_redaction',
        expected: {
          secret_risk: 'redacted',
          redacted_text: 'The token is [REDACTED_SECRET] and must not leave the raw boundary.',
          runner_input_text: 'The token is [REDACTED_SECRET] and must not leave the raw boundary.',
          runner_source_matches_chunk: true,
        },
        actual: {
          secret_risk: 'redacted',
          redacted_text: 'The token is [REDACTED_SECRET] and must not leave the raw boundary.',
          runner_input_text: 'The token is [REDACTED_SECRET] and must not leave the raw boundary.',
          runner_source_matches_chunk: false,
        },
        passed: false,
      }),
    );
  });

  test('service-backed replay records the configured lifecycle trace order', async () => {
    const observedPreviousStepCounts: number[] = [];
    const result = await runMemoryReplayFixtureWithServices(fixture, {
      source_registration: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      raw_ingest: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      extraction: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      assertion_resolution: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      policy: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      candidate_route: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      conflict_route: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      canonical_write: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      projection: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      dream: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      forgetting: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
      retrieval: ({ previous_steps }) => {
        observedPreviousStepCounts.push(previous_steps.length);
        return { status: 'ok' };
      },
    });

    expect(result.fixture_id).toBe('mbrain-postgres-runtime-full-lifecycle');
    expect(result.deterministic_result.status).toBe('passed');
    expect(result.trace_order).toEqual([...MEMORY_REPLAY_SERVICE_FLOW]);
    expect(result.steps.map((step) => step.stage)).toEqual([...MEMORY_REPLAY_SERVICE_FLOW]);
    expect(observedPreviousStepCounts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(result.status).toBe('passed');
  });

  test('service-backed replay fails closed when a lifecycle service is missing', async () => {
    const result = await runMemoryReplayFixtureWithServices(fixture, {
      source_registration: () => ({ status: 'ok' }),
    });

    expect(result.status).toBe('failed');
    expect(result.steps).toContainEqual(expect.objectContaining({
      stage: 'raw_ingest',
      status: 'missing_service',
    }));
  });
});
