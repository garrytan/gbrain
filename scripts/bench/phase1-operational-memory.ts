#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { buildTaskResumeCard } from '../../src/core/services/task-memory-service.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  PHASE1_ACCEPTANCE_THRESHOLDS,
  PHASE1_PENDING_BASELINE_REASON,
  PHASE1_TASK_FIXTURES,
  PHASE1_WORKLOADS,
  type Phase1AcceptanceCheck,
  type Phase1AcceptanceReport,
  type Phase1CorrectnessWorkloadName,
  type Phase1LatencyWorkloadName,
  type Phase1WorkloadResult,
} from './phase1-workloads.ts';

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const baselinePath = getFlagValue(rawArgs, '--baseline');
const writeBaselinePath = getFlagValue(rawArgs, '--write-baseline');

if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase1-operational-memory.ts [--json] [--baseline <path>] [--write-baseline <path>]');
  process.exit(0);
}

const jsonOutput = args.has('--json');
const tempDir = mkdtempSync(join(tmpdir(), 'mbrain-phase1-'));
const databasePath = join(tempDir, 'phase1.db');

let engine: BrainEngine | null = null;

try {
  const config = createLocalConfigDefaults({
    database_path: databasePath,
    embedding_provider: 'none',
    query_rewrite_provider: 'none',
  });

  engine = await createConnectedEngine(config);
  await engine.initSchema();
  await seedPhase1Fixtures(engine);

  const workloads: Phase1WorkloadResult[] = [];
  workloads.push(await runLatencyWorkload(engine, 'task_resume'));
  workloads.push(await runLatencyWorkload(engine, 'attempt_history'));
  workloads.push(await runLatencyWorkload(engine, 'decision_history'));
  workloads.push(await runResumeProjectionWorkload(engine));
  workloads.push(await runRepeatedWorkSuppressionWorkload(engine));
  workloads.push(await runTraceTemplateCompletenessWorkload(engine));

  const payload = {
    generated_at: new Date().toISOString(),
    engine: config.engine,
    workloads,
    acceptance: evaluateAcceptance(workloads, config.engine, baselinePath ? loadBaseline(baselinePath) : null),
  };

  if (writeBaselinePath) {
    persistBaseline(writeBaselinePath, payload);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Phase 1 operational-memory benchmark complete for ${config.engine}`);
    console.log(JSON.stringify(payload, null, 2));
  }
} finally {
  if (engine) {
    await engine.disconnect();
  }
  rmSync(tempDir, { recursive: true, force: true });
}

async function seedPhase1Fixtures(engine: BrainEngine): Promise<void> {
  for (const fixture of PHASE1_TASK_FIXTURES) {
    await engine.createTaskThread(fixture.thread);
    await engine.upsertTaskWorkingSet({
      task_id: fixture.thread.id,
      active_paths: fixture.workingSet.active_paths,
      active_symbols: fixture.workingSet.active_symbols,
      blockers: fixture.workingSet.blockers,
      open_questions: fixture.workingSet.open_questions,
      next_steps: fixture.workingSet.next_steps,
      verification_notes: fixture.workingSet.verification_notes,
      last_verified_at: fixture.workingSet.last_verified_at,
    });

    for (const attempt of fixture.attempts) {
      await engine.recordTaskAttempt({
        ...attempt,
        task_id: fixture.thread.id,
      });
    }

    for (const decision of fixture.decisions) {
      await engine.recordTaskDecision({
        ...decision,
        task_id: fixture.thread.id,
      });
    }

    await engine.putRetrievalTrace({
      ...fixture.trace,
      task_id: fixture.thread.id,
      scope: fixture.thread.scope,
    });
  }
}

async function runLatencyWorkload(
  engine: BrainEngine,
  name: Phase1LatencyWorkloadName,
): Promise<Extract<Phase1WorkloadResult, { name: Phase1LatencyWorkloadName }>> {
  const definition = PHASE1_WORKLOADS.find((workload) => workload.name === name);
  const samples = definition?.samples ?? 5;
  const durations: number[] = [];

  for (let i = 0; i < samples; i++) {
    for (const fixture of PHASE1_TASK_FIXTURES) {
      const start = performance.now();
      if (name === 'task_resume') {
        await buildTaskResumeCard(engine, fixture.thread.id);
      } else if (name === 'attempt_history') {
        await engine.listTaskAttempts(fixture.thread.id, { limit: 10 });
      } else {
        await engine.listTaskDecisions(fixture.thread.id, { limit: 10 });
      }
      durations.push(performance.now() - start);
    }
  }

  return {
    name,
    status: 'measured',
    unit: 'ms',
    p50_ms: formatMeasuredMs(percentile(durations, 0.5)),
    p95_ms: formatMeasuredMs(percentile(durations, 0.95)),
  };
}

async function runResumeProjectionWorkload(
  engine: BrainEngine,
): Promise<Phase1CorrectnessWorkloadResult> {
  let passed = 0;

  for (const fixture of PHASE1_TASK_FIXTURES) {
    const resume = await buildTaskResumeCard(engine, fixture.thread.id);
    const matches =
      resume.stale === fixture.expectedResume.stale &&
      hasExactItems(resume.failed_attempts, fixture.expectedResume.failed_attempts) &&
      hasExactItems(resume.active_decisions, fixture.expectedResume.active_decisions) &&
      hasExactItems(resume.latest_trace_route, fixture.expectedResume.latest_trace_route);

    if (matches) {
      passed += 1;
    }
  }

  return {
    name: 'resume_projection',
    status: 'measured',
    unit: 'percent',
    success_rate: roundTo((passed / PHASE1_TASK_FIXTURES.length) * 100, 2),
  };
}

type Phase1CorrectnessWorkloadResult = Extract<Phase1WorkloadResult, { unit: 'percent' }>;

async function runRepeatedWorkSuppressionWorkload(
  engine: BrainEngine,
): Promise<Phase1CorrectnessWorkloadResult> {
  let passed = 0;

  for (const fixture of PHASE1_TASK_FIXTURES) {
    const resume = await buildTaskResumeCard(engine, fixture.thread.id);
    const expectedWarnings = fixture.attempts
      .filter((attempt) => attempt.outcome === 'failed')
      .map((attempt) => `Do not repeat failed attempt: ${attempt.summary}`);

    if (hasExactItems(resume.repeated_work_warnings, expectedWarnings)) {
      passed += 1;
    }
  }

  return {
    name: 'repeated_work_suppression',
    status: 'measured',
    unit: 'percent',
    success_rate: roundTo((passed / PHASE1_TASK_FIXTURES.length) * 100, 2),
  };
}

async function runTraceTemplateCompletenessWorkload(
  engine: BrainEngine,
): Promise<Phase1CorrectnessWorkloadResult> {
  let passed = 0;

  for (const fixture of PHASE1_TASK_FIXTURES) {
    const resume = await buildTaskResumeCard(engine, fixture.thread.id);
    const template = resume.retrieval_trace_template;
    const expectedRoute = ['task_thread', 'working_set', 'attempt_history', 'decision_history', 'retrieval_trace'];
    const expectedSourceRefs = [
      `task-thread:${fixture.thread.id}`,
      `working-set:${fixture.thread.id}`,
      ...fixture.attempts
        .filter((attempt) => attempt.outcome === 'failed')
        .map((attempt) => `task-attempt:${attempt.id}`),
      ...fixture.decisions.map((decision) => `task-decision:${decision.id}`),
      `retrieval_trace:${fixture.trace.id}`,
    ];
    const matches =
      template.selected_intent === 'task_resume' &&
      template.write_outcome === 'no_durable_write' &&
      hasExactItems(template.route, expectedRoute) &&
      hasExactItems(template.source_refs, expectedSourceRefs) &&
      template.verification.includes('resume_card_built') &&
      template.outcome.includes(fixture.thread.id);

    if (matches) {
      passed += 1;
    }
  }

  return {
    name: 'trace_template_completeness',
    status: 'measured',
    unit: 'percent',
    success_rate: roundTo((passed / PHASE1_TASK_FIXTURES.length) * 100, 2),
  };
}

function hasExactItems(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every((entry, index) => actual[index] === entry);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function formatMeasuredMs(value: number): number {
  if (value <= 0) return 0;
  return Math.max(0.001, roundTo(value, 3));
}

function evaluateAcceptance(
  workloads: Phase1WorkloadResult[],
  engine: string,
  baseline: Phase1BenchmarkPayload | null,
): Phase1AcceptanceReport {
  const checks: Phase1AcceptanceCheck[] = [];

  const taskResume = getLatencyWorkload(workloads, 'task_resume');
  checks.push({
    name: 'task_resume_p95_ms',
    status: taskResume.p95_ms <= PHASE1_ACCEPTANCE_THRESHOLDS.task_resume_p95_ms_max ? 'pass' : 'fail',
    actual: taskResume.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE1_ACCEPTANCE_THRESHOLDS.task_resume_p95_ms_max,
      unit: 'ms',
    },
  });

  const attemptHistory = getLatencyWorkload(workloads, 'attempt_history');
  checks.push({
    name: 'attempt_history_p95_ms',
    status: attemptHistory.p95_ms <= PHASE1_ACCEPTANCE_THRESHOLDS.attempt_history_p95_ms_max ? 'pass' : 'fail',
    actual: attemptHistory.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE1_ACCEPTANCE_THRESHOLDS.attempt_history_p95_ms_max,
      unit: 'ms',
    },
  });

  const decisionHistory = getLatencyWorkload(workloads, 'decision_history');
  checks.push({
    name: 'decision_history_p95_ms',
    status: decisionHistory.p95_ms <= PHASE1_ACCEPTANCE_THRESHOLDS.decision_history_p95_ms_max ? 'pass' : 'fail',
    actual: decisionHistory.p95_ms,
    threshold: {
      operator: '<=',
      value: PHASE1_ACCEPTANCE_THRESHOLDS.decision_history_p95_ms_max,
      unit: 'ms',
    },
  });

  const resumeProjection = getCorrectnessWorkload(workloads, 'resume_projection');
  checks.push({
    name: 'resume_projection_success_rate',
    status: resumeProjection.success_rate === PHASE1_ACCEPTANCE_THRESHOLDS.resume_projection_success_rate ? 'pass' : 'fail',
    actual: resumeProjection.success_rate,
    threshold: {
      operator: '===',
      value: PHASE1_ACCEPTANCE_THRESHOLDS.resume_projection_success_rate,
      unit: 'percent',
    },
  });

  const repeatedWorkSuppression = getCorrectnessWorkload(workloads, 'repeated_work_suppression');
  checks.push({
    name: 'repeated_work_suppression_success_rate',
    status: repeatedWorkSuppression.success_rate === PHASE1_ACCEPTANCE_THRESHOLDS.repeated_work_suppression_success_rate ? 'pass' : 'fail',
    actual: repeatedWorkSuppression.success_rate,
    threshold: {
      operator: '===',
      value: PHASE1_ACCEPTANCE_THRESHOLDS.repeated_work_suppression_success_rate,
      unit: 'percent',
    },
  });

  const traceTemplateCompleteness = getCorrectnessWorkload(workloads, 'trace_template_completeness');
  checks.push({
    name: 'trace_template_completeness_success_rate',
    status: traceTemplateCompleteness.success_rate === PHASE1_ACCEPTANCE_THRESHOLDS.trace_template_completeness_success_rate ? 'pass' : 'fail',
    actual: traceTemplateCompleteness.success_rate,
    threshold: {
      operator: '===',
      value: PHASE1_ACCEPTANCE_THRESHOLDS.trace_template_completeness_success_rate,
      unit: 'percent',
    },
  });

  checks.push(buildPrimaryImprovementCheck(taskResume, engine, baseline));

  const readiness_status = checks.every((check) => check.status !== 'fail') ? 'pass' : 'fail';
  const primaryCheck = checks.find((check) => check.name === 'primary_improvement_threshold');
  const phase1_status = readiness_status === 'fail'
    ? 'fail'
    : primaryCheck?.status === 'pass'
      ? 'pass'
      : primaryCheck?.status === 'fail'
        ? 'fail'
        : 'pending_baseline';
  const summary = buildAcceptanceSummary(readiness_status, phase1_status, primaryCheck?.reason);

  return {
    thresholds: PHASE1_ACCEPTANCE_THRESHOLDS,
    readiness_status,
    phase1_status,
    checks,
    summary,
  };
}

interface Phase1BenchmarkPayload {
  engine: string;
  workloads: Phase1WorkloadResult[];
}

function buildPrimaryImprovementCheck(
  taskResume: Extract<Phase1WorkloadResult, { name: 'task_resume' }>,
  engine: string,
  baseline: Phase1BenchmarkPayload | null,
): Phase1AcceptanceCheck {
  const threshold = {
    operator: '>=' as const,
    value: PHASE1_ACCEPTANCE_THRESHOLDS.primary_improvement_threshold_pct,
    unit: 'percent' as const,
  };

  if (!baseline) {
    return {
      name: 'primary_improvement_threshold',
      status: 'pending_baseline',
      threshold,
      reason: PHASE1_PENDING_BASELINE_REASON,
    };
  }

  if (baseline.engine !== engine) {
    return {
      name: 'primary_improvement_threshold',
      status: 'fail',
      threshold,
      reason: `Baseline engine mismatch: expected ${engine}, received ${baseline.engine}.`,
    };
  }

  const baselineTaskResume = baseline.workloads.find((workload) => workload.name === 'task_resume');
  if (!baselineTaskResume || baselineTaskResume.unit !== 'ms' || baselineTaskResume.p95_ms <= 0) {
    return {
      name: 'primary_improvement_threshold',
      status: 'fail',
      threshold,
      reason: 'Baseline payload is missing a comparable task_resume p95 measurement.',
    };
  }

  const improvementPct = roundTo(
    ((baselineTaskResume.p95_ms - taskResume.p95_ms) / baselineTaskResume.p95_ms) * 100,
    2,
  );

  return {
    name: 'primary_improvement_threshold',
    status: improvementPct >= PHASE1_ACCEPTANCE_THRESHOLDS.primary_improvement_threshold_pct ? 'pass' : 'fail',
    actual: improvementPct,
    threshold,
    reason: `Compared against baseline task_resume p95 ${baselineTaskResume.p95_ms}ms.`,
  };
}

function buildAcceptanceSummary(
  readinessStatus: Extract<Phase1AcceptanceReport['readiness_status'], 'pass' | 'fail'>,
  phase1Status: Phase1AcceptanceReport['phase1_status'],
  primaryReason?: string,
): string {
  if (readinessStatus === 'fail') {
    return 'Phase 1 readiness failed one or more local guardrails.';
  }
  if (phase1Status === 'pass') {
    return 'Phase 1 readiness passes local guardrails and clears the primary improvement threshold against the supplied baseline.';
  }
  if (phase1Status === 'fail') {
    return `Phase 1 readiness passes local guardrails, but full phase acceptance failed: ${primaryReason ?? 'the primary improvement threshold was not met.'}`;
  }
  return `Phase 1 readiness passes the local guardrails, but full phase acceptance remains pending: ${primaryReason ?? PHASE1_PENDING_BASELINE_REASON}`;
}

function getLatencyWorkload(
  workloads: Phase1WorkloadResult[],
  name: Phase1LatencyWorkloadName,
): Extract<Phase1WorkloadResult, { name: Phase1LatencyWorkloadName }> {
  const workload = workloads.find((entry) => entry.name === name);
  if (!workload || workload.unit !== 'ms') {
    throw new Error(`Missing latency workload: ${name}`);
  }
  return workload;
}

function getCorrectnessWorkload(
  workloads: Phase1WorkloadResult[],
  name: Phase1CorrectnessWorkloadName,
): Phase1CorrectnessWorkloadResult {
  const workload = workloads.find((entry) => entry.name === name);
  if (!workload || workload.unit !== 'percent') {
    throw new Error(`Missing correctness workload: ${name}`);
  }
  return workload;
}

function loadBaseline(path: string): Phase1BenchmarkPayload {
  return JSON.parse(readFileSync(path, 'utf-8')) as Phase1BenchmarkPayload;
}

function persistBaseline(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
