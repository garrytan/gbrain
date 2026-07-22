/**
 * v0.41.6.0 D4 — tryRunPendingMigrations + isDeadlockError.
 *
 * Hermetic unit tests using the `_hooks` test seam — no real DB needed.
 * Verifies the retry-and-poll contract:
 *
 *   1. first attempt succeeds → status: 'ok'
 *   2. 40P01 once → retry succeeds → status: 'ok'
 *   3. 40P01 twice + hasPending flips to false → status: 'race_resolved'
 *   4. 40P01 twice + hasPending stays true past deadline → status: 'persistent'
 *   5. non-40P01 error propagates as status: 'error'
 *   6. not_needed early-exit when hasPending returns false up front
 *   7. 250ms poll interval honored (custom interval respected)
 *   8. isDeadlockError matches SQLSTATE 40P01 in code field
 *   9. isDeadlockError matches "deadlock detected" in message text
 */
import { describe, test, expect } from 'bun:test';
import {
  tryRunPendingMigrations,
  isDeadlockError,
  type TryRunPendingMigrationsResult,
} from '../src/core/migrate.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Fake engine for typing — never used because _hooks override everything.
const fakeEngine = {} as BrainEngine;

class FakeDeadlock extends Error {
  code = '40P01';
  constructor() { super('deadlock detected'); this.name = 'FakeDeadlock'; }
}

describe('isDeadlockError', () => {
  test('matches SQLSTATE 40P01 in `.code`', () => {
    expect(isDeadlockError({ code: '40P01', message: 'whatever' })).toBe(true);
  });

  test('matches SQLSTATE 40P01 in `.sqlState`', () => {
    expect(isDeadlockError({ sqlState: '40P01', message: 'whatever' })).toBe(true);
  });

  test('matches "deadlock detected" in message text (driver-shape independent)', () => {
    expect(isDeadlockError(new Error('ERROR: deadlock detected'))).toBe(true);
  });

  test('matches the literal "40P01" token in message', () => {
    expect(isDeadlockError(new Error('Postgres returned 40P01'))).toBe(true);
  });

  test('returns false for non-deadlock errors', () => {
    expect(isDeadlockError(new Error('connection refused'))).toBe(false);
    expect(isDeadlockError({ code: '23505', message: 'duplicate key' })).toBe(false);
  });

  test('returns false for null/undefined', () => {
    expect(isDeadlockError(null)).toBe(false);
    expect(isDeadlockError(undefined)).toBe(false);
  });
});

describe('tryRunPendingMigrations', () => {
  test('returns not_needed when hasPending returns false up front', async () => {
    const result = await tryRunPendingMigrations(fakeEngine, {
      _hooks: {
        hasPending: async () => false,
        initSchema: async () => { throw new Error('should not be called'); },
      },
    });
    expect(result.status).toBe('not_needed');
  });

  test('returns ok when first initSchema succeeds', async () => {
    let initCalls = 0;
    const result = await tryRunPendingMigrations(fakeEngine, {
      _hooks: {
        hasPending: async () => true,
        initSchema: async () => { initCalls++; },
      },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.attempts).toBe(1);
    expect(initCalls).toBe(1);
  });

  test('returns ok after one 40P01 + retry succeeds', async () => {
    let initCalls = 0;
    const result = await tryRunPendingMigrations(fakeEngine, {
      retryBackoffMs: 0, // skip the real backoff for test speed
      _hooks: {
        hasPending: async () => true,
        initSchema: async () => {
          initCalls++;
          if (initCalls === 1) throw new FakeDeadlock();
        },
      },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.attempts).toBe(2);
    expect(initCalls).toBe(2);
  });

  test('returns race_resolved when both attempts deadlock but hasPending flips to false', async () => {
    let initCalls = 0;
    let pendingCallCount = 0;
    const result = await tryRunPendingMigrations(fakeEngine, {
      retryBackoffMs: 0,
      pollIntervalMs: 5,
      deadlineMs: 100,
      _hooks: {
        hasPending: async () => {
          pendingCallCount++;
          // Entry-call always pending; after a couple of poll iterations,
          // flip to false (simulating another runner finishing the migration).
          if (pendingCallCount <= 3) return true;
          return false;
        },
        initSchema: async () => { initCalls++; throw new FakeDeadlock(); },
      },
    });
    expect(result.status).toBe('race_resolved');
    if (result.status === 'race_resolved') {
      expect(result.attempts).toBe(2); // exhausted retries
      expect(result.pollIterations).toBeGreaterThan(0);
    }
    expect(initCalls).toBe(2);
  });

  test('returns persistent when both attempts deadlock + hasPending stays true past deadline', async () => {
    const result = await tryRunPendingMigrations(fakeEngine, {
      retryBackoffMs: 0,
      pollIntervalMs: 10,
      deadlineMs: 50, // tight deadline for test speed
      _hooks: {
        hasPending: async () => true, // never resolves
        initSchema: async () => { throw new FakeDeadlock(); },
      },
    });
    expect(result.status).toBe('persistent');
    if (result.status === 'persistent') {
      expect(result.attempts).toBe(2);
      expect(result.pollIterations).toBeGreaterThan(0);
      expect(isDeadlockError(result.error)).toBe(true);
    }
  });

  test('returns error when first initSchema throws a non-40P01 error', async () => {
    const realFailure = new Error('connection refused');
    const result = await tryRunPendingMigrations(fakeEngine, {
      _hooks: {
        hasPending: async () => true,
        initSchema: async () => { throw realFailure; },
      },
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error).toBe(realFailure);
  });

  test('returns error when second attempt throws non-40P01 (real failure beats deadlock)', async () => {
    let initCalls = 0;
    const realFailure = new Error('disk full');
    const result = await tryRunPendingMigrations(fakeEngine, {
      retryBackoffMs: 0,
      _hooks: {
        hasPending: async () => true,
        initSchema: async () => {
          initCalls++;
          if (initCalls === 1) throw new FakeDeadlock();
          throw realFailure;
        },
      },
    });
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error).toBe(realFailure);
  });

  test('honors custom pollIntervalMs (test seam allows tight intervals)', async () => {
    let pollCalls = 0;
    const result = await tryRunPendingMigrations(fakeEngine, {
      retryBackoffMs: 0,
      pollIntervalMs: 1,
      deadlineMs: 30,
      _hooks: {
        hasPending: async () => { pollCalls++; return true; },
        initSchema: async () => { throw new FakeDeadlock(); },
      },
    });
    expect(result.status).toBe('persistent');
    // pollCalls = 1 (initial check) + many polling iterations.
    expect(pollCalls).toBeGreaterThan(5);
  });
});
