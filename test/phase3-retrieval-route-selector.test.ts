import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase3 retrieval-route-selector benchmark', () => {
  test('--json prints a retrieval-route-selector benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase3-retrieval-route-selector.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'retrieval_route_selector',
      'retrieval_route_selector_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase3_status).toBe('pass');
  });
});
