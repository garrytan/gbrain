/**
 * Regression test for autopilot lock-check PID liveness.
 *
 * Pre-fix bug: autopilot.lock with fresh mtime + dead PID would silently
 * abort every launchd KeepAlive respawn for up to 10 minutes after a
 * SIGKILL / OOM / power loss. This test pins the post-fix behavior.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { decideLockAcquisition, isPidAlive } from '../src/commands/autopilot.ts';

let tmp: string;
let lockPath: string;
const NOW = 1_700_000_000_000; // fixed wall-clock for the test
const FRESH_MTIME_S = NOW / 1000; // mtime within the 10-min window
const STALE_MTIME_S = (NOW - 11 * 60_000) / 1000;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-lock-'));
  lockPath = join(tmp, 'autopilot.lock');
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('isPidAlive', () => {
  test('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('returns false for a PID that cannot exist', () => {
    // 2^22 - 1 is below macOS PID_MAX (~99999) and Linux default (32768)
    // unlikely-to-collide range; signal 0 will throw ESRCH.
    expect(isPidAlive(4194303)).toBe(false);
  });

  test('returns false for non-positive / non-finite inputs', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
    expect(isPidAlive(Infinity)).toBe(false);
  });
});

describe('decideLockAcquisition', () => {
  test('no lock file → acquire', () => {
    const d = decideLockAcquisition(lockPath, process.pid, NOW);
    expect(d.action).toBe('acquire');
  });

  test('dead PID + fresh mtime → takeover (the bug fix)', () => {
    writeFileSync(lockPath, '4194303');
    utimesSync(lockPath, FRESH_MTIME_S, FRESH_MTIME_S);
    const d = decideLockAcquisition(lockPath, process.pid, NOW);
    expect(d.action).toBe('takeover');
    if (d.action === 'takeover') expect(d.reason).toMatch(/dead pid/);
  });

  test('dead PID + stale mtime → takeover', () => {
    writeFileSync(lockPath, '4194303');
    utimesSync(lockPath, STALE_MTIME_S, STALE_MTIME_S);
    const d = decideLockAcquisition(lockPath, process.pid, NOW);
    expect(d.action).toBe('takeover');
  });

  test('alive PID + fresh mtime → exit (real concurrent instance)', () => {
    writeFileSync(lockPath, String(process.pid));
    utimesSync(lockPath, FRESH_MTIME_S, FRESH_MTIME_S);
    // Use a fake "current pid" so the lock holder isn't us.
    const fakeCurrentPid = process.pid + 100000;
    const d = decideLockAcquisition(lockPath, fakeCurrentPid, NOW);
    expect(d.action).toBe('exit');
    if (d.action === 'exit') expect(d.holderPid).toBe(process.pid);
  });

  test('alive PID + stale mtime → takeover (stuck instance backstop)', () => {
    writeFileSync(lockPath, String(process.pid));
    utimesSync(lockPath, STALE_MTIME_S, STALE_MTIME_S);
    const fakeCurrentPid = process.pid + 100000;
    const d = decideLockAcquisition(lockPath, fakeCurrentPid, NOW);
    expect(d.action).toBe('takeover');
    if (d.action === 'takeover') expect(d.reason).toMatch(/>10 min/);
  });

  test('lock holder is current process → takeover (idempotent restart)', () => {
    writeFileSync(lockPath, String(process.pid));
    utimesSync(lockPath, FRESH_MTIME_S, FRESH_MTIME_S);
    const d = decideLockAcquisition(lockPath, process.pid, NOW);
    expect(d.action).toBe('takeover');
  });

  test('garbage lock contents → takeover (treated as dead)', () => {
    writeFileSync(lockPath, 'not-a-pid\n');
    utimesSync(lockPath, FRESH_MTIME_S, FRESH_MTIME_S);
    const d = decideLockAcquisition(lockPath, process.pid, NOW);
    expect(d.action).toBe('takeover');
    if (d.action === 'takeover') expect(d.reason).toMatch(/dead pid not-a-pid/);
  });

  test('empty lock contents → takeover (treated as dead)', () => {
    writeFileSync(lockPath, '');
    utimesSync(lockPath, FRESH_MTIME_S, FRESH_MTIME_S);
    const d = decideLockAcquisition(lockPath, process.pid, NOW);
    expect(d.action).toBe('takeover');
    if (d.action === 'takeover') expect(d.reason).toMatch(/dead pid </);
  });
});
