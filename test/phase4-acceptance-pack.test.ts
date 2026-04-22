import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase4 acceptance-pack benchmark', () => {
  test('--json prints a phase4 acceptance summary shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase4-acceptance-pack.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

    expect(payload.phase).toBe('phase4');
    expect(Array.isArray(payload.benchmarks)).toBe(true);
    expect(payload.benchmarks.length).toBeGreaterThan(0);
    expect(payload.benchmarks.map((benchmark: any) => benchmark.name).sort()).toEqual([
      'mixed_scope_bridge',
      'mixed_scope_disclosure',
      'personal_episode_lookup',
      'personal_export_visibility',
      'personal_profile_lookup',
      'personal_write_target',
      'scope_gate',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase4_status).toBe('pass');
  });
});
