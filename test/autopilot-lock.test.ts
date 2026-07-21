import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { decideLockAcquisition, isPidAlive, pidLooksLikeGbrain } from '../src/commands/autopilot.ts';

let tmp: string;
let lockPath: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-autopilot-lock-'));
  lockPath = join(tmp, 'autopilot.lock');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('isPidAlive', () => {
  test('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test('returns false for invalid process ids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
    expect(isPidAlive(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('decideLockAcquisition', () => {
  test('acquires when no lock exists', () => {
    expect(decideLockAcquisition(lockPath, process.pid)).toEqual({ action: 'acquire' });
  });

  test('takes over a lock whose holder is dead', () => {
    writeFileSync(lockPath, '4194303');
    expect(decideLockAcquisition(lockPath, process.pid)).toEqual({
      action: 'takeover',
      reason: 'dead pid 4194303',
    });
  });

  test('keeps a lock whose holder is alive regardless of age', () => {
    writeFileSync(lockPath, String(process.pid));
    expect(decideLockAcquisition(lockPath, process.pid + 100_000, () => true)).toEqual({
      action: 'exit',
      holderPid: process.pid,
    });
  });

  // #2503: a live PID recycled by an unrelated process (e.g. AirPlayUIAgent)
  // must not block autopilot forever — identity mismatch means takeover.
  test('takes over a live lock held by a foreign (non-gbrain) process', () => {
    writeFileSync(lockPath, String(process.pid));
    expect(decideLockAcquisition(lockPath, process.pid + 100_000, () => false)).toEqual({
      action: 'takeover',
      reason: `foreign process holds stale lock (pid ${process.pid})`,
    });
  });

  test('takes over malformed and empty locks', () => {
    writeFileSync(lockPath, 'not-a-pid');
    expect(decideLockAcquisition(lockPath, process.pid).action).toBe('takeover');
    writeFileSync(lockPath, '');
    expect(decideLockAcquisition(lockPath, process.pid).action).toBe('takeover');
  });
});

describe('pidLooksLikeGbrain', () => {
  test('fails open on a dead pid (ps errors → true, never steal blind)', () => {
    expect(pidLooksLikeGbrain(4194303)).toBe(true);
  });

  test('recognizes a live non-gbrain process as foreign', () => {
    const child = Bun.spawn(['sleep', '30']);
    try {
      expect(pidLooksLikeGbrain(child.pid)).toBe(false);
    } finally {
      child.kill();
    }
  });
});
