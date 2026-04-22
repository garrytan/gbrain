import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 note-sections benchmark', () => {
  test('--json prints a phase2 section benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-note-sections.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

    const names = payload.workloads.map((workload: any) => workload.name).sort();
    expect(names).toEqual([
      'section_get',
      'section_list',
      'section_projection',
      'section_rebuild',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');
  });
});
