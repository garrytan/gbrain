/**
 * #677 — serve-delegated sweep runner + autopilot PGLite install guard.
 *
 *   1. startDelegatedSweep runs a REAL runMaintenanceSweep against PGLite,
 *      polls to done, and returns a bounded SweepReport; busy/token-attach
 *      and source_mismatch semantics mirror the sync runner.
 *   2. pgliteDaemonGuardMessage refuses a PGLite daemon install (with
 *      guidance) unless --force; postgres installs are untouched.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  startDelegatedSweep,
  getDelegatedSweepStatus,
  __resetDelegatedSweepForTests,
} from '../src/core/serve-sweep-runner.ts';
import { pgliteDaemonGuardMessage } from '../src/commands/autopilot.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(() => {
  __resetDelegatedSweepForTests();
});

async function pollDone(jobId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = getDelegatedSweepStatus(jobId);
    expect(s.ok).toBe(true);
    if (s.state === 'done' || s.state === 'error') return s;
    if (Date.now() > deadline) throw new Error('sweep did not settle');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('#677 serve-sweep-runner', () => {
  test('runs a real sweep to done and returns the report', async () => {
    const start = startDelegatedSweep(engine, { budgetMs: 2000, batchLimit: 5 }, 'tok-1');
    expect(start.ok).toBe(true);
    expect(start.jobId).toBeDefined();

    const s = await pollDone(start.jobId!);
    expect(s.state).toBe('done');
    expect(s.report).toBeDefined();
    expect(typeof s.report!.durationMs).toBe('number');
    expect(Array.isArray(s.report!.skipped)).toBe(true);
  }, 60_000);

  test('token attach: same clientToken returns the retained terminal job', async () => {
    const start = startDelegatedSweep(engine, {}, 'tok-2');
    expect(start.ok).toBe(true);
    await pollDone(start.jobId!);

    const retry = startDelegatedSweep(engine, {}, 'tok-2');
    expect(retry.ok).toBe(true);
    expect(retry.jobId).toBe(start.jobId);
    expect(retry.completed).toBe(true);
  }, 60_000);

  test('invalid options refuse fail-closed', () => {
    const r = startDelegatedSweep(engine, { repoPath: '/etc' }, 'tok-3');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_options:repoPath');
  });

  test('bound source mismatch refuses', () => {
    const r = startDelegatedSweep(engine, { sourceId: 'other-src' }, 'tok-4', {
      boundSourceId: 'bound-src',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('source_mismatch');
  });

  test('unknown job id → unknown_job', () => {
    const s = getDelegatedSweepStatus('nope');
    expect(s.ok).toBe(false);
    expect(s.error).toBe('unknown_job');
  });
});

describe('#677 autopilot PGLite install guard', () => {
  test('PGLite without --force refuses with guidance', () => {
    const msg = pgliteDaemonGuardMessage('pglite', false);
    expect(msg).not.toBeNull();
    expect(msg).toContain('single-writer');
    expect(msg).toContain('gbrain serve');
    expect(msg).toContain('--force');
  });

  test('PGLite with --force proceeds; postgres always proceeds', () => {
    expect(pgliteDaemonGuardMessage('pglite', true)).toBeNull();
    expect(pgliteDaemonGuardMessage('postgres', false)).toBeNull();
  });
});
