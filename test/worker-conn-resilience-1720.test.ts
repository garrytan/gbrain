/**
 * issue #1720 — autopilot worker crash-loops on pooler CONNECTION_CLOSED.
 *
 * PRs #2025 (#1491) and #1824 (#1801) fixed the promoteDelayed/claim loops and
 * added the supervised db-liveness probe, but three gaps remained:
 *
 *   1. The stall-detection interval had NO reconnect — a dead pool sprayed
 *      "Stall detection error: write CONNECTION_CLOSED ..." every tick until
 *      the ~3-minute db_dead exit (the reporter's 20k-line log spray).
 *   2. `failJob` was unwrapped — when recording a failure threw on the same
 *      dead pool, the ORIGINAL job error was never logged anywhere (masked),
 *      and no reconnect happened.
 *   3. The startup connect matcher (db.ts isRetryableDbConnectError) and the
 *      runtime matcher (retry-matcher.ts isRetryableConnError) had drifted:
 *      the startup list lacked /connection.*closed/ + CONNECTION_CLOSED.
 *
 * These tests inject the postgres.js error SHAPES (message + code) — a real
 * Supavisor pooler close is not reproducible in CI (UNVERIFIED-ON-ENVIRONMENT).
 */

import { describe, expect, test } from 'bun:test';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MinionJob } from '../src/core/minions/types.ts';
import { isRetryableConnError } from '../src/core/retry-matcher.ts';

/** The exact shape postgres.js throws when a pooler closes the socket. */
function connClosed(): Error {
  return Object.assign(
    new Error('write CONNECTION_CLOSED db.pooler.example:5432'),
    { code: 'CONNECTION_CLOSED' },
  );
}

function makeEngine(counter: { reconnects: number }): BrainEngine {
  return {
    kind: 'postgres',
    reconnect: async () => { counter.reconnects += 1; },
  } as unknown as BrainEngine;
}

/** Swap the worker's private queue for a fake (same pattern as worker-promote-reconnect.test.ts). */
function setQueue(worker: MinionWorker, queue: Record<string, unknown>): void {
  (worker as unknown as { queue: Record<string, unknown> }).queue = queue;
}

async function withCapturedConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = orig;
  }
}

describe('stall-detection interval reconnect (#1720 gap 1)', () => {
  test('a retryable connection error in the stall sweep rebuilds the pool — once per tick across all three sweeps', async () => {
    const counter = { reconnects: 0 };
    const worker = new MinionWorker(makeEngine(counter), {
      pollInterval: 1,
      stalledInterval: 10,
      healthCheckInterval: 0,
    });
    worker.register('noop', async () => ({}));

    let tickDone = false;
    let claims = 0;
    const threw = { stalled: false, timeouts: false, wallClock: false };
    setQueue(worker, {
      ensureSchema: async () => {},
      promoteDelayed: async () => [],
      claim: async () => {
        claims += 1;
        // Stop once the first stall tick fully ran (or bail out after a bound
        // so an unfixed build terminates and FAILS the assertion, not hangs).
        if (tickDone || claims > 2000) worker.stop();
        return null;
      },
      handleStalled: async () => {
        if (!threw.stalled) { threw.stalled = true; throw connClosed(); }
        return { requeued: [], dead: [] };
      },
      handleTimeouts: async () => {
        if (!threw.timeouts) { threw.timeouts = true; throw connClosed(); }
        return [];
      },
      handleWallClockTimeouts: async () => {
        if (!threw.wallClock) { threw.wallClock = true; tickDone = true; throw connClosed(); }
        tickDone = true;
        return [];
      },
    });

    const { lines } = await withCapturedConsoleError(() => worker.start());

    // The tick actually exercised the failing sweeps...
    expect(lines.some(l => l.startsWith('Stall detection error:'))).toBe(true);
    // ...and the worker repaired its pool in-process: exactly ONE reconnect
    // for the tick even though all three sweeps failed (no pooler hammering).
    expect(counter.reconnects).toBe(1);
  });
});

