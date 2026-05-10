import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('phase1 operational-memory benchmark', () => {
  test('--help prints usage', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase1-operational-memory.ts', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toContain(
      'Usage: bun run scripts/bench/phase1-operational-memory.ts',
    );
  });

  test('--json prints a phase1 benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase1-operational-memory.ts', '--json'], {
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
      'attempt_history',
      'decision_history',
      'decision_reuse',
      'repeated_work_suppression',
      'resume_projection',
      'task_resume',
      'trace_template_completeness',
      'verification_warnings',
    ]);

    for (const workload of payload.workloads) {
      expect(workload.status).toBe('measured');
      if (workload.unit === 'ms') {
        expect(typeof workload.p50_ms).toBe('number');
        expect(typeof workload.p95_ms).toBe('number');
        expect(workload.p50_ms).toBeGreaterThan(0);
        expect(workload.p95_ms).toBeGreaterThanOrEqual(workload.p50_ms);
      }

      if (workload.name === 'resume_projection') {
        expect(workload.unit).toBe('percent');
        expect(typeof workload.success_rate).toBe('number');
        expect(workload.success_rate).toBe(100);
      }

      if (workload.name === 'repeated_work_suppression') {
        expect(workload.unit).toBe('percent');
        expect(typeof workload.success_rate).toBe('number');
        expect(workload.success_rate).toBe(100);
      }

      if (workload.name === 'trace_template_completeness') {
        expect(workload.unit).toBe('percent');
        expect(typeof workload.success_rate).toBe('number');
        expect(workload.success_rate).toBe(100);
      }

      if (workload.name === 'decision_reuse') {
        expect(workload.unit).toBe('percent');
        expect(typeof workload.success_rate).toBe('number');
        expect(workload.success_rate).toBe(100);
      }

      if (workload.name === 'verification_warnings') {
        expect(workload.unit).toBe('percent');
        expect(typeof workload.success_rate).toBe('number');
        expect(workload.success_rate).toBe(100);
      }
    }

    expect(payload.acceptance).toHaveProperty('thresholds');
    expect(Array.isArray(payload.acceptance.checks)).toBe(true);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase1_status).toBe('pending_baseline');

    const checkNames = payload.acceptance.checks.map((check: any) => check.name).sort();
    expect(checkNames).toEqual([
      'attempt_history_p95_ms',
      'decision_history_p95_ms',
      'decision_reuse_success_rate',
      'primary_improvement_threshold',
      'repeated_work_suppression_success_rate',
      'resume_projection_success_rate',
      'task_resume_p95_ms',
      'trace_template_completeness_success_rate',
      'verification_warnings_success_rate',
    ]);

    const pendingCheck = payload.acceptance.checks.find((check: any) => check.name === 'primary_improvement_threshold');
    expect(pendingCheck.status).toBe('pending_baseline');
    expect(typeof pendingCheck.reason).toBe('string');
    expect(pendingCheck.reason.length).toBeGreaterThan(0);
  });

  test('--baseline enables full phase1 acceptance evaluation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-phase1-baseline-'));
    const baselinePath = join(dir, 'baseline.json');

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
        'scripts/bench/phase1-operational-memory.ts',
        '--json',
        '--baseline',
        baselinePath,
      ], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(proc.exitCode).toBe(0);
      const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
      expect(payload.acceptance.phase1_status).toBe('pass');

      const primaryCheck = payload.acceptance.checks.find(
        (check: any) => check.name === 'primary_improvement_threshold',
      );
      expect(primaryCheck.status).toBe('pass');
      expect(typeof primaryCheck.actual).toBe('number');
      expect(primaryCheck.actual).toBeGreaterThanOrEqual(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--write-baseline persists the benchmark payload to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-phase1-write-baseline-'));
    const baselinePath = join(dir, 'written-baseline.json');

    try {
      const proc = spawnSync([
        'bun',
        'run',
        'scripts/bench/phase1-operational-memory.ts',
        '--json',
        '--write-baseline',
        baselinePath,
      ], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(proc.exitCode).toBe(0);
      const stdoutPayload = JSON.parse(new TextDecoder().decode(proc.stdout));
      const filePayload = JSON.parse(readFileSync(baselinePath, 'utf-8'));

      expect(filePayload.engine).toBe(stdoutPayload.engine);
      expect(filePayload.workloads.map((workload: any) => workload.name).sort()).toEqual(
        stdoutPayload.workloads.map((workload: any) => workload.name).sort(),
      );
      expect(filePayload.acceptance.phase1_status).toBe(stdoutPayload.acceptance.phase1_status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
