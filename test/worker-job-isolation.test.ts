/**
 * issue #5 — full parent path with isolation on: claim → spawn child →
 * decode outcome → completeJob / failJob / release. Real in-memory PGLite
 * worker + the fake-run-child.mjs fixture standing in for the compiled CLI
 * (reads the isolation env contract, writes canned outcomes).
 *
 * Pins:
 *   - success: job completes with the CHILD's result (fenced completeJob)
 *   - error outcome: failJob path — attempt burned, delayed/dead per policy
 *   - crash (exit 1, no file): attempt burned
 *   - spawn failure (bad child CLI): RELEASED — status stays 'active',
 *     attempts NOT burned (infra class; stall sweeper would requeue)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { withEnv } from './helpers/with-env.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'fake-run-child.mjs');

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

function makeWorker(invocationCmd = process.execPath, argsPrefix = [FIXTURE]) {
  const worker = new MinionWorker(engine, {
    queue: 'default',
    concurrency: 1,
    pollInterval: 25,
    healthCheckInterval: 0,
    maxRssMb: 0,
    jobIsolation: 'process',
    childCliInvocation: { cmd: invocationCmd, argsPrefix },
  });
  // Handler must exist in the parent registry (name-scoped claiming); its
  // body never runs in isolation mode.
  worker.register('isotest', async () => {
    throw new Error('parent-side handler must not run when isolated');
  });
  return worker;
}

async function runWorkerUntil(
  worker: MinionWorker,
  done: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const run = worker.start();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (await done()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('runWorkerUntil timed out');
  } finally {
    worker.stop();
    await run;
  }
}

async function jobRow(id: number): Promise<{ status: string; attempts_made: number; result: unknown; error_text: string | null }> {
  const rows = await engine.executeRaw<{
    status: string;
    attempts_made: number;
    result: unknown;
    error_text: string | null;
  }>('SELECT status, attempts_made, result, error_text FROM minion_jobs WHERE id = $1', [id]);
  if (!rows[0]) throw new Error('job row missing');
  return rows[0];
}

describe('worker with jobIsolation=process (PGLite + fake child)', () => {
  test("construction throws for jobIsolation 'process' without childCliInvocation (predicate-mismatch guard)", () => {
    // Red-team finding: 'process' without an invocation silently executed
    // handlers INLINE while the evict path believed it was isolated.
    expect(
      () => new MinionWorker(engine, { queue: 'default', jobIsolation: 'process' }),
    ).toThrow(/childCliInvocation/);
  });

  test('spawn-failure circuit breaker: 3 consecutive bootstrap failures emit unhealthy(child_spawn_failing)', async () => {
    // Red-team finding: a deterministic child-bootstrap failure looped
    // claim/release forever, invisible to the stall detector (every settle
    // refreshes the progress clock).
    const j1 = await queue.add('isotest', {});
    const j2 = await queue.add('isotest', {});
    const j3 = await queue.add('isotest', {});
    const worker = makeWorker(process.execPath, ['-e', 'process.exit(13)']);
    const unhealthy: unknown[] = [];
    worker.on('unhealthy', (i) => unhealthy.push(i));
    const run = worker.start();
    const deadline = Date.now() + 10_000;
    try {
      while (Date.now() < deadline && unhealthy.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      worker.stop();
      await run;
    }
    expect(unhealthy.length).toBeGreaterThan(0);
    const info = unhealthy[0] as { reason: string; consecutiveFailures: number };
    expect(info.reason).toBe('child_spawn_failing');
    expect(info.consecutiveFailures).toBeGreaterThanOrEqual(3);
    // No attempts burned anywhere — all three rows released, not failed.
    for (const j of [j1, j2, j3]) {
      const row = await jobRow(j.id);
      expect(row.status).toBe('active');
      expect(row.attempts_made).toBe(0);
    }
  }, 20_000);

  test('success: child result lands via the fenced completeJob', async () => {
    await withEnv({ FAKE_RUN_CHILD_MODE: 'success' }, async () => {
      const job = await queue.add('isotest', { prompt: 'hi' });
      const worker = makeWorker();
      await runWorkerUntil(worker, async () => (await jobRow(job.id)).status === 'completed');
      const row = await jobRow(job.id);
      expect(row.status).toBe('completed');
      const result = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
      expect((result as { fromChild?: boolean }).fromChild).toBe(true);
      // The child got the REAL claim token through the env contract.
      expect((result as { token?: string }).token).toMatch(/^.+:.+$/);
    });
  }, 20_000);

  test('error outcome: failJob path, attempt burned', async () => {
    await withEnv({ FAKE_RUN_CHILD_MODE: 'error' }, async () => {
      const job = await queue.add('isotest', {}, { max_attempts: 1 });
      const worker = makeWorker();
      await runWorkerUntil(worker, async () => {
        const s = (await jobRow(job.id)).status;
        return s === 'dead' || s === 'failed';
      });
      const row = await jobRow(job.id);
      expect(row.status).toBe('dead'); // maxAttempts 1 → attempt burned → dead
      expect(row.error_text).toContain('fake child handler failure');
    });
  }, 20_000);

  test('crash (exit 1, no outcome file): attempt burned', async () => {
    await withEnv({ FAKE_RUN_CHILD_MODE: 'crash' }, async () => {
      const job = await queue.add('isotest', {}, { max_attempts: 1 });
      const worker = makeWorker();
      await runWorkerUntil(worker, async () => {
        const s = (await jobRow(job.id)).status;
        return s === 'dead' || s === 'failed';
      });
      const row = await jobRow(job.id);
      expect(row.status).toBe('dead');
      expect(row.error_text).toContain('exit code=1');
    });
  }, 20_000);

  test('serialization parity (codex-2 #8): unreportable results fail in BOTH modes, never complete', async () => {
    // Inline: a circular result blows up in completeJob's serialization →
    // failJob (attempt burned).
    const inlineWorker = new MinionWorker(engine, {
      queue: 'default', concurrency: 1, pollInterval: 25, healthCheckInterval: 0, maxRssMb: 0,
    });
    inlineWorker.register('isotest', async () => {
      const a: Record<string, unknown> = {};
      a.self = a; // circular — not JSONB-serializable
      return a;
    });
    const j1 = await queue.add('isotest', {}, { max_attempts: 1 });
    await runWorkerUntil(inlineWorker, async () => {
      const s = (await jobRow(j1.id)).status;
      return s !== 'waiting' && s !== 'active';
    });
    expect((await jobRow(j1.id)).status).not.toBe('completed');

    // Process mode: a child that cannot persist its outcome (exit 15) lands
    // in the same terminal class — failed loudly, never falsely completed.
    await withEnv({ FAKE_RUN_CHILD_MODE: 'exit15' }, async () => {
      const j2 = await queue.add('isotest', {}, { max_attempts: 1 });
      const worker = makeWorker();
      await runWorkerUntil(worker, async () => (await jobRow(j2.id)).status === 'dead');
      expect((await jobRow(j2.id)).error_text).toContain('outcome file');
    });
  }, 30_000);

  test('spawn failure: RELEASED — still active, attempts NOT burned (infra class)', async () => {
    const job = await queue.add('isotest', {});
    const worker = makeWorker(process.execPath, ['-e', 'process.exit(13)']);
    // The claim happens, the spawn fails, the job is released (stays
    // 'active' until lock expiry — the stall sweeper's requeue territory).
    const run = worker.start();
    await new Promise((r) => setTimeout(r, 1_500));
    worker.stop();
    await run;
    const row = await jobRow(job.id);
    expect(row.status).toBe('active'); // NOT dead, NOT failed
    expect(row.attempts_made).toBe(0); // release = no failJob = no attempt burned
  }, 20_000);

  test('missing executable blocks once and releases only the owned claim', async () => {
    const first = await queue.add('isotest', {});
    const second = await queue.add('isotest', {});
    const worker = makeWorker('/nonexistent/gbrain-binary', []);
    const events: unknown[] = [];
    worker.on('unhealthy', event => events.push(event));
    await worker.start();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'client_misconfigured', error: { reasonCode: 'child_executable_invalid' } });
    expect(worker.configurationError?.reasonCode).toBe('child_executable_invalid');
    expect((await jobRow(first.id)).status).toBe('delayed');
    expect((await jobRow(first.id)).attempts_made).toBe(0);
    expect((await jobRow(second.id)).status).toBe('waiting');
    expect((await jobRow(second.id)).attempts_made).toBe(0);
    expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['released']);
  });

  test('typed child outcomes block before cleanup and retain unconfirmed ownership', async () => {
    const first = await queue.add('isotest', {});
    const second = await queue.add('isotest', {});
    const outcome = JSON.stringify({
      outcome: 'error', errorKind: 'local_configuration', protocolVersion: 1,
      reasonCode: 'postgres_cancellation_unavailable', message: 'fixture fault',
    });
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-typed-unconfirmed-'));
    const grandchildPid = join(dir, 'grandchild.pid');
    const grandchild = join(dir, 'grandchild.cjs');
    const parent = join(dir, 'parent.cjs');
    writeFileSync(grandchild, `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(grandchildPid)}, String(process.pid)); setInterval(() => {}, 1000);`);
    writeFileSync(parent, `const fs = require('node:fs');
      require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' }).unref();
      while (!fs.existsSync(${JSON.stringify(grandchildPid)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      fs.writeFileSync(process.env.GBRAIN_JOB_RESULT_PATH, ${JSON.stringify(outcome)});`);
    try {
      const worker = makeWorker(process.execPath, [parent]);
      const internals = worker as unknown as {
        configurationDeadline: number;
        executions: Map<string, { promise: Promise<void> }>;
      };
      let execution: Promise<void> | undefined;
      worker.on('unhealthy', event => {
        if (event.reason !== 'client_misconfigured') return;
        internals.configurationDeadline = performance.now() + 100;
        execution = [...internals.executions.values()][0]?.promise;
      });
      const began = performance.now();
      await worker.start();
      expect(performance.now() - began).toBeLessThan(5000);
      expect(worker.configurationError?.reasonCode).toBe('postgres_cancellation_unavailable');
      expect((await jobRow(first.id)).status).toBe('active');
      expect((await jobRow(first.id)).attempts_made).toBe(0);
      expect((await jobRow(second.id)).status).toBe('waiting');
      expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['unconfirmed']);
      await execution;
      expect((await jobRow(first.id)).status).toBe('active');
      expect((await jobRow(first.id)).attempts_made).toBe(0);
    } finally {
      if (existsSync(grandchildPid)) { try { process.kill(Number(readFileSync(grandchildPid, 'utf8')), 'SIGKILL'); } catch {} }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 35_000);

  test.skipIf(process.platform !== 'linux')('typed child outcome with confirmed group cleanup releases the claim inside the configuration deadline', async () => {
    const first = await queue.add('isotest', {});
    const second = await queue.add('isotest', {});
    const outcome = JSON.stringify({
      outcome: 'error', errorKind: 'local_configuration', protocolVersion: 1,
      reasonCode: 'postgres_cancellation_unavailable', message: 'fixture fault',
    });
    const program = `require('node:fs').writeFileSync(process.env.GBRAIN_JOB_RESULT_PATH, ${JSON.stringify(outcome)});`;
    const worker = makeWorker(process.execPath, ['-e', program]);
    const began = performance.now();
    await worker.start();
    expect(performance.now() - began).toBeLessThan(5000);
    expect(worker.configurationError?.reasonCode).toBe('postgres_cancellation_unavailable');
    expect(worker.configurationReleaseResults.map(result => result.outcome)).toEqual(['released']);
    expect((await jobRow(first.id)).status).toBe('delayed');
    expect((await jobRow(first.id)).attempts_made).toBe(0);
    expect((await jobRow(second.id)).status).toBe('waiting');
  }, 35_000);
});
