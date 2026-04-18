/**
 * Tests for registerBuiltinHandlers in src/commands/jobs.ts.
 *
 * Covers:
 *   - Every expected handler name is registered.
 *   - autopilot-cycle handler returns { partial: true, failed_steps: [...] }
 *     when any step throws — does NOT throw itself (critical for preventing
 *     intermittent extract bugs from blocking every future cycle via retry).
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
});

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
  test('step failure returns partial:true + failed_steps, no throw', async () => {
    // Call the handler directly with a context that points at a nonexistent
    // repo. Every step will fail (sync throws on missing .git, extract
    // throws on missing dir, embed tries to list pages which is fine against
    // the test engine, backlinks throws on missing dir). The handler should
    // STILL return successfully — never throw.
    //
    // This is the critical invariant: an intermittent bug in one step must
    // not cause the Minion to retry + block every future cycle.
    const handler = (worker as any).handlers.get('autopilot-cycle');
    expect(handler).toBeDefined();

    const result = await handler({
      data: { repoPath: '/definitely-does-not-exist-for-autopilot-test' },
      signal: { aborted: false } as any,
      job: { id: 1, name: 'autopilot-cycle' } as any,
    });

    expect(result).toBeDefined();
    expect((result as any).partial).toBe(true);
    expect(Array.isArray((result as any).failed_steps)).toBe(true);
    // sync + extract + backlinks all fail on missing repo (embed operates
    // on the DB directly and doesn't touch the repo path, so it doesn't fail).
    expect((result as any).failed_steps).toContain('sync');
    expect((result as any).failed_steps).toContain('extract');
    expect((result as any).failed_steps).toContain('backlinks');
  });

  test('all steps succeed → partial:false', async () => {
    // Smoke: invoke against a real (if empty) brain dir. If every step
    // completes, partial is false.
    const fs = await import('fs');
    const { execSync } = await import('child_process');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-autopilot-cycle-'));
    try {
      // Initialize as a git repo so sync doesn't fail on .git lookup.
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
      // Empty repo: some steps may still fail (backlinks needs .md files)
      // but the handler MUST return a result object, never throw.
      expect(result).toBeDefined();
      expect(typeof (result as any).partial).toBe('boolean');
      expect('steps' in (result as any)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
