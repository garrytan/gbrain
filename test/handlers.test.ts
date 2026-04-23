/**
 * Tests for registerBuiltinHandlers in src/commands/jobs.ts.
 *
 * Covers:
 *   - Every expected handler name is registered.
 *   - autopilot-cycle handler returns { partial, status, report } (v0.17
 *     runCycle-backed shape) when any step fails — does NOT throw itself
 *     (critical invariant: an intermittent phase failure must not cause
 *     the Minion to retry and block every future cycle).
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;
let worker: MinionWorker;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  worker = new MinionWorker(engine, { queue: 'test' });
  await registerBuiltinHandlers(worker, engine);
}, 30_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('registerBuiltinHandlers', () => {
  test('registers all built-in handler names', () => {
    const names = worker.registeredNames;
    // Existing handlers from pre-v0.11.1
    expect(names).toContain('sync');
    expect(names).toContain('embed');
    expect(names).toContain('lint');
    expect(names).toContain('import');
    // New in v0.11.1 (Tier 1 + autopilot-cycle)
    expect(names).toContain('extract');
    expect(names).toContain('backlinks');
    expect(names).toContain('autopilot-cycle');
  });

  test('total handler count includes all 7 names', () => {
    expect(worker.registeredNames.length).toBeGreaterThanOrEqual(7);
  });
});

describe('autopilot-cycle handler — partial failure does NOT throw', () => {
  test('phase failure returns partial:true + structured report, no throw', async () => {
    // Call the handler directly with a job pointing at a nonexistent repo.
    // Filesystem-dependent phases (lint, backlinks, sync) all fail because
    // the dir / .git repo isn't there. DB-dependent phases (extract,
    // embed, orphans) run fine against the in-memory test engine.
    //
    // CRITICAL INVARIANT: the handler must return successfully even when
    // phases fail. Throwing would cause the Minion to retry, blocking
    // every future cycle on an intermittent bug. v0.17 moves this
    // guarantee into runCycle itself (per-phase try/catch in cycle.ts).
    const handler = (worker as any).handlers.get('autopilot-cycle');
    expect(handler).toBeDefined();

    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-autopilot-test' },
      signal: { aborted: false } as any,
      job: { id: 1, name: 'autopilot-cycle' } as any,
    });

    expect(result).toBeDefined();
    expect((result as any).partial).toBe(true);
    // v0.17 shape: { partial, status, report }. The report's phases array
    // replaces the old failed_steps list.
    expect(['partial', 'failed']).toContain((result as any).status);
    const report = (result as any).report;
    expect(report).toBeDefined();
    expect(report.schema_version).toBe('1');
    expect(Array.isArray(report.phases)).toBe(true);
    // The filesystem-dependent phases should have failed on a missing dir.
    const failedPhases = report.phases
      .filter((p: any) => p.status === 'fail')
      .map((p: any) => p.phase);
    expect(failedPhases).toContain('lint');
    expect(failedPhases).toContain('backlinks');
    expect(failedPhases).toContain('sync');
  });

  test('all phases succeed → result has structured report (smoke)', async () => {
    // Smoke: invoke against a real (if empty) git repo. If every phase
    // completes (or gracefully skips), the handler returns a result
    // object with the full runCycle report. Some phases may still warn
    // (empty repo has nothing to lint/sync) — the invariant is that the
    // handler never throws.
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-autopilot-cycle-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m init', { cwd: dir, stdio: 'pipe' });

      const handler = (worker as any).handlers.get('autopilot-cycle');
      const result = await handler({
        data: { repoPath: dir },
        signal: { aborted: false } as any,
        job: { id: 2, name: 'autopilot-cycle' } as any,
      });
      // The handler MUST return a result object, never throw, regardless
      // of individual phase outcomes.
      expect(result).toBeDefined();
      expect(typeof (result as any).partial).toBe('boolean');
      expect('report' in (result as any)).toBe(true);
      expect((result as any).report.schema_version).toBe('1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
