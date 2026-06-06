/**
 * v0.37.7.0 #1226 regression test.
 *
 * The autopilot lockfile was hardcoded at `~/.gbrain/autopilot.lock`
 * (via `process.env.HOME`), bypassing GBRAIN_HOME. Two brains pointed
 * at different GBRAIN_HOME directories would still write to the same
 * global lockfile; one would silently take over the other on each
 * restart.
 *
 * Fix: route through `gbrainPath('autopilot.lock')` which honors
 * GBRAIN_HOME. This file pins the contract via the canonical helper
 * directly, since the autopilot daemon's lifecycle is heavy to drive
 * in a unit test.
 */

import { describe, test, expect } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gbrainPath } from '../src/core/config.ts';
import { acquireAutopilotLock, parseAutopilotLockPid, refreshAutopilotLockIfOwned, removeAutopilotLockIfOwned, shouldTakeOverAutopilotLock } from '../src/commands/autopilot.ts';

describe('autopilot lock path scoped to GBRAIN_HOME (#1226)', () => {
  test('one GBRAIN_HOME produces one canonical lock path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-lock-'));
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const lockPath = gbrainPath('autopilot.lock');
      // Lockfile MUST live inside the per-brain GBRAIN_HOME, not under
      // process.env.HOME — that was the pre-fix bug.
      expect(lockPath.startsWith(home)).toBe(true);
      expect(lockPath.endsWith('autopilot.lock')).toBe(true);
    });
  });

  test('two GBRAIN_HOME values produce two distinct lockfiles', async () => {
    const homeA = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-A-'));
    const homeB = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-B-'));

    let lockA = '';
    let lockB = '';
    await withEnv({ GBRAIN_HOME: homeA }, async () => {
      lockA = gbrainPath('autopilot.lock');
    });
    await withEnv({ GBRAIN_HOME: homeB }, async () => {
      lockB = gbrainPath('autopilot.lock');
    });

    // The contract that prevents two brains from silently colliding:
    // distinct GBRAIN_HOME values MUST produce distinct lockfile paths.
    expect(lockA).not.toBe(lockB);
    expect(lockA.startsWith(homeA)).toBe(true);
    expect(lockB.startsWith(homeB)).toBe(true);
  });

  test('default (no GBRAIN_HOME override) still produces a valid path', async () => {
    // When GBRAIN_HOME is unset, gbrainPath falls through to its
    // default (`~/.gbrain`). The path must still exist as a string
    // and end with the expected filename — we don't assert the exact
    // home dir since that varies by environment.
    await withEnv({ GBRAIN_HOME: undefined }, async () => {
      const lockPath = gbrainPath('autopilot.lock');
      expect(typeof lockPath).toBe('string');
      expect(lockPath.endsWith('autopilot.lock')).toBe(true);
      expect(lockPath.length).toBeGreaterThan('autopilot.lock'.length);
    });
  });

  test('lock takeover allows fresh files when the recorded PID is gone', () => {
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    const decision = shouldTakeOverAutopilotLock('99999', now - 60_000, now, () => false);
    expect(decision).toEqual({ takeOver: true, reason: 'pid_dead', pid: 99999 });
  });

  test('lock takeover refuses fresh files when the recorded PID is live', () => {
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    const decision = shouldTakeOverAutopilotLock('12345', now - 60_000, now, () => true);
    expect(decision).toEqual({ takeOver: false, reason: 'fresh_live', pid: 12345 });
  });

  test('lock takeover allows invalid or old lock files', () => {
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    expect(parseAutopilotLockPid('not-a-pid')).toBeNull();
    expect(shouldTakeOverAutopilotLock('not-a-pid', now - 11 * 60_000, now, () => true).reason).toBe('invalid_pid');
    expect(shouldTakeOverAutopilotLock('12345', now - 11 * 60_000, now, () => false).reason).toBe('stale_age');
  });

  test('lock takeover refuses fresh invalid lock files', () => {
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    const decision = shouldTakeOverAutopilotLock('', now - 60_000, now, () => false);
    expect(decision).toEqual({ takeOver: false, reason: 'fresh_invalid', pid: null });
    expect(parseAutopilotLockPid('123abc')).toBeNull();
    expect(parseAutopilotLockPid('123 junk')).toBeNull();
    expect(shouldTakeOverAutopilotLock('123abc', now - 60_000, now, () => false).reason).toBe('fresh_invalid');
    expect(shouldTakeOverAutopilotLock('123 junk', now - 11 * 60_000, now, () => true).reason).toBe('invalid_pid');
  });

  test('lock takeover allows old lock files even when the recorded PID is still live', () => {
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    const decision = shouldTakeOverAutopilotLock('12345', now - 11 * 60_000, now, () => true);
    expect(decision).toEqual({ takeOver: true, reason: 'stale_age', pid: 12345 });
  });

  test('lock cleanup only removes the file still owned by the current PID', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-cleanup-'));
    const lockPath = join(home, 'autopilot.lock');
    writeFileSync(lockPath, '22222');

    removeAutopilotLockIfOwned(lockPath, 11111);
    expect(existsSync(lockPath)).toBe(true);

    removeAutopilotLockIfOwned(lockPath, 22222);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('lock refresh only touches the file still owned by the current PID', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-refresh-'));
    const lockPath = join(home, 'autopilot.lock');
    writeFileSync(lockPath, '22222');

    expect(refreshAutopilotLockIfOwned(lockPath, 11111)).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toBe('22222');
    expect(refreshAutopilotLockIfOwned(lockPath, 22222)).toBe(true);
  });

  test('lock acquisition creates a missing lock and refuses a fresh live owner', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-acquire-'));
    const lockPath = join(home, 'autopilot.lock');

    expect(acquireAutopilotLock(lockPath, home, 11111)).toEqual({ acquired: true, reason: null, pid: null });
    expect(readFileSync(lockPath, 'utf8')).toBe('11111');

    const blocked = acquireAutopilotLock(lockPath, home, 22222, Date.now(), () => true);
    expect(blocked).toEqual({ acquired: false, reason: 'fresh_live', pid: 11111 });
    expect(readFileSync(lockPath, 'utf8')).toBe('11111');
  });

  test('lock acquisition replaces stale owned locks with the new PID', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-stale-acquire-'));
    const lockPath = join(home, 'autopilot.lock');
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    writeFileSync(lockPath, '11111');
    utimesSync(lockPath, (now - 11 * 60_000) / 1000, (now - 11 * 60_000) / 1000);

    const result = acquireAutopilotLock(lockPath, home, 22222, now, () => false);
    expect(result).toEqual({ acquired: true, reason: 'stale_age', pid: 11111 });
    expect(readFileSync(lockPath, 'utf8')).toBe('22222');
  });

  test('lock acquisition refuses stale takeover when another contender holds the takeover lock', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-takeover-held-'));
    const lockPath = join(home, 'autopilot.lock');
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    writeFileSync(lockPath, '11111');
    writeFileSync(`${lockPath}.takeover`, '33333');
    utimesSync(lockPath, (now - 11 * 60_000) / 1000, (now - 11 * 60_000) / 1000);

    const result = acquireAutopilotLock(lockPath, home, 22222, now, () => true);
    expect(result).toEqual({ acquired: false, reason: 'stale_age', pid: 11111 });
    expect(readFileSync(lockPath, 'utf8')).toBe('11111');
  });

  test('lock acquisition recovers an old takeover lock', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-old-takeover-'));
    const lockPath = join(home, 'autopilot.lock');
    const takeoverPath = `${lockPath}.takeover`;
    const now = Date.parse('2026-06-06T12:00:00.000Z');
    writeFileSync(lockPath, '11111');
    writeFileSync(takeoverPath, '33333');
    const old = (now - 11 * 60_000) / 1000;
    utimesSync(lockPath, old, old);
    utimesSync(takeoverPath, old, old);

    const result = acquireAutopilotLock(lockPath, home, 22222, now, () => false);
    expect(result).toEqual({ acquired: true, reason: 'stale_age', pid: 11111 });
    expect(readFileSync(lockPath, 'utf8')).toBe('22222');
    expect(existsSync(takeoverPath)).toBe(false);
  });
});
