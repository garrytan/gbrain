import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK_PROCESS_TIMEOUT_MS = 30_000;

describe('phase8 acceptance-pack benchmark', () => {
  test('--json prints a pending-baseline phase8 acceptance summary by default', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase8-acceptance-pack.ts', '--json'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

    expect(payload.phase).toBe('phase8');
    expect(payload.benchmarks.map((benchmark: any) => benchmark.name)).toEqual([
      'longitudinal_evaluation',
      'dream_cycle',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pending_baseline');
    expect(payload.acceptance.phase8_status).toBe('pending_baseline');
  }, BENCHMARK_PROCESS_TIMEOUT_MS);

  test('--phase1-baseline enables full phase8 acceptance pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-phase8-acceptance-baseline-'));
    const baselinePath = join(dir, 'phase1-baseline.json');

    try {
      writeFileSync(baselinePath, JSON.stringify({
        generated_at: '2026-04-19T00:00:00.000Z',
        engine: 'sqlite',
        workloads: [
          { name: 'task_resume', status: 'measured', unit: 'ms', p50_ms: 1.2, p95_ms: 1.5 },
          { name: 'attempt_history', status: 'measured', unit: 'ms', p50_ms: 0.03, p95_ms: 0.04 },
          { name: 'decision_history', status: 'measured', unit: 'ms', p50_ms: 0.03, p95_ms: 0.04 },
          { name: 'resume_projection', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'repeated_work_suppression', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'decision_reuse', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'verification_warnings', status: 'measured', unit: 'percent', success_rate: 100 },
          { name: 'trace_template_completeness', status: 'measured', unit: 'percent', success_rate: 100 },
        ],
      }, null, 2));

      const proc = spawnSync([
        'bun',
        'run',
        'scripts/bench/phase8-acceptance-pack.ts',
        '--json',
        '--phase1-baseline',
        baselinePath,
      ], {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(proc.exitCode).toBe(0);
      const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

      expect(payload.acceptance.readiness_status).toBe('pass');
      expect(payload.acceptance.phase8_status).toBe('pass');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, BENCHMARK_PROCESS_TIMEOUT_MS);

  test('--phase1-baseline without a path fails fast', () => {
    const proc = spawnSync([
      'bun',
      'run',
      'scripts/bench/phase8-acceptance-pack.ts',
      '--json',
      '--phase1-baseline',
    ], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(1);
    expect(new TextDecoder().decode(proc.stderr)).toContain('--phase1-baseline requires a non-empty path value');
  });
});
