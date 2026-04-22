import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 structural paths benchmark', () => {
  test('--json prints a structural-path benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-structural-paths.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'structural_graph_build',
      'structural_neighbors',
      'structural_path',
      'structural_path_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');
  });
});
