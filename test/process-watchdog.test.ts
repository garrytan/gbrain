/**
 * Pure-function coverage for the watchdog state machine (#1633). No threads, no
 * real timers — the spawn-based integration lives in
 * test/process-watchdog.serial.test.ts (Bun-pinned, real processes).
 */
import { describe, test, expect } from 'bun:test';
import {
  watchdogDecision,
  installProcessWatchdog,
  clampWatchdogTimers,
  MAX_WATCHDOG_TIMER_MS,
  stallDecision,
  nextStallLatch,
  stallCheckSawSuspend,
  resolveServeStallWatchdogMs,
  installLoopStallWatchdog,
  SERVE_STALL_FLOOR_MS,
  STALL_DEFAULT_GRACE_MS,
} from '../src/core/process-watchdog.ts';

describe('watchdogDecision', () => {
  const deadline = 1000;
  const grace = 300;

  test('waits before the deadline', () => {
    expect(watchdogDecision(0, deadline, grace)).toBe('wait');
    expect(watchdogDecision(999, deadline, grace)).toBe('wait');
  });

  test('SIGTERM at the deadline boundary (inclusive)', () => {
    expect(watchdogDecision(1000, deadline, grace)).toBe('sigterm');
    expect(watchdogDecision(1299, deadline, grace)).toBe('sigterm');
  });

  test('SIGKILL at deadline+grace boundary (inclusive)', () => {
    expect(watchdogDecision(1300, deadline, grace)).toBe('sigkill');
    expect(watchdogDecision(5000, deadline, grace)).toBe('sigkill');
  });

  test('zero grace goes straight to SIGKILL at the deadline', () => {
    expect(watchdogDecision(999, deadline, 0)).toBe('wait');
    expect(watchdogDecision(1000, deadline, 0)).toBe('sigkill');
  });
});

describe('installProcessWatchdog (handle contract)', () => {
  test('non-positive deadline returns an inert no-op handle', () => {
    const warns: string[] = [];
    const h0 = installProcessWatchdog({ deadlineMs: 0, onWarn: (m) => warns.push(m) });
    expect(h0.active).toBe(false);
    h0.dispose(); // idempotent, no throw
    const hNeg = installProcessWatchdog({ deadlineMs: -5, onWarn: (m) => warns.push(m) });
    expect(hNeg.active).toBe(false);
  });

  test('active handle disposes idempotently without killing the test process', () => {
    // Long deadline so it never fires during the test; dispose tears it down.
    const h = installProcessWatchdog({ deadlineMs: 60_000, graceMs: 60_000, label: 'unit-wd' });
    expect(h.active).toBe(true);
    h.dispose();
    expect(h.active).toBe(false);
    h.dispose(); // second dispose is a no-op
    expect(h.active).toBe(false);
  });

  test('label is sanitized to a safe charset', () => {
    // A nasty label must not throw at construction (it is stripped before the
    // inline worker string). We dispose immediately so nothing fires.
    const h = installProcessWatchdog({ deadlineMs: 60_000, label: "evil'; \n process.exit(1) //" });
    expect(h.active).toBe(true);
    h.dispose();
  });
});

