import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 note-manifest benchmark', () => {
  test('--help prints usage', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-note-manifest.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toContain(
      'Usage: bun run scripts/bench/phase2-note-manifest.ts',
    );
  });

  test('--json prints a phase2 benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-note-manifest.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(payload).toHaveProperty('generated_at');
    expect(payload).toHaveProperty('engine');
    expect(Array.isArray(payload.workloads)).toBe(true);
    expect(payload).toHaveProperty('acceptance');

    const names = payload.workloads.map((workload: any) => workload.name).sort();
    expect(names).toEqual([
      'manifest_get',
      'manifest_list',
      'manifest_rebuild',
      'structural_projection',
    ]);

    for (const workload of payload.workloads) {
      expect(workload.status).toBe('measured');
      if (workload.unit === 'ms') {
        expect(typeof workload.p50_ms).toBe('number');
        expect(typeof workload.p95_ms).toBe('number');
        expect(workload.p50_ms).toBeGreaterThan(0);
        expect(workload.p95_ms).toBeGreaterThanOrEqual(workload.p50_ms);
      }

      if (workload.name === 'structural_projection') {
        expect(workload.unit).toBe('percent');
        expect(typeof workload.success_rate).toBe('number');
        expect(workload.success_rate).toBe(100);
      }
    }

    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');

    const checkNames = payload.acceptance.checks.map((check: any) => check.name).sort();
    expect(checkNames).toEqual([
      'manifest_get_p95_ms',
      'manifest_list_p95_ms',
      'manifest_rebuild_p95_ms',
      'structural_projection_success_rate',
    ]);
  });
});
