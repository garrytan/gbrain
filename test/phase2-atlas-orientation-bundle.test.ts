import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 atlas-orientation-bundle benchmark', () => {
  test('--json prints an atlas-orientation-bundle benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-atlas-orientation-bundle.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'atlas_orientation_bundle',
      'atlas_orientation_bundle_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');
  });
});
