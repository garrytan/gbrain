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
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase4_status).toBe('pass');
  });
});
