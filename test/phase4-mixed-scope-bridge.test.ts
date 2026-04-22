import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase4 mixed-scope-bridge benchmark', () => {
  test('--json prints a phase4 mixed-scope-bridge benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase4-mixed-scope-bridge.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'mixed_scope_bridge',
      'mixed_scope_bridge_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase4_status).toBe('pass');
  });
});
