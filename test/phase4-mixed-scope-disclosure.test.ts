import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase4 mixed-scope-disclosure benchmark', () => {
  test('--json prints a phase4 mixed-scope-disclosure benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase4-mixed-scope-disclosure.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

    expect(payload.phase).toBe('phase4');
    expect(payload.workloads.map((workload: any) => workload.name).sort()).toEqual([
      'mixed_scope_disclosure',
      'mixed_scope_disclosure_correctness',
    ]);

    const correctnessWorkload = payload.workloads.find(
      (workload: any) => workload.name === 'mixed_scope_disclosure_correctness',
    );
    expect(correctnessWorkload.success_rate).toBe(100);

    const correctnessCheck = payload.acceptance.checks.find(
      (check: any) => check.name === 'mixed_scope_disclosure_correctness_success_rate',
    );
    expect(correctnessCheck.status).toBe('pass');

    const latencyCheck = payload.acceptance.checks.find(
      (check: any) => check.name === 'mixed_scope_disclosure_p95_ms',
    );
    expect(latencyCheck.threshold.value).toBe(100);
    expect(typeof latencyCheck.actual).toBe('number');
    expect(['pass', 'fail']).toContain(latencyCheck.status);
    expect(['pass', 'fail']).toContain(payload.acceptance.readiness_status);
    expect(['pass', 'fail']).toContain(payload.acceptance.phase4_status);
  });
});
