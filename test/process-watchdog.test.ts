/**
 * Pure-function coverage for the watchdog state machine (#1633). No threads, no
 * real timers — the spawn-based integration lives in
 * test/process-watchdog.serial.test.ts (Bun-pinned, real processes).
 */
import { describe, test, expect } from 'bun:test';
import { watchdogDecision, installProcessWatchdog, clampWatchdogTimers, MAX_WATCHDOG_TIMER_MS } from '../src/core/process-watchdog.ts';

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
