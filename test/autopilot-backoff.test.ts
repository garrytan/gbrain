import { describe, test, expect } from 'bun:test';
import {
  computeFailureBackoff,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  DEFAULT_BACKOFF_CAP_MS,
} from '../src/commands/autopilot-backoff.ts';

// Regression coverage for https://github.com/garrytan/gbrain/issues/168:
// autopilot used to exit hard after 5 consecutive failures. A single
// transient Postgres event (pgbouncer reset, Supabase minor version
// upgrade, network blip) reliably tripped that cap. The fix routes the
// failure through computeFailureBackoff, which grows the counter AND
// grows the sleep interval exponentially, so the daemon rides through
// transient events instead of committing suicide on the first one.

describe('computeFailureBackoff (issue #168)', () => {
  test('does NOT shouldExit at the old-threshold (5 failures) when maxErrors=20', () => {
    // Walk 5 cycles of failures. With the pre-fix threshold of 5 the
    // daemon would have bailed; with maxErrors=20 it must keep running.
    let state = { consecutiveErrors: 0 };
    const opts = { maxErrors: 20, baseIntervalMs: 300_000 };
    for (let i = 0; i < 5; i++) {
      const r = computeFailureBackoff(state, opts);
      state = { consecutiveErrors: r.consecutiveErrors };
      expect(r.shouldExit).toBe(false);
    }
    expect(state.consecutiveErrors).toBe(5);
  });

  test('increments consecutiveErrors by exactly 1 per call', () => {
    expect(
      computeFailureBackoff({ consecutiveErrors: 0 }, { maxErrors: 20, baseIntervalMs: 1000 })
        .consecutiveErrors,
    ).toBe(1);
    expect(
      computeFailureBackoff({ consecutiveErrors: 7 }, { maxErrors: 20, baseIntervalMs: 1000 })
        .consecutiveErrors,
    ).toBe(8);
  });

  test('shouldExit flips true only when counter reaches maxErrors', () => {
    // 19th failure: not yet.
    expect(
      computeFailureBackoff({ consecutiveErrors: 18 }, { maxErrors: 20, baseIntervalMs: 1000 })
        .shouldExit,
    ).toBe(false);
    // 20th failure: exit.
    expect(
      computeFailureBackoff({ consecutiveErrors: 19 }, { maxErrors: 20, baseIntervalMs: 1000 })
        .shouldExit,
    ).toBe(true);
  });

  test('sleepMs grows exponentially from baseIntervalMs', () => {
    const base = 10_000;
    const opts = { maxErrors: 99, baseIntervalMs: base };
    // next=1 -> 1x, next=2 -> 2x, next=3 -> 4x, next=4 -> 8x
    expect(computeFailureBackoff({ consecutiveErrors: 0 }, opts).sleepMs).toBe(base * 1);
    expect(computeFailureBackoff({ consecutiveErrors: 1 }, opts).sleepMs).toBe(base * 2);
    expect(computeFailureBackoff({ consecutiveErrors: 2 }, opts).sleepMs).toBe(base * 4);
    expect(computeFailureBackoff({ consecutiveErrors: 3 }, opts).sleepMs).toBe(base * 8);
  });

  test('sleepMs is clamped to backoffCapMs on long runs', () => {
    const r = computeFailureBackoff(
      { consecutiveErrors: 50 },
      { maxErrors: 999, baseIntervalMs: 60_000, backoffCapMs: 30 * 60_000 },
    );
    expect(r.sleepMs).toBeLessThanOrEqual(30 * 60_000);
    expect(r.sleepMs).toBe(30 * 60_000);
  });

  test('default cap is 30 minutes and default max is 20', () => {
    expect(DEFAULT_MAX_CONSECUTIVE_ERRORS).toBe(20);
    expect(DEFAULT_BACKOFF_CAP_MS).toBe(30 * 60_000);
  });

  test('pure function — same input returns same output', () => {
    const a = computeFailureBackoff({ consecutiveErrors: 3 }, { maxErrors: 10, baseIntervalMs: 500 });
    const b = computeFailureBackoff({ consecutiveErrors: 3 }, { maxErrors: 10, baseIntervalMs: 500 });
    expect(a).toEqual(b);
  });
});
