/**
 * Pure-function coverage for the watchdog state machine (#1633). No threads, no
 * real timers — the spawn-based integration lives in
 * test/process-watchdog.serial.test.ts (Bun-pinned, real processes).
 */
import { describe, test, expect } from 'bun:test';
import { watchdogDecision, installProcessWatchdog } from '../src/core/process-watchdog.ts';

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
