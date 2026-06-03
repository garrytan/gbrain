import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  getProcessOutcome,
  runPhase8AcceptancePack,
  type Phase8AcceptanceBenchmarkRunner,
  type Phase8BenchmarkSummary,
} from '../scripts/bench/phase8-acceptance-pack.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('phase8 acceptance-pack benchmark', () => {
  test('--json prints a pending-baseline phase8 acceptance summary by default', () => {
    const payload = runPhase8AcceptancePack({ benchmarkRunner: fakeBenchmarkRunner() });

    expect(payload.phase).toBe('phase8');
    expect(payload.benchmarks.map((benchmark: any) => benchmark.name)).toEqual([
      'longitudinal_evaluation',
      'dream_cycle',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pending_baseline');
    expect(payload.acceptance.phase8_status).toBe('pending_baseline');
    expect(getProcessOutcome(payload).exitCode).toBe(0);
  });

  test('--phase1-baseline enables full phase8 acceptance pass', () => {
    const baselinePath = '/tmp/phase1-baseline.json';
    const seenBaselinePaths: Array<string | null> = [];

    const payload = runPhase8AcceptancePack({
      phase1BaselinePath: baselinePath,
      benchmarkRunner: ({ benchmark, phase1BaselinePath }) => {
        seenBaselinePaths.push(phase1BaselinePath);
        return summary(benchmark.name, 'pass', 'pass');
      },
    });

    expect(seenBaselinePaths).toEqual([baselinePath, baselinePath]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase8_status).toBe('pass');
  });

  test('--phase1-baseline without a path fails fast', () => {
    const proc = spawnSync([
      'bun',
      'run',
      'scripts/bench/phase8-acceptance-pack.ts',
      '--json',
      '--phase1-baseline',
    ], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(1);
    expect(new TextDecoder().decode(proc.stderr)).toContain('--phase1-baseline requires a non-empty path value');
  });
});

function fakeBenchmarkRunner(): Phase8AcceptanceBenchmarkRunner {
  return ({ benchmark, phase1BaselinePath }) => {
    if (benchmark.name === 'longitudinal_evaluation' && phase1BaselinePath === null) {
      return summary(benchmark.name, 'pending_baseline', 'pending_baseline');
    }
    return summary(benchmark.name, 'pass', 'pass');
  };
}

function summary(
  name: Phase8BenchmarkSummary['name'],
  readinessStatus: Phase8BenchmarkSummary['readiness_status'],
  phase8Status: Phase8BenchmarkSummary['phase8_status'],
): Phase8BenchmarkSummary {
  return {
    name,
    readiness_status: readinessStatus,
    phase8_status: phase8Status,
  };
}
