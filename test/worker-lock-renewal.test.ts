/**
 * v0.41.22.2 — pure-function unit tests for `runLockRenewalTick`.
 *
 * Pins all 14 state-machine paths the cathedral cares about:
 *
 *   - happy-path single renewal
 *   - throw bookkeeping (counter, audit, no abort if within deadline)
 *   - recovery (success_after_failure audit, counter reset)
 *   - time-based abort (gave_up audit, abort returned)
 *   - lock_lost (token mismatch, no audit, no infrastructure framing)
 *   - hung renewLock (Promise.race timeout fires, counter increments)
 *   - cancellation at three points (entry, after-resolve, after-reject)
 *   - time-based-vs-count-based: deadline crosses BEFORE the counter
 *     hits `maxFailuresForAudit`, abort still fires
 *   - audit-throw defense-in-depth (audit threw, tick still returns
 *     `'ok'` — the headline regression for the v0.41.22.1 bug class
 *     this whole wave exists to close)
 *   - env-knob resolution (good values, bad values fallback +
 *     stderr-warn-once)
 *
 * Hermetic: no fs, no PGLite, no real Anthropic, no setInterval. The
 * tick function takes ALL effects via the injected `deps` object so
 * everything is a vanilla async-function call.
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import {
  runLockRenewalTick,
  resolveLockRenewalKnobs,
  _resetKnobWarningsForTests,
  type LockRenewalDeps,
  type LockRenewalState,
  type LockRenewalAuditSinkLike,
  type LockRenewalKnobs,
} from '../src/core/minions/lock-renewal-tick.ts';
import { withEnv } from './helpers/with-env.ts';

// --- fakes ----------------------------------------------------------------

interface AuditLog {
  failures: Array<{ jobId: number; jobName: string; attempt: number; err: unknown }>;
  recoveries: Array<{ jobId: number; jobName: string; recoveredAfterAttempts: number }>;
  gaveUps: Array<{ jobId: number; jobName: string; totalFailures: number; err: unknown }>;
}

function freshAudit(): { sink: LockRenewalAuditSinkLike; log: AuditLog } {
  const log: AuditLog = { failures: [], recoveries: [], gaveUps: [] };
  return {
    log,
    sink: {
      logFailure: (jobId, jobName, attempt, err) =>
        log.failures.push({ jobId, jobName, attempt, err }),
      logSuccessAfterFailure: (jobId, jobName, recoveredAfterAttempts) =>
        log.recoveries.push({ jobId, jobName, recoveredAfterAttempts }),
      logGaveUp: (jobId, jobName, totalFailures, err) =>
        log.gaveUps.push({ jobId, jobName, totalFailures, err }),
    },
  };
}

/**
 * Fake setTimeout that records the requested ms but does NOT actually
 * schedule a real timer (no leaks across tests). The callback never
 * fires unless tests explicitly call `runTimers(times)`.
 */
function makeFakeTimer(): {
  setTimeout: LockRenewalDeps['setTimeout'];
  runAll: () => void;
  pending: Array<() => void>;
} {
  const pending: Array<() => void> = [];
  return {
    setTimeout: (cb) => {
      pending.push(cb);
      return null;
    },
    runAll: () => {
      const toRun = [...pending];
      pending.length = 0;
      toRun.forEach((cb) => cb());
    },
    pending,
  };
}

const DEFAULT_LOCK_MS = 30_000;
const DEFAULT_KNOBS: LockRenewalKnobs = {
  maxFailuresForAudit: 3,
  callTimeoutMs: 10_000,
  safetyMarginMs: 5_000,
};

function makeState(overrides?: Partial<LockRenewalState>): LockRenewalState {
  return {
    jobId: 42,
    jobName: 'sync',
    lockToken: 'tok-abc',
    lockDurationMs: DEFAULT_LOCK_MS,
    knobs: DEFAULT_KNOBS,
    lastSuccessfulRenewalAt: 0,
    consecutiveFailures: 0,
    cancelled: () => false,
    ...overrides,
  };
}

// --- tests ----------------------------------------------------------------

