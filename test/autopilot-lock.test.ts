import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS,
  decideLockAcquisition,
  isPidAlive,
} from '../src/commands/autopilot.ts';
import { looksLikeGbrainAutopilotCommand, readProcessCommand } from '../src/core/autopilot-lock.ts';

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

  test('keeps a lock whose holder is a live gbrain autopilot process', () => {
    writeFileSync(lockPath, '1234');
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => 'gbrain autopilot --repo repo',
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
      holderState: 'alive-autopilot',
    });
  });

  test('keeps a STALE lock whose holder is a live gbrain autopilot process', () => {
    // The age gate applies only to non-autopilot holders: a genuine autopilot
    // sibling is never stolen no matter how old the lockfile mtime is.
    writeFileSync(lockPath, '1234');
    const stale = new Date(Date.now() - AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS - 1000);
    utimesSync(lockPath, stale, stale);
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => 'gbrain autopilot --repo repo',
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
      holderState: 'alive-autopilot',
    });
  });

  test('keeps a fresh lock when the live PID command is unrecognized', () => {
    writeFileSync(lockPath, '1234');
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => '/sbin/launchd',
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
      holderState: 'alive-foreign',
    });
  });

  test('takes over a stale lock when the PID was reused by a foreign process', () => {
    writeFileSync(lockPath, '1234');
    const stale = new Date(Date.now() - AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS - 1000);
    utimesSync(lockPath, stale, stale);
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => '/sbin/launchd',
    })).toEqual({
      action: 'takeover',
      reason: 'foreign pid 1234 with stale lock',
    });
  });

  test('keeps a FRESH lock when process identity cannot be inspected', () => {
    writeFileSync(lockPath, '1234');
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => null,
    })).toEqual({
      action: 'exit',
      holderPid: 1234,
      holderState: 'alive-unknown',
    });
  });

  test('takes over a STALE lock when process identity cannot be inspected (#4300)', () => {
    // Recycled PID after reboot on a host where the command probe fails:
    // pre-fix this exited forever (bricked daemon). alive-unknown now shares
    // the alive-foreign age gate.
    writeFileSync(lockPath, '1234');
    const stale = new Date(Date.now() - AUTOPILOT_FOREIGN_PID_TAKEOVER_GRACE_MS - 1000);
    utimesSync(lockPath, stale, stale);
    expect(decideLockAcquisition(lockPath, process.pid, {
      isPidAlive: (pid) => pid === 1234,
      readProcessCommand: () => null,
    })).toEqual({
      action: 'takeover',
      reason: 'unidentifiable pid 1234 with stale lock',
    });
  });

  test('takes over malformed and empty locks', () => {
    writeFileSync(lockPath, 'not-a-pid');
    expect(decideLockAcquisition(lockPath, process.pid).action).toBe('takeover');
    writeFileSync(lockPath, '');
    expect(decideLockAcquisition(lockPath, process.pid).action).toBe('takeover');
  });
});

describe('readProcessCommand', () => {
  test('prefers /proc/<pid>/cmdline when readable (#4300)', () => {
    const seen: string[] = [];
    const cmd = readProcessCommand(1234, {
      readCmdlineFile: (path) => {
        seen.push(path);
        return Buffer.from('gbrain\0autopilot\0--repo\0repo\0');
      },
    });
    expect(seen).toEqual(['/proc/1234/cmdline']);
    expect(cmd).toBe('gbrain autopilot --repo repo');
  });

  test('falls back to ps when the cmdline probe throws', () => {
    // The current process always exists; ps must resolve it on macOS/Linux.
    const cmd = readProcessCommand(process.pid, {
      readCmdlineFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(cmd).not.toBeNull();
    expect((cmd ?? '').length).toBeGreaterThan(0);
  });

  test('falls back to ps when the cmdline file is empty (zombie)', () => {
    const cmd = readProcessCommand(process.pid, {
      readCmdlineFile: () => Buffer.from(''),
    });
    expect(cmd).not.toBeNull();
  });

  test('returns null for invalid pids without probing', () => {
    expect(readProcessCommand(0)).toBeNull();
    expect(readProcessCommand(-5)).toBeNull();
    expect(readProcessCommand(Number.NaN)).toBeNull();
  });
});

describe('looksLikeGbrainAutopilotCommand', () => {
  test('matches packaged and source-tree autopilot invocations', () => {
    expect(looksLikeGbrainAutopilotCommand('gbrain autopilot --repo repo')).toBe(true);
    expect(looksLikeGbrainAutopilotCommand('./gbrain/src/cli.ts autopilot')).toBe(true);
    expect(looksLikeGbrainAutopilotCommand('bun src/cli.ts autopilot --repo repo')).toBe(true);
  });

  test('rejects unrelated live processes', () => {
    expect(looksLikeGbrainAutopilotCommand('/sbin/launchd')).toBe(false);
    expect(looksLikeGbrainAutopilotCommand('/usr/bin/python worker.py')).toBe(false);
  });
});
