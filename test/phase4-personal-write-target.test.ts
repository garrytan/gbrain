import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase4 personal-write-target benchmark', () => {
  test('--json prints a phase4 personal-write-target benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase4-personal-write-target.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'personal_write_target',
      'personal_write_target_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase4_status).toBe('pass');
  });
});
