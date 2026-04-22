import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase3 context-map-path benchmark', () => {
  test('--json prints a context-map-path benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase3-context-map-path.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'context_map_path',
      'context_map_path_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase3_status).toBe('pass');
  });
});
