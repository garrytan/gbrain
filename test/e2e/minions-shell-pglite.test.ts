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
}, 30000);

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

  test('v0.35.8.0: inherit:["database_url"] resolves DATABASE_URL into child env, names-only in row + audit', async () => {
    // Hermetic — drive `inherit` directly against the PGLite path. The
    // production submit flow runs `validateShellJobParams` pre-enqueue, but
    // here we exercise the handler-side resolution by submitting a row that
    // already passed pre-enqueue validation upstream. Validates that:
    //   1. The child env carries GBRAIN_DATABASE_URL with the resolved value.
    //   2. The persisted row's `data.inherit` is ["database_url"] (names only).
    //   3. The persisted row JSON does NOT contain the URL substring anywhere.
    const { writeFileSync, mkdirSync, rmSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpHome = join(tmpdir(), `gbrain-inh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
    const testDbUrl = 'postgresql://test:T0P_5ECR3T@localhost:5432/inherit_e2e_db';
    writeFileSync(
      join(tmpHome, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: testDbUrl }) + '\n',
    );

    const savedHome = process.env.GBRAIN_HOME;
    const savedGbrainUrl = process.env.GBRAIN_DATABASE_URL;
    const savedDbUrl = process.env.DATABASE_URL;
    process.env.GBRAIN_HOME = tmpHome;
    // loadConfig() merges env vars OVER config.json, so we must drop both env
    // names while the worker reads its own config. When the E2E suite runs
    // with a real DATABASE_URL set in the parent process, the inherited value
    // would otherwise be the suite's postgres URL, not the test's.
    delete process.env.GBRAIN_DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      const queue = new MinionQueue(engine);
      const job = await queue.add(
        'shell',
        // `printenv` reflects the child env to stdout — proves the inherited
        // secret reached the child without us having to leak it via the test.
        { cmd: 'printenv GBRAIN_DATABASE_URL', cwd: '/tmp', inherit: ['database_url'] },
        {},
        { allowProtectedSubmit: true },
      );

      // T7 regression assertion: the persisted row carries names only, NEVER values.
      const persisted = await queue.getJob(job.id);
      expect((persisted!.data as Record<string, unknown>).inherit).toEqual(['database_url']);
      // T1 + T7 negative-shape: the URL substring must not appear ANYWHERE in
      // the persisted row's data JSON. Pinpoint the load-bearing R1 invariant.
      const rowJson = JSON.stringify(persisted!.data);
      expect(rowJson).not.toContain('T0P_5ECR3T');
      expect(rowJson).not.toContain(testDbUrl);

      const worker = new MinionWorker(engine, { pollInterval: 100, lockDuration: 30000 });
      await registerBuiltinHandlers(worker, engine);
      const runPromise = worker.start();
      try {
        const status = await waitTerminal(queue, job.id, 20000);
        expect(status).toBe('completed');
        const final = await queue.getJob(job.id);
        // The child saw GBRAIN_DATABASE_URL = the configured URL.
        expect((final!.result as Record<string, unknown>).stdout_tail).toBe(testDbUrl + '\n');
      } finally {
        worker.stop();
        await runPromise;
      }
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      if (savedGbrainUrl === undefined) delete process.env.GBRAIN_DATABASE_URL;
      else process.env.GBRAIN_DATABASE_URL = savedGbrainUrl;
      if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDbUrl;
      if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
    }
  }, 30000);

  test('v0.35.8.0: defense-in-depth — pre-existing row with env:{GBRAIN_DATABASE_URL} is rejected by handler revalidation', async () => {
    // T1 defense-in-depth: even if a pre-v0.35.8.0 row sneaks past pre-enqueue
    // validation (or a future submit path bypasses it), the handler re-runs
    // the same validator at pickup and refuses to spawn the child.
    const { writeFileSync, mkdirSync, rmSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpHome = join(tmpdir(), `gbrain-did-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpHome, '.gbrain'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'postgres', database_url: 'postgresql://x:y@h:5432/d' }) + '\n',
    );

    const savedHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = tmpHome;

    try {
      const queue = new MinionQueue(engine);
      // Submit directly via queue.add to bypass the CLI pre-enqueue validator,
      // simulating a pre-v0.35.8.0 row or a future submit path that skips it.
      const job = await queue.add(
        'shell',
        { cmd: 'echo bad', cwd: '/tmp', env: { GBRAIN_DATABASE_URL: 'postgresql://attacker:leaked@evil:5432/db' } },
        {},
        { allowProtectedSubmit: true },
      );

      const worker = new MinionWorker(engine, { pollInterval: 100, lockDuration: 30000 });
      await registerBuiltinHandlers(worker, engine);
      const runPromise = worker.start();
      try {
        // Handler revalidation must reject this row. UnrecoverableError → dead.
        const status = await waitTerminal(queue, job.id, 20000);
        expect(['dead', 'failed']).toContain(status);
      } finally {
        worker.stop();
        await runPromise;
      }
    } finally {
      if (savedHome === undefined) delete process.env.GBRAIN_HOME;
      else process.env.GBRAIN_HOME = savedHome;
      if (existsSync(tmpHome)) rmSync(tmpHome, { recursive: true, force: true });
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
