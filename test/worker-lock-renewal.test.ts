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
  failures: Array<{ jobId: number; jobName: string; attempt: number; err: unknown; ctx?: unknown }>;
  recoveries: Array<{ jobId: number; jobName: string; recoveredAfterAttempts: number; ctx?: unknown }>;
  gaveUps: Array<{ jobId: number; jobName: string; totalFailures: number; err: unknown; ctx?: unknown }>;
}

function freshAudit(): { sink: LockRenewalAuditSinkLike; log: AuditLog } {
  const log: AuditLog = { failures: [], recoveries: [], gaveUps: [] };
  return {
    log,
    sink: {
      logFailure: (jobId, jobName, attempt, err, ctx) =>
        log.failures.push({ jobId, jobName, attempt, err, ctx }),
      logSuccessAfterFailure: (jobId, jobName, recoveredAfterAttempts, ctx) =>
        log.recoveries.push({ jobId, jobName, recoveredAfterAttempts, ctx }),
      logGaveUp: (jobId, jobName, totalFailures, err, ctx) =>
        log.gaveUps.push({ jobId, jobName, totalFailures, err, ctx }),
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
  hardEvictMs: 60_000, // 2 × lockDuration (the #4145 backstop)
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
    // v0.46 (#4145) telemetry fields: cadence for lateness math, seeded
    // previous-tick timestamp, and the worker-maintained overlap counter.
    intervalMs: DEFAULT_LOCK_MS / 2,
    lastTickFiredAt: 0,
    overlapSkips: 0,
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

describe('runLockRenewalTick: verify-before-evict + hard backstop (#4145)', () => {
  test('case 4 — sustained throws past the SOFT deadline are DEFERRED (verify attempted), abort only past hardEvictMs', async () => {
    const audit = freshAudit();
    // Soft deadline = 30000 - 5000 = 25000; hardEvict = 60000.
    // At 26s of failure the pre-#4145 code aborted — the incident. Now the
    // tick attempts a verify (which also throws here) and DEFERS.
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('persistent outage'); },
      audit: audit.sink,
      now: () => 26_000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0, consecutiveFailures: 2 });
    const deferred = await runLockRenewalTick(deps, state);
    expect(deferred).toEqual({ kind: 'ok' });
    // Primary attempt (3) + failed verify (4), the latter deadline_deferred.
    expect(state.consecutiveFailures).toBe(4);
    expect(audit.log.failures).toHaveLength(2);
    expect(audit.log.failures[1].ctx).toMatchObject({ deadline_deferred: true, cause: 'refused' });
    expect(audit.log.gaveUps).toHaveLength(0);

    // Past the hard backstop the tick gives up: primary (5) + verify (6),
    // gave_up carries the classified cause + starvation telemetry.
    // lateness = max(0, 61000 - 26000 - 15000) = 20000.
    const hardDeps: LockRenewalDeps = { ...deps, now: () => 61_000 };
    const result = await runLockRenewalTick(hardDeps, state);
    expect(result).toMatchObject({
      kind: 'should_abort',
      reason: 'lock-renewal-failed',
      cause: 'refused',
      sinceLastSuccessMs: 61_000,
      latenessMs: 20_000,
      overlapSkips: 0,
    });
    expect(state.consecutiveFailures).toBe(6);
    expect(audit.log.gaveUps).toHaveLength(1);
    expect(audit.log.gaveUps[0].totalFailures).toBe(6);
  });

  test('case 10 — INCIDENT REPLAY: renewal times out under starvation, verify succeeds → job survives', async () => {
    // The #4145 incident shape: the event loop starves, the renewal's
    // 10s race timeout wins even though the DB is healthy (external
    // SELECT 1 probes ran 32ms). Pre-fix: abort at the 25s deadline,
    // discarding ~173s of LLM work. Post-fix: ONE fenced verify — the
    // DB is the authority — recovers the lease and the job survives.
    const audit = freshAudit();
    let calls = 0;
    const timer = makeFakeTimer();
    const deps: LockRenewalDeps = {
      renewLock: async () => {
        calls++;
        if (calls === 1) return new Promise<boolean>(() => { /* starved: never settles */ });
        return true; // the verify — DB was healthy all along
      },
      audit: audit.sink,
      now: () => 26_000, // past the soft deadline of 25000
      setTimeout: timer.setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const pending = runLockRenewalTick(deps, state);
    timer.runAll(); // fire the primary race timeout (the starvation symptom)
    const result = await pending;
    expect(result).toEqual({ kind: 'ok' }); // NO abort — the incident fix
    expect(state.consecutiveFailures).toBe(0); // verify-success resets
    expect(state.lastSuccessfulRenewalAt).toBe(26_000);
    expect(audit.log.failures).toHaveLength(1); // the primary call-timeout
    expect(audit.log.failures[0].ctx).toMatchObject({ cause: 'call-timeout' });
    expect(audit.log.recoveries).toHaveLength(1);
    expect(audit.log.recoveries[0].ctx).toMatchObject({ via: 'verify' });
    expect(audit.log.gaveUps).toHaveLength(0);
  });

  test('case 10b — verify returns fenced-false: CERTAIN loss → lock_lost via verify', async () => {
    const audit = freshAudit();
    let calls = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => {
        calls++;
        if (calls === 1) throw new Error('outage');
        return false; // the stall sweep reclaimed the row during the blip
      },
      audit: audit.sink,
      now: () => 26_000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'lock_lost', cause: 'fenced-lost', via: 'verify' });
    expect(audit.log.gaveUps).toHaveLength(0); // certain loss ≠ infrastructure gave-up
  });

  test('case 10c — CDX-4 cadence quantization: 300s lease / 60s cadence verifies at 240s with lease remaining', async () => {
    // With the bare `>= deadline` gate there is NO tick between 240s and
    // lease expiry (300s): deadline 270s is unreachable and the first
    // eligible tick is already past expiry. The next-tick-too-late form
    // (sinceLastSuccess + intervalMs >= deadline) verifies at 240s.
    const audit = freshAudit();
    const knobs: LockRenewalKnobs = {
      maxFailuresForAudit: 3,
      callTimeoutMs: 15_000,
      safetyMarginMs: 30_000, // deadline = 270_000
      hardEvictMs: 600_000,
    };
    let calls = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => {
        calls++;
        if (calls === 1) throw new Error('blip at the 240s tick');
        return true; // verify recovers with 60s of lease left
      },
      audit: audit.sink,
      now: () => 240_000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({
      lockDurationMs: 300_000,
      knobs,
      intervalMs: 60_000,
      lastSuccessfulRenewalAt: 0,
      lastTickFiredAt: 180_000,
    });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'ok' });
    expect(calls).toBe(2); // primary + verify — the verify DID fire at 240s
    expect(audit.log.recoveries[0].ctx).toMatchObject({ via: 'verify' });

    // Control: at the 180s tick (180 + 60 = 240 < 270) no verify fires.
    calls = 0;
    const controlState = makeState({
      lockDurationMs: 300_000,
      knobs,
      intervalMs: 60_000,
      lastSuccessfulRenewalAt: 0,
      lastTickFiredAt: 120_000,
    });
    const controlDeps: LockRenewalDeps = {
      ...deps,
      renewLock: async () => { calls++; throw new Error('blip'); },
      now: () => 180_000,
    };
    expect(await runLockRenewalTick(controlDeps, controlState)).toEqual({ kind: 'ok' });
    expect(calls).toBe(1); // primary only — deferred to the next tick
  });

  test('case 10d — ENG-E1 pin: 30s default verifies on the FIRST failed tick (15s), strictly safer than abort-at-30s', async () => {
    // interval 15s, deadline 25s: at the t=15s tick, 15000 + 15000 >= 25000
    // → the verify fires immediately on the first failure. This is the
    // accepted timing behavior — a renewal(≤10s) + verify(≤10s) pair can
    // span 20s and skip one tick via tickInFlight; benign because a
    // verify-success re-extends the lease.
    let calls = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => {
        calls++;
        if (calls === 1) throw new Error('first-tick blip');
        return true;
      },
      audit: freshAudit().sink,
      now: () => 15_000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    expect(await runLockRenewalTick(deps, state)).toEqual({ kind: 'ok' });
    expect(calls).toBe(2);
    expect(state.lastSuccessfulRenewalAt).toBe(15_000);
  });

  test('case 10e — cancelled() flips mid-verify: returns cancelled, no abort', async () => {
    let cancelled = false;
    let calls = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => {
        calls++;
        if (calls === 1) throw new Error('outage');
        cancelled = true; // the job ends while the verify is in flight
        return true;
      },
      audit: freshAudit().sink,
      now: () => 26_000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0, cancelled: () => cancelled });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'cancelled' });
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
    // v0.46 (#4145): lock_lost names its cause — the fenced UPDATE matched
    // 0 rows, the only CERTAIN loss signal.
    expect(result).toEqual({ kind: 'lock_lost', cause: 'fenced-lost', via: 'renewal' });
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
      // Past hardEvictMs (60000) so the verify-throws path reaches gave_up.
      now: () => 61_000,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toMatchObject({ kind: 'should_abort', reason: 'lock-renewal-failed' });
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

  test('case 15a — hardEvictMs defaults to 2×lockDuration; env override + floor to soft deadline (#4145)', () => {
    _resetKnobWarningsForTests();
    expect(resolveLockRenewalKnobs({}, 30_000).hardEvictMs).toBe(60_000);
    expect(resolveLockRenewalKnobs({ GBRAIN_LOCK_RENEWAL_HARD_EVICT_MS: '120000' }, 30_000).hardEvictMs).toBe(120_000);
    // Below the soft deadline (25000) → warn-and-floor to the deadline.
    const floored = resolveLockRenewalKnobs({ GBRAIN_LOCK_RENEWAL_HARD_EVICT_MS: '1000' }, 30_000);
    expect(floored.hardEvictMs).toBe(25_000);
  });

  test('case 15b — CDX-10 relational validation: margin >= lease/2 and callTimeout > cadence are clamped', () => {
    _resetKnobWarningsForTests();
    // Margin 20000 >= 30000/2 → clamped back to the default (5000).
    const m = resolveLockRenewalKnobs({ GBRAIN_LOCK_RENEWAL_SAFETY_MARGIN_MS: '20000' }, 30_000);
    expect(m.safetyMarginMs).toBe(5_000);
    // Call timeout 20000 > cadence 15000 → clamped to the cadence.
    const c = resolveLockRenewalKnobs({ GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS: '20000' }, 30_000, 15_000);
    expect(c.callTimeoutMs).toBe(15_000);
    // A valid env override still wins untouched (env-beats-default, passes validation).
    const ok = resolveLockRenewalKnobs({ GBRAIN_LOCK_RENEWAL_CALL_TIMEOUT_MS: '12000' }, 30_000, 15_000);
    expect(ok.callTimeoutMs).toBe(12_000);
  });

  test('case 15c — per-job lease knob derivation: 300s lease gets capped 15s/30s defaults + 600s hardEvict', () => {
    _resetKnobWarningsForTests();
    const knobs = resolveLockRenewalKnobs({}, 300_000, 60_000);
    expect(knobs.hardEvictMs).toBe(600_000);
    // The lock/3 and lock/6 derivations CAP at 15s/30s for long leases —
    // a 100s call timeout would wedge tickInFlight across cadence windows.
    expect(knobs.callTimeoutMs).toBe(15_000);
    expect(knobs.safetyMarginMs).toBe(30_000);
    // 30s worker default keeps today's numbers exactly.
    const legacy = resolveLockRenewalKnobs({}, 30_000, 15_000);
    expect(legacy.callTimeoutMs).toBe(10_000);
    expect(legacy.safetyMarginMs).toBe(5_000);
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

  test('reconnect IS called on a deadline DEFERRAL (CEO-F3: next tick needs a live pool)', async () => {
    let reconnectCalls = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('write CONNECTION_ENDED'); },
      audit: freshAudit().sink,
      // Past the soft deadline (25000) but inside hardEvict (60000):
      // primary throw → verify throw → DEFER, reconnect-once for next tick.
      now: () => 30_000,
      setTimeout: makeFakeTimer().setTimeout,
      reconnect: async () => { reconnectCalls++; },
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'ok' }); // deferred, not aborted
    expect(reconnectCalls).toBe(1);
  });

  test('reconnect is NOT called when the tick gives up past hardEvictMs', async () => {
    let reconnectCalls = 0;
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('write CONNECTION_ENDED'); },
      audit: freshAudit().sink,
      now: () => 61_000, // past hardEvict (60000) → gave_up
      setTimeout: makeFakeTimer().setTimeout,
      reconnect: async () => { reconnectCalls++; },
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toMatchObject({ kind: 'should_abort', reason: 'lock-renewal-failed' });
    expect(reconnectCalls).toBe(0); // pointless to reconnect when we're giving up the lock
  });
});

