/**
 * Cycle lock PID probe — fix for the 14-hour Hermes incident on 2026-04-28.
 *
 * `gbrain_cycle_locks` is a 30-minute TTL row in Postgres (or PGLite). Before
 * this fix, the only path to take over a lock was waiting for `ttl_expires_at
 * < NOW()`. After a SIGKILL / OOM / power-off the holder PID is dead but the
 * row still has 30 minutes of life, so every subsequent autopilot-cycle job
 * skipped with `cycle_already_running` for up to half an hour. Hermes lost
 * 14 hours of sync because of this.
 *
 * Fix: probe the holder PID via `process.kill(pid, 0)` when the host matches.
 * Mirrors PR #477's `decideLockAcquisition` for `~/.gbrain/autopilot.lock`,
 * but in the DB lock layer.
 */

import { describe, test, expect } from 'bun:test';
import { decideLockAcquisition, isPidAliveLocal } from '../src/core/cycle.ts';
import { hostname } from 'os';

describe('decideLockAcquisition (cycle-lock PID probe)', () => {
  const here = hostname();

  test('different host → skip (cannot probe; trust TTL)', () => {
    const decision = decideLockAcquisition({
      holderPid: 99999,
      holderHost: 'some-other-machine.local',
      currentHost: here,
      isPidAlive: () => false, // even if probe says dead, we don't trust it across hosts
    });
    expect(decision).toBe('skip');
  });

  test('same host + alive PID → skip (live holder)', () => {
    const decision = decideLockAcquisition({
      holderPid: 1234,
      holderHost: here,
      currentHost: here,
      isPidAlive: (pid) => {
        expect(pid).toBe(1234);
        return true;
      },
    });
    expect(decision).toBe('skip');
  });

  test('same host + dead PID (ESRCH) → acquire', () => {
    const decision = decideLockAcquisition({
      holderPid: 99999,
      holderHost: here,
      currentHost: here,
      isPidAlive: (pid) => {
        expect(pid).toBe(99999);
        return false;
      },
    });
    expect(decision).toBe('acquire');
  });

  test('same host + EPERM (alive but unsignalable) → skip', () => {
    // EPERM means the process exists. The default isPidAliveLocal returns true
    // in that case, so the decision must be skip.
    const decision = decideLockAcquisition({
      holderPid: 1,
      holderHost: here,
      currentHost: here,
      isPidAlive: () => true, // EPERM → caller treats as alive
    });
    expect(decision).toBe('skip');
  });

  test('default isPidAlive is used when not injected', () => {
    // Pid 1 (init) is alive on every Unix host. We can't easily test ESRCH
    // without spawning, so this only asserts that omitting `isPidAlive` does
    // not throw and produces a coherent decision.
    const decision = decideLockAcquisition({
      holderPid: 1,
      holderHost: here,
      currentHost: here,
    });
    // pid 1 is alive (or EPERM treated as alive); either way decision = skip.
    expect(decision).toBe('skip');
  });
});

describe('isPidAliveLocal', () => {
  test('current process is alive', () => {
    expect(isPidAliveLocal(process.pid)).toBe(true);
  });

  test('a never-existed PID is dead', () => {
    // 32-bit max minus epsilon: extremely unlikely to be a live PID. Linux
    // PIDs are <= /proc/sys/kernel/pid_max (typically 4_194_303); macOS uses
    // a similar small ceiling. 2**31 - 1 sits well outside that range.
    expect(isPidAliveLocal(2147483646)).toBe(false);
  });
});
