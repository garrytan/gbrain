import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 workspace-orientation-bundle benchmark', () => {
  test('--json prints a workspace-orientation-bundle benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-workspace-orientation-bundle.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'workspace_orientation_bundle',
      'workspace_orientation_bundle_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');
  });
});