describe('failJob failure-recording resilience (#1720 gap 2)', () => {
  test('when failJob throws a conn error: original job error is surfaced, pool reconnects, recording is retried once', async () => {
    const counter = { reconnects: 0 };
    const worker = new MinionWorker(makeEngine(counter), {
      pollInterval: 1,
      stalledInterval: 60_000,
      healthCheckInterval: 0,
      lockDuration: 60_000,
      concurrency: 1,
    });
    worker.register('explode', async () => { throw new Error('boom: the real job defect'); });

    const job = {
      id: 42,
      name: 'explode',
      queue: 'default',
      data: {},
      status: 'active',
      attempts_made: 2,
      attempts_started: 3,
      max_attempts: 3, // attempts exhausted → newStatus 'dead', no backoff math
      backoff_type: 'exponential',
      backoff_delay: 1000,
      backoff_jitter: false,
      timeout_ms: null,
      timeout_at: null,
      parent_job_id: null,
    } as unknown as MinionJob;

    let failJobCalls = 0;
    let handedOut = false;
    let done = false;
    let claims = 0;
    setQueue(worker, {
      ensureSchema: async () => {},
      promoteDelayed: async () => [],
      handleStalled: async () => ({ requeued: [], dead: [] }),
      handleTimeouts: async () => [],
      handleWallClockTimeouts: async () => [],
      renewLock: async () => true,
      claim: async () => {
        claims += 1;
        if (!handedOut) { handedOut = true; return job; }
        if (done || claims > 2000) worker.stop();
        return null;
      },
      failJob: async (_id: number, _tok: string, errorText: string, newStatus: string) => {
        failJobCalls += 1;
        if (failJobCalls === 1) throw connClosed(); // same outage that failed the job
        done = true;
        return { ...job, status: newStatus, error_text: errorText };
      },
    });

    const { lines } = await withCapturedConsoleError(() => worker.start());

    // Recording was retried after an in-process reconnect (not abandoned).
    expect(failJobCalls).toBe(2);
    expect(counter.reconnects).toBe(1);
    // The ORIGINAL job error must be logged even though recording it threw —
    // pre-fix only "executeJob unhandled error ... CONNECTION_CLOSED" survived
    // and the real defect was masked.
    expect(
      lines.some(l => l.includes('boom: the real job defect') && l.includes('CONNECTION_CLOSED')),
    ).toBe(true);
  });
});

describe('retry-matcher unification (#1720 gap 4)', () => {
  test('startup connect matcher recognizes a pooler CONNECTION_CLOSED', async () => {
    const { isRetryableDbConnectError } = await import('../src/core/db.ts');
    expect(isRetryableDbConnectError(new Error('write CONNECTION_CLOSED db.pooler.example:5432'))).toBe(true);
    expect(isRetryableDbConnectError(new Error('server closed the connection unexpectedly'))).toBe(true);
  });

  test('code-only CONNECTION_CLOSED (message rewritten by a wrapper) is retryable', () => {
    expect(isRetryableConnError(Object.assign(new Error('socket hang up'), { code: 'CONNECTION_CLOSED' }))).toBe(true);
  });

  test('drift guard: startup and runtime matchers agree on the full shape corpus', async () => {
    const { isRetryableDbConnectError } = await import('../src/core/db.ts');
    const shapes: unknown[] = [
      // transient / retryable
      connClosed(),
      new Error('write CONNECTION_CLOSED db.pooler.example:5432'),
      new Error('connection closed by server'),
      Object.assign(new Error(''), { code: 'CONNECTION_ENDED' }),
      new Error('password authentication failed for user "app"'),
      new Error('connection refused'),
      new Error('the database system is starting up'),
      new Error('Connection terminated unexpectedly'),
      new Error('read ECONNRESET'),
      new Error('No database connection: connect() has not been called'),
      new Error('EMAXCONNSESSION'),
      new Error('sorry, too many clients already'),
      // permanent / non-retryable
      new Error('extension "vector" does not exist'),
      new Error('relation "pages" does not exist'),
      new Error('syntax error at end of input'),
      new Error('duplicate key value violates unique constraint "pages_pkey"'),
    ];
    for (const shape of shapes) {
      expect(isRetryableDbConnectError(shape)).toBe(isRetryableConnError(shape));
    }
  });
});
