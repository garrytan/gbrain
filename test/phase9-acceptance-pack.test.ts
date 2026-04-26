import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('phase9 acceptance-pack benchmark', () => {
  test('--json prints a passing phase9 acceptance summary', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase9-acceptance-pack.ts', '--json'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

    expect(payload.phase).toBe('phase9');
    expect(payload.benchmarks.map((benchmark: any) => benchmark.name)).toEqual([
      'mutation_ledger',
      'session_access',
      'redaction_plan',
      'memory_operations_health',
    ]);
    expect(payload.benchmarks.every((benchmark: any) => benchmark.status === 'pass')).toBe(true);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase9_status).toBe('pass');
  });
});
