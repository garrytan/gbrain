/**
 * E2E Minions Shell Handler — PGLite / --follow inline execution path
 *
 * Closes the T4 gap surfaced during PR #381 eng review. The sibling file
 * test/e2e/minions-shell.test.ts covers the Postgres + persistent-worker-daemon
 * path. This file covers the PGLite path documented in the minion-orchestrator
 * skill: `gbrain jobs submit shell ... --follow` runs inline because
 * `gbrain jobs work` (daemon) is not available on PGLite (exclusive file lock).
 *
 * Mirrors the Postgres test's structure but runs in-memory against PGLiteEngine.
 * No DATABASE_URL required, no Docker — runs in CI unconditionally.
 *
 * Run: bun test test/e2e/minions-shell-pglite.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../../src/commands/jobs.ts';

let engine: PGLiteEngine;
let originalAllowShellJobs: string | undefined;

async function waitTerminal(queue: MinionQueue, id: number, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = await queue.getJob(id);
    if (j && ['completed', 'failed', 'dead', 'cancelled'].includes(j.status)) return j.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  const j = await queue.getJob(id);
  throw new Error(`job ${id} did not reach terminal state in ${timeoutMs}ms; last status=${j?.status}`);
}

beforeAll(async () => {
  // registerBuiltinHandlers gates shell handler on GBRAIN_ALLOW_SHELL_JOBS=1.
  // Mirror the real --follow path by setting the env var; restore on cleanup
  // so other tests see their original environment.
  originalAllowShellJobs = process.env.GBRAIN_ALLOW_SHELL_JOBS;
  process.env.GBRAIN_ALLOW_SHELL_JOBS = '1';

  engine = new PGLiteEngine();
  await engine.connect({}); // in-memory PGLite
  await engine.initSchema(); // installs pages, minion_jobs, config, etc.
});

afterAll(async () => {
  await engine.disconnect();
  if (originalAllowShellJobs === undefined) {
    delete process.env.GBRAIN_ALLOW_SHELL_JOBS;
  } else {
    process.env.GBRAIN_ALLOW_SHELL_JOBS = originalAllowShellJobs;
  }
});

describe('E2E: Minions shell handler on PGLite (--follow inline path)', () => {
  // Mirror the Postgres sibling's per-test reset. The engine is shared across
  // both tests via beforeAll; without this, completed jobs from one test leak
  // into minion_jobs and future test additions hit order-dependency.
  beforeEach(async () => {
    const db = (engine as any).db;
    await db.exec(`DELETE FROM minion_attachments; DELETE FROM minion_inbox; DELETE FROM minion_jobs;`);
  });

  test('submit → worker registered via registerBuiltinHandlers → shell runs → completes', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add(
      'shell',
      { cmd: 'echo hello', cwd: '/tmp' },
      {},
      { allowProtectedSubmit: true },
    );
    expect(job.name).toBe('shell');
    expect(job.status).toBe('waiting');

    // This is the exact dispatch path --follow takes (src/commands/jobs.ts:207).
    // Gates shell on GBRAIN_ALLOW_SHELL_JOBS=1 (set in beforeAll above).
    const worker = new MinionWorker(engine, { pollInterval: 100, lockDuration: 30000 });
    await registerBuiltinHandlers(worker, engine);
    expect(worker.registeredNames).toContain('shell');

    const runPromise = worker.start();
    try {
      const status = await waitTerminal(queue, job.id, 20000);
      expect(status).toBe('completed');
      const final = await queue.getJob(job.id);
      expect((final!.result as any).exit_code).toBe(0);
      expect((final!.result as any).stdout_tail).toBe('hello\n');
    } finally {
      worker.stop();
      await runPromise;
    }
  }, 30000);

  test('GBRAIN_ALLOW_SHELL_JOBS unset → shellHandler rejects at execution time', async () => {
    // v0.20.3+: shell handler is always registered (so claimed jobs emit a clear
    // rejection log), but the runtime env guard lives inside the handler itself.
    // Prove the guard rejects when the env var is unset.
    const { shellHandler } = await import('../../src/core/minions/handlers/shell.ts');
    const saved = process.env.GBRAIN_ALLOW_SHELL_JOBS;
    delete process.env.GBRAIN_ALLOW_SHELL_JOBS;
    try {
      const ctx: any = {
        id: 1,
        name: 'shell',
        data: { cmd: 'echo hi', cwd: '/tmp' },
        attempt: 1,
        engine,
      };
      await expect(shellHandler(ctx)).rejects.toThrow(/GBRAIN_ALLOW_SHELL_JOBS=1/);
    } finally {
      process.env.GBRAIN_ALLOW_SHELL_JOBS = saved;
    }
  });
});
