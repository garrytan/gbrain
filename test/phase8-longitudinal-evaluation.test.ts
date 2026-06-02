import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  compareBenchmarkManifest,
  evaluateLongitudinalAcceptance,
  getProcessOutcome,
  PHASE_DEFINITIONS,
  runLongitudinalEvaluation,
  type Phase8LongitudinalPhaseSummary,
  type PhaseRunner,
} from '../scripts/bench/phase8-longitudinal-evaluation.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('phase8 longitudinal evaluation benchmark', () => {
  test('--help prints usage', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase8-longitudinal-evaluation.ts', '--help'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toContain(
      'Usage: bun run scripts/bench/phase8-longitudinal-evaluation.ts',
    );
  });

  test('builds a pending-baseline longitudinal summary without a phase1 baseline artifact', async () => {
    const payload = await runLongitudinalEvaluation({ phaseRunner: fakePhaseRunner() });
    expect(payload.phase).toBe('phase8');
    expect(Array.isArray(payload.phase_summaries)).toBe(true);
    expect(payload.phase_summaries.map((summary: any) => summary.phase)).toEqual([
      'phase1',
      'phase2',
      'phase3',
      'phase4',
      'phase5',
      'phase6',
      'phase7',
    ]);

    const phase1 = findPhase(payload.phase_summaries, 'phase1');
    expect(phase1.comparable_status).toBe('pending_baseline');
    expect(phase1.readiness_status).toBe('pass');
    expect(phase1.phase_status).toBe('pending_baseline');

    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase8_status).toBe('pending_baseline');
    expect(getProcessOutcome(payload).exitCode).toBe(0);
  });

  test('phase1 baseline makes the longitudinal pack fully comparable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-phase8-phase1-baseline-'));
    const baselinePath = join(dir, 'phase1-baseline.json');

    try {
      writeFileSync(baselinePath, JSON.stringify({
        generated_at: '2026-04-19T00:00:00.000Z',
        engine: 'sqlite',
        // Synthetic comparable baseline: high enough to avoid local timing noise while
        // still exercising Phase 8 regression gating against the current workload shape.
        workloads: [
          { name: 'task_resume', status: 'measured', unit: 'ms', p50_ms: 50, p95_ms: 100 },
          { name: 'attempt_history', status: 'measured', unit: 'ms', p50_ms: 0.03, p95_ms: 0.04 },
          { name: 'decision_history', status: 'measured', unit: 'ms', p50_ms: 0.03, p95_ms: 0.04 },
          { name: 'resume_projection', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'repeated_work_suppression', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'decision_reuse', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'verification_warnings', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'trace_template_completeness', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'resume_compression_fidelity', status: 'measured', unit: 'percent', success_rate: 100 },
        ],
      }, null, 2));

      const payload = await runLongitudinalEvaluation({
        phase1BaselinePath: baselinePath,
        phaseRunner: fakePhaseRunner(),
      });

      const phase1 = findPhase(payload.phase_summaries, 'phase1');
      expect(phase1.comparable_status).toBe('pass');
      expect(phase1.phase_status).toBe('pass');
      expect(payload.acceptance.phase8_status).toBe('pass');
      expect(getProcessOutcome(payload).exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('phase1 baseline fails when the phase1 baseline workload manifest is stale', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-phase8-stale-phase1-baseline-'));
    const baselinePath = join(dir, 'phase1-stale-baseline.json');

    try {
      writeFileSync(baselinePath, JSON.stringify({
        generated_at: '2026-04-19T00:00:00.000Z',
        engine: 'sqlite',
        workloads: [
          { name: 'task_resume', status: 'measured', unit: 'ms', p50_ms: 1.2, p95_ms: 1.5 },
          { name: 'attempt_history', status: 'measured', unit: 'ms', p50_ms: 0.03, p95_ms: 0.04 },
          { name: 'decision_history', status: 'measured', unit: 'ms', p50_ms: 0.03, p95_ms: 0.04 },
          { name: 'resume_projection', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'repeated_work_suppression', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'decision_reuse', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'verification_warnings', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'trace_template_completeness', status: 'measured', unit: 'percent', success_rate: 100 },
        ],
      }, null, 2));

      const payload = await runLongitudinalEvaluation({
        phase1BaselinePath: baselinePath,
        phaseRunner: fakePhaseRunner({ stalePhase1BaselinePath: baselinePath }),
      });
      const phase1 = findPhase(payload.phase_summaries, 'phase1');

      expect(phase1.comparable_status).toBe('fail');
      expect(phase1.phase_status).toBe('fail');
      expect(phase1.regression_reasons).toContain('readiness_not_pass');
      expect(payload.acceptance.phase8_status).toBe('fail');
      expect(getProcessOutcome(payload).exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exact-manifest regressions fail longitudinal acceptance', () => {
    expect(compareBenchmarkManifest(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(compareBenchmarkManifest(['a', 'b', 'b'], ['a', 'b'])).toBe(false);
    expect(compareBenchmarkManifest(['a', 'b', 'c'], ['a', 'b'])).toBe(false);

    const acceptance = evaluateLongitudinalAcceptance([
      {
        phase: 'phase1',
        baseline_family: 'repeated_work',
        comparable_status: 'pass',
        readiness_status: 'pass',
        phase_status: 'pass',
        benchmark_names: ['task_resume'],
        regression_reasons: [],
      },
      {
        phase: 'phase2',
        baseline_family: 'context_map',
        comparable_status: 'fail',
        readiness_status: 'fail',
        phase_status: 'fail',
        benchmark_names: ['note_manifest'],
        regression_reasons: ['benchmark_manifest_mismatch'],
      },
    ]);

    expect(acceptance.readiness_status).toBe('fail');
    expect(acceptance.phase8_status).toBe('fail');
  });

  test('regressions exit non-zero through the shared process path', () => {
    const proc = spawnSync(['bun', 'run', 'test/fixtures/phase8-longitudinal-regression-harness.ts'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(1);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(payload.acceptance.phase8_status).toBe('fail');

    const phase3 = payload.phase_summaries.find((summary: any) => summary.phase === 'phase3');
    expect(phase3.comparable_status).toBe('fail');
    expect(phase3.regression_reasons).toContain('benchmark_manifest_mismatch');
  });
});

function findPhase(
  summaries: Phase8LongitudinalPhaseSummary[],
  phase: Phase8LongitudinalPhaseSummary['phase'],
): Phase8LongitudinalPhaseSummary {
  const summary = summaries.find((entry) => entry.phase === phase);
  if (!summary) throw new Error(`missing phase summary: ${phase}`);
  return summary;
}

function fakePhaseRunner(options: { stalePhase1BaselinePath?: string } = {}): PhaseRunner {
  return ({ definition, phase1BaselinePath }) => {
    if (definition.phase === 'phase1' && phase1BaselinePath === options.stalePhase1BaselinePath) {
      return summary(definition.phase, definition.baseline_family, 'fail', 'fail', 'fail', definition.expected_benchmark_names, [
        'readiness_not_pass',
        'phase_status_not_pass',
      ]);
    }
    if (definition.phase === 'phase1' && phase1BaselinePath === null) {
      return summary(definition.phase, definition.baseline_family, 'pending_baseline', 'pass', 'pending_baseline', definition.expected_benchmark_names, [
        'missing_phase1_baseline',
      ]);
    }
    return summary(definition.phase, definition.baseline_family, 'pass', 'pass', 'pass', definition.expected_benchmark_names, []);
  };
}

function summary(
  phase: (typeof PHASE_DEFINITIONS)[number]['phase'],
  baselineFamily: string,
  comparableStatus: Phase8LongitudinalPhaseSummary['comparable_status'],
  readinessStatus: Phase8LongitudinalPhaseSummary['readiness_status'],
  phaseStatus: Phase8LongitudinalPhaseSummary['phase_status'],
  benchmarkNames: string[],
  regressionReasons: string[],
): Phase8LongitudinalPhaseSummary {
  return {
    phase,
    baseline_family: baselineFamily,
    comparable_status: comparableStatus,
    readiness_status: readinessStatus,
    phase_status: phaseStatus,
    benchmark_names: benchmarkNames,
    regression_reasons: regressionReasons,
  };
}
