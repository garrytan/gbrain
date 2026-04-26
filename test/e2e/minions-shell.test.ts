/**
 * E2E Minions Shell Handler Tests — exercises the full lifecycle against real
 * Postgres: submit → worker claims → spawn → result → status flip.
 *
 * Unit tests in test/minions-shell.test.ts cover the handler in detail
 * (validation, env allowlist, abort, SIGTERM grace, audit log). These E2E
 * tests prove the wiring against real Postgres works end-to-end.
 *
 * Run: DATABASE_URL=... bun test test/e2e/minions-shell.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getConn, getEngine } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { shellHandler } from '../../src/core/minions/handlers/shell.ts';
import { runMigrations } from '../../src/core/migrate.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E minions shell tests (DATABASE_URL not set)');
}

async function makeEngine(): Promise<PostgresEngine> {
  const url = process.env.DATABASE_URL!;
  const e = new PostgresEngine();
  await e.connect({ engine: 'postgres', database_url: url, poolSize: 4 });
  return e;
}

async function waitTerminal(queue: MinionQueue, id: number, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = await queue.getJob(id);
    if (j && ['completed', 'failed', 'dead', 'cancelled'].includes(j.status)) return j.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  const j = await queue.getJob(id);
  throw new Error(`job ${id} did not reach terminal state in ${timeoutMs}ms; last status=${j?.status}`);
}

describeE2E('E2E: Minions shell handler', () => {
  let originalAllowShellJobs: string | undefined;

  beforeAll(async () => {
    // The shell handler refuses to run unless GBRAIN_ALLOW_SHELL_JOBS=1 is
    // set on the worker process (defense-in-depth: the env var is the
    // operator-trust gate, separate from the trusted-add allowProtectedSubmit
    // flag). The PGLite sibling test sets this in its beforeAll for the same
    // reason; without it shell jobs land in `dead`.
    originalAllowShellJobs = process.env.GBRAIN_ALLOW_SHELL_JOBS;
    process.env.GBRAIN_ALLOW_SHELL_JOBS = '1';
    await setupDB();
    await runMigrations(getEngine());
  });

  afterAll(async () => {
    await teardownDB();
    if (originalAllowShellJobs === undefined) {
      delete process.env.GBRAIN_ALLOW_SHELL_JOBS;
    } else {
      process.env.GBRAIN_ALLOW_SHELL_JOBS = originalAllowShellJobs;
    }
  });

  beforeEach(async () => {
    const conn = getConn();
    await conn.unsafe(`TRUNCATE minion_attachments, minion_inbox, minion_jobs RESTART IDENTITY CASCADE`);
  });

  test('CLI submit → worker claims → shell runs → completes', async () => {
    const engine = await makeEngine();
    try {
      const queue = new MinionQueue(engine);
      const job = await queue.add('shell',
        { cmd: 'echo hello', cwd: '/tmp' },
        {},
        { allowProtectedSubmit: true },
      );
      expect(job.name).toBe('shell');

      const worker = new MinionWorker(engine, { pollInterval: 100, lockDuration: 30000 });
      worker.register('shell', shellHandler);
      const runPromise = worker.start();

      try {
        // 20s tolerates DB warmup variance when run after other E2E files
        const status = await waitTerminal(queue, job.id, 20000);
        expect(status).toBe('completed');
        const final = await queue.getJob(job.id);
        expect((final!.result as any).exit_code).toBe(0);
        expect((final!.result as any).stdout_tail).toBe('hello\n');
      } finally {
        worker.stop();
        await runPromise;
      }
    } finally {
      await engine.disconnect();
    }
  }, 45000);

  test('MinionQueue.add("shell",...) without trusted arg → throws (defense-in-depth)', async () => {
    const engine = await makeEngine();
    try {
      const queue = new MinionQueue(engine);
      await expect(queue.add('shell', { cmd: 'echo ok', cwd: '/tmp' })).rejects.toThrow(/protected job name/);
      // Whitespace bypass defense (Codex #1)
      await expect(queue.add(' shell ', { cmd: 'echo ok', cwd: '/tmp' })).rejects.toThrow(/protected job name/);
    } finally {
      await engine.disconnect();
    }
  });

  test('submit_job with ctx.remote=true rejects shell (MCP guard)', async () => {
    const engine = await makeEngine();
    try {
      // Invoke submit_job operation directly with remote=true
      const { operations } = await import('../../src/core/operations.ts');
      const submitJob = operations.find((op: { name: string }) => op.name === 'submit_job')!;
      await expect(
        submitJob.handler(
          { engine, remote: true, dryRun: false } as any,
          { name: 'shell', data: { cmd: 'echo hi', cwd: '/tmp' } },
        ),
      ).rejects.toThrow(/permission_denied|cannot be submitted over MCP/i);
    } finally {
      await engine.disconnect();
    }
  });

  test('submit_job with ctx.remote=false allows shell (CLI path)', async () => {
    const engine = await makeEngine();
    try {
      const { operations } = await import('../../src/core/operations.ts');
      const submitJob = operations.find((op: { name: string }) => op.name === 'submit_job')!;
      const result = await submitJob.handler(
        { engine, remote: false, dryRun: false } as any,
        { name: 'shell', data: { cmd: 'echo hi', cwd: '/tmp' } },
      );
      expect((result as any).name).toBe('shell');
      expect((result as any).status).toBe('waiting');
    } finally {
      await engine.disconnect();
    }
  });
});
