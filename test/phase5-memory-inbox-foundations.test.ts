import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase5 memory-inbox-foundations benchmark', () => {
  test('--json prints a phase5 memory-inbox-foundations benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase5-memory-inbox-foundations.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

    expect(payload.phase).toBe('phase5');
    expect(payload.workloads.map((workload: any) => workload.name).sort()).toEqual([
      'memory_inbox_foundations',
      'memory_inbox_foundations_correctness',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase5_status).toBe('pass');
  });
});