// =============================================================================
// v0.46 (#4145) — failure-cause classification + starvation telemetry
// =============================================================================

describe('runLockRenewalTick: telemetry (issue #4145)', () => {
  test('case 13a — race timeout classifies as call-timeout (named error, not message-sniff)', async () => {
    const audit = freshAudit();
    const timer = makeFakeTimer();
    const deps: LockRenewalDeps = {
      renewLock: () => new Promise<boolean>(() => { /* hangs forever */ }),
      audit: audit.sink,
      now: () => 61_000, // past hardEvict so the verify-throws path aborts
      setTimeout: timer.setTimeout,
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const pending = runLockRenewalTick(deps, state);
    timer.runAll(); // fire the PRIMARY race timeout
    await new Promise(r => globalThis.setTimeout(r, 0)); // let the catch schedule the verify
    timer.runAll(); // fire the VERIFY race timeout
    const result = await pending;
    expect(result).toMatchObject({ kind: 'should_abort', cause: 'call-timeout' });
  });

  test('case 13b — audit failure events carry cause + lateness + overlap_skips ctx (primary + deferred verify)', async () => {
    const ctxLog: unknown[] = [];
    const audit: LockRenewalAuditSinkLike = {
      logFailure: (_id, _name, _attempt, _err, ctx) => { ctxLog.push(ctx); },
      logSuccessAfterFailure: () => { /* noop */ },
      logGaveUp: () => { /* noop */ },
    };
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('outage'); },
      audit,
      // lateness = max(0, 20000 - 0 - 15000) = 5000. 20000 + 15000 >= 25000
      // → the verify fires (and also throws) → a second, deferred failure.
      now: () => 20_000,
      setTimeout: makeFakeTimer().setTimeout,
      loadSnapshot: () => ({ load1: 28.5, cores: 32 }),
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0, overlapSkips: 3 });
    const result = await runLockRenewalTick(deps, state);
    expect(result).toEqual({ kind: 'ok' });
    expect(ctxLog).toHaveLength(2);
    expect(ctxLog[0]).toMatchObject({
      cause: 'refused',
      lateness_ms: 5_000,
      overlap_skips: 3,
      load1: 28.5,
      cores: 32,
    });
    expect(ctxLog[1]).toMatchObject({ cause: 'refused', deadline_deferred: true });
    expect(state.consecutiveFailures).toBe(2); // primary + verify each count
  });

  test('case 13c — a THROWING loadSnapshot never breaks the tick (CEO-F2)', async () => {
    const audit = freshAudit();
    const deps: LockRenewalDeps = {
      renewLock: async () => { throw new Error('outage'); },
      audit: audit.sink,
      now: () => 61_000, // past hardEvict → the verify-throws path aborts
      setTimeout: makeFakeTimer().setTimeout,
      loadSnapshot: () => { throw new Error('os.loadavg exploded'); },
    };
    const state = makeState({ lastSuccessfulRenewalAt: 0 });
    const result = await runLockRenewalTick(deps, state);
    // Still aborts cleanly; load fields simply absent.
    expect(result).toMatchObject({ kind: 'should_abort', cause: 'refused' });
    expect('load1' in result).toBe(false);
  });

  test('case 13d — onRenewalSuccess fires on success (R2-9 histogram reset hook) and its throw is swallowed', async () => {
    let resets = 0;
    const okDeps: LockRenewalDeps = {
      renewLock: async () => true,
      audit: freshAudit().sink,
      now: () => 1000,
      setTimeout: makeFakeTimer().setTimeout,
      onRenewalSuccess: () => { resets++; },
    };
    expect(await runLockRenewalTick(okDeps, makeState())).toEqual({ kind: 'ok' });
    expect(resets).toBe(1);

    const throwingDeps: LockRenewalDeps = {
      ...okDeps,
      onRenewalSuccess: () => { throw new Error('histogram on fire'); },
    };
    expect(await runLockRenewalTick(throwingDeps, makeState())).toEqual({ kind: 'ok' });
  });

  test('case 13e — lateness baseline advances every tick (coalesced-timer semantics)', async () => {
    let nowMs = 15_000; // exactly one interval after the seeded baseline (0)
    const deps: LockRenewalDeps = {
      renewLock: async () => true,
      audit: freshAudit().sink,
      now: () => nowMs,
      setTimeout: makeFakeTimer().setTimeout,
    };
    const state = makeState();
    await runLockRenewalTick(deps, state);
    expect(state.lastTickFiredAt).toBe(15_000); // baseline advanced

    // Next tick fires 61s later (starved past hardEvict — verify throws too):
    // lateness = 76000 - 15000 - 15000 = 46000 attributes the miss to LOCAL
    // starvation; sinceLastSuccess = 76000 - 15000 = 61000 >= 60000 → abort.
    nowMs = 76_000;
    const failDeps: LockRenewalDeps = { ...deps, renewLock: async () => { throw new Error('x'); } };
    const result = await runLockRenewalTick(failDeps, state);
    expect(result).toMatchObject({ kind: 'should_abort', latenessMs: 46_000, sinceLastSuccessMs: 61_000 });
  });
});