describe('runLockRenewalTick: happy path', () => {
  test('case 1 — first-try success returns ok, no audit, lastSuccessfulRenewalAt updated', async () => {
    const audit = freshAudit();
    const timer = makeFakeTimer();
    const deps: LockRenewalDeps = {
      renewLock: async () => true,
      audit: audit.sink,
      now: () => 1000,
      setTimeout: timer.setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 500 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'ok' });
    expect(audit.log.failures).toHaveLength(0);
    expect(audit.log.recoveries).toHaveLength(0);
    expect(audit.log.gaveUps).toHaveLength(0);
    expect(state.lastSuccessfulRenewalAt).toBe(1000);
    expect(state.consecutiveFailures).toBe(0);
  });
});

describe('runLockRenewalTick: failure counter + audit', () => {
  test('case 2 — single throw within deadline: returns ok, counter=1, failure logged', async () => {
    const audit = freshAudit();
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('Connection terminated'); },
      audit: audit.sink,
      now: () => 1000, // sinceLastSuccess = 1000ms, deadline = 25000ms; well within
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'ok' });
    expect(state.consecutiveFailures).toBe(1);
    expect(audit.log.failures).toHaveLength(1);
    expect(audit.log.failures[0].attempt).toBe(1);
    expect(audit.log.gaveUps).toHaveLength(0);
  });

  test('case 3 — two throws then success: counter resets, success_after_failure logged', async () => {
    const audit = freshAudit();
    let callIdx = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => {
        callIdx++;
        if (callIdx <= 2) throw new Error('blip ' + callIdx);
        return true;
      },
      audit: audit.sink,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });

    const r1 = await runLockRenewalTick(deps, state);
    expect(r1.kind).toBe('ok');
    expect(state.consecutiveFailures).toBe(1);

    const r2 = await runLockRenewalTick(deps, state);
    expect(r2.kind).toBe('ok');
    expect(state.consecutiveFailures).toBe(2);

    const r3 = await runLockRenewalTick(deps, state);
    expect(r3.kind).toBe('ok');
    expect(state.consecutiveFailures).toBe(0);

    expect(audit.log.failures).toHaveLength(2);
    expect(audit.log.recoveries).toHaveLength(1);
    expect(audit.log.recoveries[0].recoveredAfterAttempts).toBe(2);
  });
});

describe('runLockRenewalTick: time-based abort', () => {
  test('case 4 — sustained throws past deadline returns should_abort, gave_up logged', async () => {
    const audit = freshAudit();
    // deadline = 30000 - 5000 = 25000; we've been failing for 26s.
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('persistent outage'); },
      audit: audit.sink,
      now: () => 26_000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0, consecutiveFailures: 2 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'should_abort', reason: 'lock-renewal-failed' });
    expect(audit.log.failures).toHaveLength(1);
    expect(audit.log.gaveUps).toHaveLength(1);
    expect(audit.log.gaveUps[0].totalFailures).toBe(3);
  });

  test('case 10 — time-based abort fires BEFORE count-based threshold', async () => {
    // Critical regression: deadline at 25s, 5 failures over 30s.
    // count-based (3-strike) would have aborted at failure #3 — but
    // failure #3 happens at t=15s, well inside the 25s deadline.
    // Time-based correctly waits until the deadline crosses.
    const audit = freshAudit();
    const knobs: LockRenewalKnobs = {
      maxFailuresForAudit: 3,
      callTimeoutMs: 10_000,
      safetyMarginMs: 5_000,
    };
    let nowMs = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('outage'); },
      audit: audit.sink,
      now: () => nowMs,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ knobs, lastSuccessfulRenewalAt: 0 });

    // Five sequential failures at t=5, 10, 15, 20, 26.
    for (const t of [5_000, 10_000, 15_000, 20_000]) {
      nowMs = t;
      const r = await runLockRenewalTick(deps, state);
      expect(r.kind).toBe('ok'); // within deadline despite counter > maxFailuresForAudit
    }
    expect(state.consecutiveFailures).toBe(4);
    expect(audit.log.gaveUps).toHaveLength(0);

    nowMs = 26_000; // crosses deadline of 25000
    const final = await runLockRenewalTick(deps, state);
    expect(final).toEqual({ kind: 'should_abort', reason: 'lock-renewal-failed' });
    expect(audit.log.gaveUps).toHaveLength(1);
  });
});

