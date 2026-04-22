import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 acceptance-pack benchmark', () => {
  test('--json prints a phase2 acceptance summary shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-acceptance-pack.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

    expect(payload.phase).toBe('phase2');
    expect(Array.isArray(payload.benchmarks)).toBe(true);
    expect(payload.benchmarks.length).toBeGreaterThan(0);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');
  });
});