describe('runLockRenewalTick: per-call cancellation signal (issue #6)', () => {
  test('renewLock receives a live AbortSignal; not aborted on the happy path', async () => {
    const audit = freshAudit();
    const timer = makeFakeTimer();
    let seenSignal: AbortSignal | undefined;
    const deps: LockRenewalDeps = {
      renewLock: async (_id, _tok, _dur, opts) => {
        seenSignal = opts?.signal;
        return true;
      },
      audit: audit.sink,
      now: () => 1000,
      setTimeout: timer.setTimeout,
    };
    const result = await runLockRenewalTick(deps, makeState());
    expect(result.kind).toBe('ok');
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(false);
  });

  test('hung renewLock: the timeout aborts the per-call signal so the query is cancelled, not orphaned', async () => {
    const audit = freshAudit();
    const timer = makeFakeTimer();
    let seenSignal: AbortSignal | undefined;
    const deps: LockRenewalDeps = {
      renewLock: (_id, _tok, _dur, opts) => {
        seenSignal = opts?.signal;
        return new Promise<boolean>(() => { /* hangs forever — abandoned racer */ });
      },
      audit: audit.sink,
      now: () => 1000,
      setTimeout: timer.setTimeout,
    };
    // Renewed recently: the timeout counts as failure #1, not a give-up.
    const state = makeState({ lastSuccessfulRenewalAt: 1000 });
    const tick = runLockRenewalTick(deps, state);
    // The race installs the timeout synchronously; firing it must abort the
    // per-call signal (this is what releases the checked-out pool slot).
    timer.runAll();
    const result = await tick;
    expect(result.kind).toBe('ok'); // counter bumped, deadline not yet crossed
    expect(state.consecutiveFailures).toBe(1);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal!.aborted).toBe(true);
  });
});
