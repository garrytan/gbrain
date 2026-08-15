/**
 * #2050 — a patterns/synthesize parent job that blocks on its own subagent
 * child must not deadlock a fully-occupied Postgres drain worker.
 *
 * Pre-fix, the inline child drain was PGLite-only (runPgliteSubagentsInline
 * returned early unless engine.kind === 'pglite') and Postgres children were
 * submitted to the 'default' queue. Autopilot spawns its drain worker with no
 * --concurrency (resolves to 1), so the parent occupied the only slot, the
 * child was never claimed, and the phase burned the whole
 * subagent_wait_timeout_ms window before cancelling its own child — every
 * cycle, forever.
 *
 * These tests run the REAL phase/drain code against a PGLite engine masked as
 * kind='postgres' (only the `kind` property is intercepted; every method call
 * hits the real engine), which is exactly the branch the production Postgres
 * environment takes. All assertions are behavioral: on unmodified master they
 * fail with outcome 'timeout' / a never-claimed 'waiting' child on the
 * 'default' queue.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

/** Mask a PGLite engine as Postgres: only `kind` is intercepted, every
 *  method executes on the real engine (bound to the target so internal
 *  state is untouched). */
function maskAsPostgres(target: PGLiteEngine): BrainEngine {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'kind') return 'postgres';
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as unknown as BrainEngine;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