describe('clampWatchdogTimers (#4284 joint-overflow clamp)', () => {
  // Pure-function tests ONLY: setTimeout overflow-fires above 2^31−1, so a
  // buggy clamp armed on a REAL worker would SIGTERM this test process at
  // ~1ms (process.kill(process.pid)). Never arm a max-deadline worker here.
  test('normal values pass through floored', () => {
    expect(clampWatchdogTimers(5000.9, 600.2)).toEqual({ deadlineMs: 5000, graceMs: 600 });
  });

  test('a max deadline forces grace to zero so the SUM timer cannot overflow', () => {
    const { deadlineMs, graceMs } = clampWatchdogTimers(MAX_WATCHDOG_TIMER_MS, 30_000);
    expect(deadlineMs).toBe(MAX_WATCHDOG_TIMER_MS);
    expect(graceMs).toBe(0);
    expect(deadlineMs + graceMs).toBeLessThanOrEqual(MAX_WATCHDOG_TIMER_MS);
  });

  test('an oversized deadline clamps to the ceiling; the sum still fits', () => {
    const { deadlineMs, graceMs } = clampWatchdogTimers(Number.MAX_SAFE_INTEGER, 30_000);
    expect(deadlineMs).toBe(MAX_WATCHDOG_TIMER_MS);
    expect(deadlineMs + graceMs).toBeLessThanOrEqual(MAX_WATCHDOG_TIMER_MS);
  });

  test('a near-ceiling deadline trims grace to exactly fit the sum', () => {
    const { deadlineMs, graceMs } = clampWatchdogTimers(MAX_WATCHDOG_TIMER_MS - 10_000, 30_000);
    expect(deadlineMs).toBe(MAX_WATCHDOG_TIMER_MS - 10_000);
    expect(graceMs).toBe(10_000);
  });

  test('negative grace clamps to zero; NaN deadline flows through for the inert-check', () => {
    expect(clampWatchdogTimers(5000, -1).graceMs).toBe(0);
    // installProcessWatchdog's Number.isFinite inert-check must still see NaN.
    expect(Number.isFinite(clampWatchdogTimers(Number.NaN, 100).deadlineMs)).toBe(false);
  });

  test('NaN grace is coerced to 0, never armed as a ~1ms overflow SIGKILL', () => {
    // setTimeout(deadline + NaN) = setTimeout(NaN) fires at ~1ms — the exact
    // failure class this clamp exists to prevent (multi-specialist finding).
    const { deadlineMs, graceMs } = clampWatchdogTimers(5000, Number.NaN);
    expect(deadlineMs).toBe(5000);
    expect(graceMs).toBe(0);
  });

  test('Infinity deadline clamps to the ceiling and arms (documented contract)', () => {
    // Deliberate: "oversized means longer bound" — an infinite deadline
    // becomes ~24.8 days armed, not inert (see the clamp docstring).
    const { deadlineMs, graceMs } = clampWatchdogTimers(Number.POSITIVE_INFINITY, 30_000);
    expect(deadlineMs).toBe(MAX_WATCHDOG_TIMER_MS);
    expect(deadlineMs + graceMs).toBeLessThanOrEqual(MAX_WATCHDOG_TIMER_MS);
  });

  test('installProcessWatchdog stays inert on NaN and non-positive deadlines post-clamp', () => {
    const h = installProcessWatchdog({ deadlineMs: Number.NaN });
    expect(h.active).toBe(false);
    h.dispose();
  });
});

describe('stallDecision (#4281 loop-stall state machine)', () => {
  const stall = 300;
  const grace = 200;

  test('waits below the stall threshold regardless of latch state', () => {
    expect(stallDecision(0, stall, grace, false)).toBe('wait');
    expect(stallDecision(299, stall, grace, false)).toBe('wait');
    expect(stallDecision(299, stall, grace, true)).toBe('wait');
  });

  test('SIGTERM at the stall boundary (inclusive) when unlatched', () => {
    expect(stallDecision(300, stall, grace, false)).toBe('sigterm');
    expect(stallDecision(499, stall, grace, false)).toBe('sigterm');
  });

  test('latch suppresses a repeat SIGTERM inside the grace window', () => {
    expect(stallDecision(300, stall, grace, true)).toBe('wait');
    expect(stallDecision(499, stall, grace, true)).toBe('wait');
  });

  test('SIGKILL at stall+grace (inclusive) regardless of latch', () => {
    expect(stallDecision(500, stall, grace, false)).toBe('sigkill');
    expect(stallDecision(500, stall, grace, true)).toBe('sigkill');
    expect(stallDecision(60_000, stall, grace, true)).toBe('sigkill');
  });

  test('zero grace escalates straight to SIGKILL at the stall threshold', () => {
    expect(stallDecision(299, stall, 0, false)).toBe('wait');
    expect(stallDecision(300, stall, 0, false)).toBe('sigkill');
  });

  test('recovered lag after a latch returns wait — a petting loop is never killed', () => {
    // The SIGTERM already went out (latched); if the loop recovered and pets
    // resumed, lag drops below stall and the SIGKILL escalation MUST not fire.
    expect(stallDecision(10, stall, grace, true)).toBe('wait');
  });
});

describe('nextStallLatch (wave-D review: latch resets on recovery)', () => {
  const stall = 300;
  const grace = 200;

  test('arms on sigterm, holds through the same stall, resets on recovery', () => {
    let latched = false;
    // First stall crosses the threshold → SIGTERM, latch arms.
    let action = stallDecision(300, stall, grace, latched);
    expect(action).toBe('sigterm');
    latched = nextStallLatch(action, 300, stall, latched);
    expect(latched).toBe(true);
    // Still the SAME stall (in-grace lag): no SIGTERM spam, latch holds.
    action = stallDecision(450, stall, grace, latched);
    expect(action).toBe('wait');
    latched = nextStallLatch(action, 450, stall, latched);
    expect(latched).toBe(true);
    // Pets resume, lag collapses below stall: latch RESETS.
    action = stallDecision(10, stall, grace, latched);
    expect(action).toBe('wait');
    latched = nextStallLatch(action, 10, stall, latched);
    expect(latched).toBe(false);
  });

  test('a recovered-then-restalled loop gets a fresh SIGTERM before SIGKILL', () => {
    // Lifetime latch (pre-fix): the second stall's graceful window was
    // silently skipped — the process waited mute until the SIGKILL line.
    let latched = true; // SIGTERM already sent for a PREVIOUS stall
    latched = nextStallLatch('wait', 5, stall, latched); // recovery tick
    expect(latched).toBe(false);
    // Re-stall: lag past stall, still inside grace → SIGTERM fires AGAIN.
    expect(stallDecision(350, stall, grace, latched)).toBe('sigterm');
  });

  test('the latch never resets mid-stall (one SIGTERM per stall window)', () => {
    let latched = true;
    latched = nextStallLatch('wait', 450, stall, latched); // lag still >= stall
    expect(latched).toBe(true);
    expect(stallDecision(450, stall, grace, latched)).toBe('wait');
  });

  test('sigkill ticks do not disturb the latch', () => {
    expect(nextStallLatch('sigkill', 600, stall, true)).toBe(true);
  });
});

