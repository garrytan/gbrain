import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 context-map benchmark', () => {
  test('--json prints a context-map benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-context-map.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'context_map_build',
      'context_map_correctness',
      'context_map_get',
      'context_map_list',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');
  });
});