async function seedReflections(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth)
       VALUES ($1, 'note', $2, $3)`,
      [
        `wiki/personal/reflections/2026-07-0${i + 1}-reflection`,
        `Reflection ${i + 1}`,
        `Recurring theme fixture number ${i + 1}.`,
      ],
    );
  }
}

describe('#2050 — patterns parent must not deadlock on its own child (postgres path)', () => {
  test('child is drained inline on a private queue instead of waiting out the parent', async () => {
    const brainDir = mkdtempSync(join(tmpdir(), 'gbrain-2050-patterns-'));
    try {
      await seedReflections();
      // Small wait window: on master the child is never claimed (no worker in
      // this process, parent would hold the only slot in production), so the
      // phase burns this whole window and reports outcome 'timeout'.
      await engine.setConfig('dream.patterns.subagent_wait_timeout_ms', '2000');

      const pgAlike = maskAsPostgres(engine);
      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () =>
        runPhasePatterns(pgAlike, { brainDir, dryRun: false }),
      );

      // Master: child_outcome 'timeout' + PATTERNS_CHILD_TIMEOUT (self-deadlock,
      // then the phase cancels its own child). Fixed: the inline drain actually
      // ran the child (the fake API key fails fast → 'dead'), no deadlock.
      expect(result.details.child_outcome).toBe('dead');
      expect(result.error?.code).toBe('PATTERNS_CHILD_DEAD');

      const jobs = await engine.executeRaw<{ queue: string; status: string }>(
        `SELECT queue, status FROM minion_jobs WHERE name = 'subagent' ORDER BY id DESC LIMIT 1`,
      );
      expect(jobs).toHaveLength(1);
      // Master: queue 'default' (claimable by — and deadlocked behind — the
      // same worker running the parent), status 'cancelled'.
      expect(jobs[0].queue).toStartWith('dream-inline-');
      expect(jobs[0].status).toBe('dead');
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('inline drain runs children on a non-pglite engine and heartbeats their lock', async () => {
    const { __testing } = await import('../src/core/cycle/synthesize.ts');
    const drain = (__testing as Record<string, unknown>).runSubagentsInline
      ?? (__testing as Record<string, unknown>).runPgliteSubagentsInline;

    const pgAlike = maskAsPostgres(engine);
    const queue = new MinionQueue(pgAlike);
    const job = await queue.add(
      'subagent',
      { prompt: 'noop', model: 'anthropic:claude-sonnet-4-5', max_turns: 1 },
      { queue: 'inline-2050-test', max_stalled: 3 },
      { allowProtectedSubmit: true },
    );

    // Stub handler outliving the (shortened) claim lock: sleeps past lockMs,
    // then runs the same handleStalled() sweep a concurrent Postgres worker
    // fires on a timer. With the heartbeat the lock is fresh and the sweep
    // must NOT touch the running child; without it the child would be
    // requeued mid-run (stall churn → dead after max_stalled).
    let sweptWhileRunning = 0;
    const stub = async () => {
      await new Promise((r) => setTimeout(r, 1400));
      const { requeued, dead } = await queue.handleStalled();
      sweptWhileRunning = [...requeued, ...dead].filter((j) => j.id === job.id).length;
      return { ok: true };
    };

    // Master behavioral failure: runPgliteSubagentsInline no-ops on a
    // kind='postgres' engine, the stub never runs, the job stays 'waiting'.
    await (drain as (
      e: BrainEngine, q: MinionQueue, name: string,
      y?: () => Promise<void>, h?: unknown, lockMs?: number,
    ) => Promise<void>)(pgAlike, queue, 'inline-2050-test', undefined, stub, 1000);

    const after = await queue.getJob(job.id);
    expect(after?.status).toBe('completed');
    expect(sweptWhileRunning).toBe(0);
  }, 30_000);

  // #3555 interaction: the drain's queue ops must survive a transient pooler
  // reap (reconnect + retry) instead of throwing out of the loop and
  // stranding children in the per-run private queue no worker will claim.

  /** Mask as Postgres AND expose a counting reconnect() for the drain's
   *  recovery path (the real PGLite engine has no reconnect method). */
  function maskAsPostgresWithReconnect(target: PGLiteEngine, onReconnect: () => void): BrainEngine {
    return new Proxy(target, {
      get(t, prop) {
        if (prop === 'kind') return 'postgres';
        if (prop === 'reconnect') return async () => { onReconnect(); };
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as unknown as BrainEngine;
  }

  const connError = () =>
    Object.assign(new Error('write CONNECTION_ENDED supavisor reaped the socket'), { code: 'CONNECTION_ENDED' });

  test('a transient connection error on claim reconnects and the child still completes', async () => {
    const { __testing } = await import('../src/core/cycle/synthesize.ts');
    const drain = (__testing as Record<string, unknown>).runSubagentsInline;

    let reconnects = 0;
    const pgAlike = maskAsPostgresWithReconnect(engine, () => { reconnects++; });
    const queue = new MinionQueue(pgAlike);
    const job = await queue.add(
      'subagent',
      { prompt: 'noop', model: 'anthropic:claude-sonnet-4-5', max_turns: 1 },
      { queue: 'inline-2050-conn-claim', max_stalled: 3 },
      { allowProtectedSubmit: true },
    );

    let failuresLeft = 1;
    const realClaim = queue.claim.bind(queue);
    queue.claim = (async (...args: Parameters<MinionQueue['claim']>) => {
      if (failuresLeft-- > 0) throw connError();
      return realClaim(...args);
    }) as MinionQueue['claim'];

    // Pre-fix: the bare-await claim throws out of the drain, the child
    // strands 'waiting' in the private queue, and this await rejects.
    await (drain as (
      e: BrainEngine, q: MinionQueue, name: string,
      y?: () => Promise<void>, h?: unknown, lockMs?: number,
    ) => Promise<void>)(pgAlike, queue, 'inline-2050-conn-claim', undefined, async () => ({ ok: true }), 1000);

    const after = await queue.getJob(job.id);
    expect(after?.status).toBe('completed');
    expect(reconnects).toBe(1);
  }, 30_000);

  test('a transient connection error recording the outcome retries once and the child still completes', async () => {
    const { __testing } = await import('../src/core/cycle/synthesize.ts');
    const drain = (__testing as Record<string, unknown>).runSubagentsInline;

    let reconnects = 0;
    const pgAlike = maskAsPostgresWithReconnect(engine, () => { reconnects++; });
    const queue = new MinionQueue(pgAlike);
    const job = await queue.add(
      'subagent',
      { prompt: 'noop', model: 'anthropic:claude-sonnet-4-5', max_turns: 1 },
      { queue: 'inline-2050-conn-record', max_stalled: 3 },
      { allowProtectedSubmit: true },
    );

    let failuresLeft = 1;
    const realComplete = queue.completeJob.bind(queue);
    queue.completeJob = (async (...args: Parameters<MinionQueue['completeJob']>) => {
      if (failuresLeft-- > 0) throw connError();
      return realComplete(...args);
    }) as MinionQueue['completeJob'];

    // Pre-fix: completeJob's rejection landed in the drain's catch, which
    // called failJob for a handler that SUCCEEDED (misrecorded outcome) — or
    // escaped the drain entirely if failJob also hit the dead pool.
    await (drain as (
      e: BrainEngine, q: MinionQueue, name: string,
      y?: () => Promise<void>, h?: unknown, lockMs?: number,
    ) => Promise<void>)(pgAlike, queue, 'inline-2050-conn-record', undefined, async () => ({ ok: true }), 1000);

    const after = await queue.getJob(job.id);
    expect(after?.status).toBe('completed');
    expect(reconnects).toBe(1);
  }, 30_000);
});
