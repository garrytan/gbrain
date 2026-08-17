/**
 * issue #5 — `runChildJobEntry` (the `jobs run-child` core) against a real
 * in-memory PGLite engine with a REAL claim-minted lock token. (PGLite is
 * rejected at the CLI layer for actual isolation runs — Postgres-only — but
 * the core function is engine-agnostic, which is exactly what makes it
 * testable without a DATABASE_URL.)
 *
 * Paths pinned:
 *   - success: handler result lands in the outcome file, exit 0
 *   - handler failure: encoded error outcome, STILL exit 0 (a reported
 *     failure is a successful report)
 *   - token mismatch / reclaimed job: exit 14, handler NEVER runs
 *   - missing handler: generic error outcome, exit 0
 *   - SIGTERM semantics via direct signal wiring (ctx.signal + shutdown)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runChildJobEntry } from '../src/core/minions/run-child.ts';
import { decodeChildOutcomeFile } from '../src/core/minions/job-isolation.ts';
import {
  JOB_CHILD_EXIT_NOT_CLAIMED,
} from '../src/core/minions/worker-exit-codes.ts';
import { UnrecoverableError, type MinionHandler } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
  queue = new MinionQueue(engine);
  dir = mkdtempSync(join(tmpdir(), 'gbrain-run-child-test-'));
});

afterAll(async () => {
  await engine.disconnect();
  // Best-effort tmpdir cleanup with one retry. Bun's recursive rmSync has
  // EFAULT'd here on CI (bun 1.3.13, ubuntu-24.04) immediately after the
  // WASM engine teardown — a runtime flake, not a test failure. bun treats
  // a throwing afterAll as an "(unnamed)" failed test and reds the shard;
  // the OS reaps tmpdir anyway, so cleanup must never fail the suite.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    await new Promise((r) => setTimeout(r, 50));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn(
        `[run-child-entry.test] tmpdir cleanup failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

/** Claim a freshly-added job the same way the parent worker does. */
async function addAndClaim(name: string, data: Record<string, unknown> = {}) {
  await queue.add(name, data);
  const job = await queue.claim('parent-tok-1', 30_000, 'default', [name]);
  if (!job) throw new Error('claim failed in test setup');
  return job;
}

function handlers(map: Record<string, MinionHandler>) {
  return { resolveHandler: (n: string) => map[n] };
}

