import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  compareBenchmarkManifest,
  evaluateLongitudinalAcceptance,
} from '../scripts/bench/phase8-longitudinal-evaluation.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK_PROCESS_TIMEOUT_MS = 30_000;

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

  test('--json prints a pending-baseline longitudinal summary without a phase1 baseline artifact', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase8-longitudinal-evaluation.ts', '--json'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

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

    const phase1 = payload.phase_summaries.find((summary: any) => summary.phase === 'phase1');
    expect(phase1.comparable_status).toBe('pending_baseline');
    expect(phase1.readiness_status).toBe('pass');
    expect(phase1.phase_status).toBe('pending_baseline');

    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase8_status).toBe('pending_baseline');
  }, BENCHMARK_PROCESS_TIMEOUT_MS);

  test('--phase1-baseline makes the longitudinal pack fully comparable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-phase8-phase1-baseline-'));
    const baselinePath = join(dir, 'phase1-baseline.json');

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

      const proc = spawnSync([
        'bun',
        'run',
        'scripts/bench/phase8-longitudinal-evaluation.ts',
        '--json',
        '--phase1-baseline',
        baselinePath,
      ], {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(proc.exitCode).toBe(0);
      const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

      const phase1 = payload.phase_summaries.find((summary: any) => summary.phase === 'phase1');
      expect(phase1.comparable_status).toBe('pass');
      expect(phase1.phase_status).toBe('pass');
      expect(payload.acceptance.phase8_status).toBe('pass');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, BENCHMARK_PROCESS_TIMEOUT_MS);

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