describe('runLockRenewalTick: lock_lost (token mismatch)', () => {
  test('case 5 — renewLock returns false: lock_lost, NO audit event', async () => {
    const audit = freshAudit();
    const deps: LockRenewalDeps = {
      renewLock: async () => false,
      audit: audit.sink,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'lock_lost' });
    expect(audit.log.failures).toHaveLength(0);
    expect(audit.log.gaveUps).toHaveLength(0);
    expect(audit.log.recoveries).toHaveLength(0);
  });
});

describe('runLockRenewalTick: hung renewLock timeout (codex C3)', () => {
  test('case 6 — renewLock hangs past callTimeoutMs: Promise.race fires, counter increments', async () => {
    const audit = freshAudit();
    const timer = makeFakeTimer();
    // renewLock never resolves; only the timeout race rejects.
    const deps: LockRenewalDeps = {
      renewLock: () => new Promise<boolean>(() => { /* never resolves */ }),
      audit: audit.sink,
      now: () => 1000,
      setTimeout: timer.setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });

    // Start the tick. It awaits Promise.race; the renewLock promise
    // never resolves, but as soon as we fire the timeout callback, the
    // race rejects.
    const tickPromise = runLockRenewalTick(deps, state);
    // Yield once so the Promise.race actually wires up the deps.setTimeout call.
    await new Promise((r) => setImmediate(r));
    expect(timer.pending.length).toBeGreaterThan(0);
    timer.runAll();

    const result = await tickPromise;
    expect(result).toEqual({ kind: 'ok' }); // counter incremented, within deadline
    expect(state.consecutiveFailures).toBe(1);
    expect(audit.log.failures).toHaveLength(1);
    expect(audit.log.failures[0].err).toBeInstanceOf(Error);
    expect((audit.log.failures[0].err as Error).message).toMatch(/timed out after 10000ms/);
  });
});

describe('runLockRenewalTick: cancellation', () => {
  test('case 7 — cancelled BEFORE tick fires: returns cancelled immediately, no audit, no renewLock call', async () => {
    const audit = freshAudit();
    let renewLockCalled = false;
    const deps: LockRenewalDeps = {
      renewLock: async () => { renewLockCalled = true; return true; },
      audit: audit.sink,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ cancelled: () => true });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'cancelled' });
    expect(renewLockCalled).toBe(false);
    expect(audit.log.failures).toHaveLength(0);
  });

  test('case 8 — cancelled DURING renewLock await (resolved branch): returns cancelled, no audit', async () => {
    const audit = freshAudit();
    let cancelled = false;
    let renewLockResolve: ((v: boolean) => void) | undefined;
    const deps: LockRenewalDeps = {
      renewLock: () => new Promise<boolean>((res) => { renewLockResolve = res; }),
      audit: audit.sink,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ cancelled: () => cancelled });

    const tick = runLockRenewalTick(deps, state);
    // Flip cancelled, THEN resolve the renewLock. The post-await branch
    // must check cancelled and bail.
    cancelled = true;
    renewLockResolve!(true);
    const result = await tick;
    expect(result).toEqual({ kind: 'cancelled' });
    // Even though renewLock returned true, no recovery audit fires
    // because cancelled gated it.
    expect(audit.log.recoveries).toHaveLength(0);
  });

  test('case 9 — cancelled DURING renewLock await (thrown branch): returns cancelled, no audit', async () => {
    const audit = freshAudit();
    let cancelled = false;
    let renewLockReject: ((e: Error) => void) | undefined;
    const deps: LockRenewalDeps = {
      renewLock: () => new Promise<boolean>((_, rej) => { renewLockReject = rej; }),
      audit: audit.sink,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ cancelled: () => cancelled });

    const tick = runLockRenewalTick(deps, state);
    // Flip cancelled, THEN reject. The catch-branch cancellation check
    // must skip the audit AND skip the deadline math.
    cancelled = true;
    renewLockReject!(new Error('would-have-been-logged'));
    const result = await tick;
    expect(result).toEqual({ kind: 'cancelled' });
    expect(audit.log.failures).toHaveLength(0);
    expect(audit.log.gaveUps).toHaveLength(0);
  });
});