describe('runChildJobEntry', () => {
  test('success: outcome file carries the handler result; exit 0; ctx wired to the job row', async () => {
    const job = await addAndClaim('sync', { full: true });
    const resultPath = join(dir, `ok-${job.id}.json`);
    let sawData: unknown;

    const code = await runChildJobEntry(
      engine,
      { jobId: job.id, lockToken: 'parent-tok-1', resultPath, parentPid: 0 },
      handlers({
        sync: async (ctx) => {
          sawData = ctx.data;
          await ctx.updateProgress({ step: 'half' });
          return { pages: 7 };
        },
      }),
    );

    expect(code).toBe(0);
    expect(sawData).toEqual({ full: true });
    const outcome = decodeChildOutcomeFile(resultPath);
    expect(outcome).toEqual({ outcome: 'success', result: { pages: 7 } });
    // The token-fenced progress write really landed.
    const rows = await engine.executeRaw<{ progress: unknown }>(
      'SELECT progress FROM minion_jobs WHERE id = $1',
      [job.id],
    );
    const progress = rows[0]?.progress;
    expect(typeof progress === 'string' ? JSON.parse(progress) : progress).toEqual({ step: 'half' });
  });

  test('handler failure: encoded error outcome, exit 0 (reported failure = successful report)', async () => {
    const job = await addAndClaim('sync');
    const resultPath = join(dir, `err-${job.id}.json`);

    const code = await runChildJobEntry(
      engine,
      { jobId: job.id, lockToken: 'parent-tok-1', resultPath, parentPid: 0 },
      handlers({
        sync: async () => {
          throw new UnrecoverableError('schema mismatch, never retry');
        },
      }),
    );

    expect(code).toBe(0);
    const outcome = decodeChildOutcomeFile(resultPath);
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.errorKind).toBe('unrecoverable');
      expect(outcome.message).toBe('schema mismatch, never retry');
    }
  });

  test('token mismatch (job reclaimed): exit 14, handler never runs', async () => {
    const job = await addAndClaim('sync');
    const resultPath = join(dir, `mismatch-${job.id}.json`);
    let handlerRan = false;

    const code = await runChildJobEntry(
      engine,
      { jobId: job.id, lockToken: 'STALE-token', resultPath, parentPid: 0 },
      handlers({
        sync: async () => {
          handlerRan = true;
          return null;
        },
      }),
    );

    expect(code).toBe(JOB_CHILD_EXIT_NOT_CLAIMED);
    expect(handlerRan).toBe(false);
    expect(() => decodeChildOutcomeFile(resultPath)).toThrow(); // nothing written
  });

  test('missing job id: exit 14', async () => {
    const code = await runChildJobEntry(
      engine,
      { jobId: 999_999, lockToken: 'parent-tok-1', resultPath: join(dir, 'none.json'), parentPid: 0 },
      handlers({}),
    );
    expect(code).toBe(JOB_CHILD_EXIT_NOT_CLAIMED);
  });

  test('missing handler: UNRECOVERABLE error outcome (inline parity: dead on attempt 1), exit 0', async () => {
    const job = await addAndClaim('exotic-plugin-job');
    const resultPath = join(dir, `nohandler-${job.id}.json`);

    const code = await runChildJobEntry(
      engine,
      { jobId: job.id, lockToken: 'parent-tok-1', resultPath, parentPid: 0 },
      handlers({}),
    );

    expect(code).toBe(0);
    const outcome = decodeChildOutcomeFile(resultPath);
    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.errorKind).toBe('unrecoverable');
      expect(outcome.message).toContain("No handler for job type 'exotic-plugin-job'");
    }
  });

  test('SIGTERM aborts ONLY shutdownSignal — ctx.signal stays live (inline signal-separation parity)', async () => {
    const job = await addAndClaim('sync');
    const resultPath = join(dir, `sigterm-${job.id}.json`);
    let ctxSignalAbortedAtShutdown: boolean | null = null;

    const listenersBefore = new Set(process.listeners('SIGTERM'));
    const entry = runChildJobEntry(
      engine,
      { jobId: job.id, lockToken: 'parent-tok-1', resultPath, parentPid: 0 },
      handlers({
        sync: (ctx) =>
          new Promise((resolve) => {
            ctx.shutdownSignal.addEventListener('abort', () => {
              // The whole point: a cooperative handler gets the drain window
              // with its per-job signal STILL LIVE, finishes, and reports.
              ctxSignalAbortedAtShutdown = ctx.signal.aborted;
              resolve('finished-during-drain');
            });
          }),
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    // Trigger ONLY the SIGTERM listener(s) the entry registered. A bare
    // process.emit('SIGTERM') broadcasts to EVERY listener in the shared
    // bun test process — including process-cleanup.ts's leaked handler,
    // whose runCleanupPass().finally(process.exit(143)) kills the whole
    // shard mid-suite when an earlier file installed it. That exit code
    // reads as rc=143 and gets misclassified as an "external kill" by
    // run-unit-parallel.sh (bit three consecutive suite runs under host
    // load before being traced here).
    const added = process
      .listeners('SIGTERM')
      .filter((l) => !listenersBefore.has(l));
    expect(added.length).toBeGreaterThan(0);
    for (const l of added) (l as (...args: unknown[]) => void)('SIGTERM');
    const code = await entry;

    expect(code).toBe(0);
    // TS control-flow can't see the closure write; compare explicitly.
    expect(ctxSignalAbortedAtShutdown === false).toBe(true);
    const outcome = decodeChildOutcomeFile(resultPath);
    expect(outcome).toEqual({ outcome: 'success', result: { value: 'finished-during-drain' } });
  });

  test('primitive results are wrapped {value: x} CHILD-side (completeJob shape parity across the JSON boundary)', async () => {
    const job = await addAndClaim('sync');
    const resultPath = join(dir, `wrap-${job.id}.json`);

    const code = await runChildJobEntry(
      engine,
      { jobId: job.id, lockToken: 'parent-tok-1', resultPath, parentPid: 0 },
      handlers({ sync: async () => 42 }),
    );

    expect(code).toBe(0);
    expect(decodeChildOutcomeFile(resultPath)).toEqual({ outcome: 'success', result: { value: 42 } });
  });

  test('parent-death watchdog: aborts the handler and schedules the hard exit', async () => {
    const job = await addAndClaim('sync');
    const resultPath = join(dir, `orphan-${job.id}.json`);
    let sawAbort = false;
    const hardExits: number[] = [];

    // A GUARANTEED-dead parent pid: spawn a real short-lived process, wait
    // for it to exit, and use its reaped pid. (A magic high pid is
    // allocatable on Linux — default kernel.pid_max is 4,194,304 — so a real
    // process could hold it and hang the test; testing specialist.)
    const { spawnSync: spawnDead } = await import('node:child_process');
    const deadPid = spawnDead('/bin/sh', ['-c', 'exit 0']).pid ?? 0;
    expect(deadPid).toBeGreaterThan(0);
    const code = await runChildJobEntry(
      engine,
      { jobId: job.id, lockToken: 'parent-tok-1', resultPath, parentPid: deadPid },
      {
        resolveHandler: () => async (ctx) =>
          new Promise((resolve) => {
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true;
              resolve('aborted-cleanly');
            });
          }),
        parentPollMs: 30,
        orphanGraceMs: 60_000, // never fires in-test; we capture the schedule
        hardExit: (c) => { hardExits.push(c); },
      },
    );

    expect(sawAbort).toBe(true);
    expect(code).toBe(0); // the handler resolved after abort; outcome written
    const outcome = decodeChildOutcomeFile(resultPath);
    expect(outcome.outcome).toBe('success');
    expect(hardExits.length).toBe(0); // grace not reached — clean wind-down
  });
});
