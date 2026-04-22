import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 context-atlas-select benchmark', () => {
  test('--json prints a context-atlas-select benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-context-atlas-select.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'context_atlas_select',
      'context_atlas_select_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');
  });
});