describe('runLockRenewalTick: audit defense-in-depth (codex C4)', () => {
  test('case 11 — audit.logFailure throws: tick still returns ok, counter still increments', async () => {
    const audit: LockRenewalAuditSinkLike = {
      logFailure: () => { throw new Error('audit subsystem on fire'); },
      logSuccessAfterFailure: () => { /* noop */ },
      logGaveUp: () => { /* noop */ },
    };
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('outage'); },
      audit,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'ok' });
    expect(state.consecutiveFailures).toBe(1);
  });

  test('case 11b — audit.logGaveUp throws: tick still returns should_abort', async () => {
    const audit: LockRenewalAuditSinkLike = {
      logFailure: () => { /* noop */ },
      logSuccessAfterFailure: () => { /* noop */ },
      logGaveUp: () => { throw new Error('audit subsystem on fire'); },
    };
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('outage'); },
      audit,
      now: () => 26_000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'should_abort', reason: 'lock-renewal-failed' });
  });

  test('case 11c — audit.logSuccessAfterFailure throws: tick still returns ok, counter resets', async () => {
    const audit: LockRenewalAuditSinkLike = {
      logFailure: () => { /* noop */ },
      logSuccessAfterFailure: () => { throw new Error('audit subsystem on fire'); },
      logGaveUp: () => { /* noop */ },
    };
    const deps: LockRenewalDeps = {
      renewLock: async () => true,
      audit,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ consecutiveFailures: 2, lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'ok' });
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastSuccessfulRenewalAt).toBe(1000);
  });
});

