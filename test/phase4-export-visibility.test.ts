import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase4 export-visibility benchmark', () => {
  test('--json prints a phase4 export-visibility benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase4-export-visibility.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    const names = payload.workloads.map((workload: any) => workload.name).sort();

    expect(names).toEqual([
      'personal_export_visibility',
      'personal_export_visibility_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase4_status).toBe('pass');
  });
});