describe('stallCheckSawSuspend (#4281 suspend forgiveness)', () => {
  test('a normal check cadence is not a suspend', () => {
    expect(stallCheckSawSuspend(25, 25)).toBe(false);
    expect(stallCheckSawSuspend(80, 25)).toBe(false);
  });

  test('a check gap past max(5x interval, 2s) is a suspend (laptop-lid wake must not SIGKILL)', () => {
    expect(stallCheckSawSuspend(3000, 25)).toBe(true);      // 2s floor governs
    expect(stallCheckSawSuspend(10_000, 1000)).toBe(true);  // 5x interval governs
  });

  test('below the 5x-interval line with a large interval is still normal jitter', () => {
    // interval 1000 -> threshold max(5000, 2000) = 5000; 4000 is jitter, not suspend
    expect(stallCheckSawSuspend(4000, 1000)).toBe(false);
  });
});

describe('resolveServeStallWatchdogMs (#4281 env knob)', () => {
  const collect = () => {
    const warns: string[] = [];
    return { warns, warn: (m: string) => warns.push(m) };
  };

  test('unset / blank means OFF, silently (opt-in knob)', () => {
    const { warns, warn } = collect();
    expect(resolveServeStallWatchdogMs(undefined, warn)).toBe(0);
    expect(resolveServeStallWatchdogMs('', warn)).toBe(0);
    expect(resolveServeStallWatchdogMs('   ', warn)).toBe(0);
    expect(warns).toEqual([]);
  });

  test('explicit 0 is a documented OFF, no warning', () => {
    const { warns, warn } = collect();
    expect(resolveServeStallWatchdogMs('0', warn)).toBe(0);
    expect(warns).toEqual([]);
  });

  test('garbage values warn and stay OFF (a typo must not arm a killer)', () => {
    for (const raw of ['abc', '15s', '-1', 'Infinity', 'NaN']) {
      const { warns, warn } = collect();
      expect(resolveServeStallWatchdogMs(raw, warn)).toBe(0);
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain('GBRAIN_SERVE_STALL_WATCHDOG_MS');
    }
  });

  test('below the 15s floor clamps UP with a warning (never a hair-trigger)', () => {
    const { warns, warn } = collect();
    expect(resolveServeStallWatchdogMs('5000', warn)).toBe(SERVE_STALL_FLOOR_MS);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('floor');
  });

  test('at/above the floor passes through, floored to an integer', () => {
    const { warns, warn } = collect();
    expect(resolveServeStallWatchdogMs('15000', warn)).toBe(15_000);
    expect(resolveServeStallWatchdogMs('61000.9', warn)).toBe(61_000);
    expect(warns).toEqual([]);
  });

  test('the floor constant is 15s and the default grace is 30s (plan #4281 contract)', () => {
    expect(SERVE_STALL_FLOOR_MS).toBe(15_000);
    expect(STALL_DEFAULT_GRACE_MS).toBe(30_000);
  });
});

describe('installLoopStallWatchdog (handle contract)', () => {
  test('non-positive / NaN stallMs returns an inert no-op handle', () => {
    for (const stallMs of [0, -5, Number.NaN]) {
      const h = installLoopStallWatchdog({ stallMs });
      expect(h.active).toBe(false);
      h.dispose(); // idempotent, no throw
    }
  });

  test('active handle disposes idempotently without killing the test process', () => {
    // Long stall so nothing can fire during the test; dispose tears down the
    // worker and the pet interval.
    const h = installLoopStallWatchdog({ stallMs: 60_000, graceMs: 60_000, label: 'unit-stall' });
    expect(h.active).toBe(true);
    h.dispose();
    expect(h.active).toBe(false);
    h.dispose(); // second dispose is a no-op
    expect(h.active).toBe(false);
  });

  test('label is sanitized to a safe charset', () => {
    const h = installLoopStallWatchdog({ stallMs: 60_000, label: "evil'; \n process.exit(1) //" });
    expect(h.active).toBe(true);
    h.dispose();
  });
});