describe('resolveLockRenewalKnobs', () => {
  beforeEach(() => { _resetKnobWarningsForTests(); });

  test('case 12a — defaults derive from lockDuration', () => {
    const knobs = resolveLockRenewalKnobs({}, 30_000);
    expect(knobs.maxFailuresForAudit).toBe(3);
    expect(knobs.callTimeoutMs).toBe(10_000);
    expect(knobs.safetyMarginMs).toBe(5_000);
  });

  test('case 12b — valid env values parse cleanly', () => {
    const knobs = resolveLockRenewalKnobs({
      GBRAIN_LOCK_RENEWAL_MAX_FAILURES: '5',
      GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS: '15000',
      GBRAIN_LOCK_RENEWAL_SAFETY_MARGIN_MS: '8000',
    }, 30_000);
    expect(knobs.maxFailuresForAudit).toBe(5);
    expect(knobs.callTimeoutMs).toBe(15_000);
    expect(knobs.safetyMarginMs).toBe(8_000);
  });

  test('case 12c — bad env (abc/-5/0/1.5) falls back to default with single stderr warn', async () => {
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    try {
      _resetKnobWarningsForTests();

      // Each bad value falls back.
      let knobs = resolveLockRenewalKnobs({ GBRAIN_LOCK_RENEWAL_MAX_FAILURES: 'abc' }, 30_000);
      expect(knobs.maxFailuresForAudit).toBe(3);

      knobs = resolveLockRenewalKnobs({ GBRAIN_LOCK_RENEWAL_MAX_FAILURES: '-5' }, 30_000);
      expect(knobs.maxFailuresForAudit).toBe(3);

      knobs = resolveLockRenewalKnobs({ GBRAIN_LOCK_RENEWAL_MAX_FAILURES: '0' }, 30_000);
      expect(knobs.maxFailuresForAudit).toBe(3);

      knobs = resolveLockRenewalKnobs({ GBRAIN_LOCK_RENEWAL_MAX_FAILURES: '1.5' }, 30_000);
      expect(knobs.maxFailuresForAudit).toBe(3);

      // Despite 4 bad invocations, only ONE stderr warn per env-name fired.
      const warnLines = captured.filter((c) => c.includes('GBRAIN_LOCK_RENEWAL_MAX_FAILURES'));
      expect(warnLines).toHaveLength(1);
      expect(warnLines[0]).toContain('not a positive integer');
      expect(warnLines[0]).toContain('falling back to default 3');
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test('case 12d — different env names warn independently', async () => {
    const captured: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    try {
      _resetKnobWarningsForTests();
      resolveLockRenewalKnobs({
        GBRAIN_LOCK_RENEWAL_MAX_FAILURES: 'bad1',
        GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS: 'bad2',
        GBRAIN_LOCK_RENEWAL_SAFETY_MARGIN_MS: 'bad3',
      }, 30_000);
      const warnLines = captured.filter((c) => c.includes('not a positive integer'));
      expect(warnLines).toHaveLength(3);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test('case 14 — maxFailuresForAudit default is 3 (audit-labeling regression)', () => {
    // Pinned as a named-constant regression: a future change here is
    // a deliberate two-line edit (default + this test).
    expect(resolveLockRenewalKnobs({}, 30_000).maxFailuresForAudit).toBe(3);
  });
});

// issue #1678 (Codex #2): the bounded reconnect-once hook. NOT a withRetry on
// renewLock (that races this tick's own timeout); a single pool rebuild before
// the next tick so the next renewLock hits a live connection.
describe('runLockRenewalTick: reconnect-once dep (issue #1678)', () => {
  test('reconnect fires after a renewLock throw within deadline; result still ok', async () => {
    const audit = freshAudit();
    let reconnectCalls = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('write CONNECTION_ENDED'); },
      audit: audit.sink,
      now: () => 1000, // well within deadline
      setTimeout: makeFakeTimer().setTimeout,
      reconnect: async () => { reconnectCalls++; },
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'ok' });
    expect(reconnectCalls).toBe(1);
    expect(state.consecutiveFailures).toBe(1);
  });

  // CODEX impl review #2 (#1685 GAP B): the tick must thread the triggering
  // renewLock error to reconnect, so PostgresEngine.reconnect can classify a
  // CONNECTION_ENDED pooler reap as reap_detected (not reconnect_other) for
  // pool_reap_health. Pin the threading.
  test('reconnect receives the triggering renewLock error', async () => {
    const audit = freshAudit();
    const renewErr = new Error('write CONNECTION_ENDED');
    let received: unknown = 'NOT_CALLED';
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw renewErr; },
      audit: audit.sink,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
      reconnect: async (ctx?: { error?: unknown }) => { received = ctx?.error; },
    };
    const result = await runLockRenewalTick(deps, makeState({ lastSuccessfulRenewalAt: 0 }));
    expect(result).toEqual({ kind: 'ok' });
    expect(received).toBe(renewErr);
  });

  test('a reconnect throw is swallowed — tick still returns ok (no unhandledRejection class)', async () => {
    const audit = freshAudit();
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('Connection terminated unexpectedly'); },
      audit: audit.sink,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
      reconnect: async () => { throw new Error('reconnect failed: EHOSTUNREACH'); },
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'ok' });
  });

  test('reconnect is NOT called on a successful renewal', async () => {
    let reconnectCalls = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => true,
      audit: freshAudit().sink,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
      reconnect: async () => { reconnectCalls++; },
    };
    const result = await runLockRenewalTick(deps, makeState({ lastSuccessfulRenewalAt: 500 }));
    expect(result).toEqual({ kind: 'ok' });
    expect(reconnectCalls).toBe(0);
  });

  test('reconnect is NOT called when the tick aborts at the deadline', async () => {
    let reconnectCalls = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('write CONNECTION_ENDED'); },
      audit: freshAudit().sink,
      // sinceLastSuccess = 30000 - 0 = 30000 >= deadline (30000-5000=25000) → abort
      now: () => 30_000,
      setTimeout: makeFakeTimer().setTimeout,
      reconnect: async () => { reconnectCalls++; },
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'should_abort', reason: 'lock-renewal-failed' });
    expect(reconnectCalls).toBe(0); // pointless to reconnect when we're giving up the lock
  });
});
