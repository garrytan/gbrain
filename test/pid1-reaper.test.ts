/**
 * #2443 — PID-1 orphan zombie reaper.
 *
 * serve-as-PID-1 (container without tini/--init) inherits orphaned
 * grandchildren; the zombie-reap.ts SIGCHLD handler only reaps Bun-TRACKED
 * children, so orphan zombies accumulated forever. These tests drive the
 * reaper against a fixture procDir + injected waitpid — no real /proc, no
 * libc, fully deterministic on any platform.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  scanZombieChildren,
  createPid1ReaperTick,
  installPid1OrphanReaper,
  _uninstallPid1OrphanReaperForTests,
} from '../src/core/pid1-reaper.ts';
import { withEnv } from './helpers/with-env.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  _uninstallPid1OrphanReaperForTests();
  for (const fn of cleanups.splice(0)) fn();
});

/** Build a fixture procDir: { pid: statLine } (plus junk entries). */
function makeProcDir(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-pid1-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [pid, stat] of Object.entries(entries)) {
    mkdirSync(join(dir, pid));
    writeFileSync(join(dir, pid, 'stat'), stat);
  }
  // non-numeric entries must be skipped
  mkdirSync(join(dir, 'sys'));
  writeFileSync(join(dir, 'uptime'), '12345.67 89.0');
  return dir;
}

const stat = (pid: number, comm: string, state: string, ppid: number) =>
  `${pid} (${comm}) ${state} ${ppid} ${ppid} 0 0 -1 4194560 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0`;

describe('scanZombieChildren', () => {
  test('finds only Z-state children of self', () => {
    const dir = makeProcDir({
      '1': stat(1, 'gbrain', 'S', 0),
      '42': stat(42, 'dead-worker', 'Z', 1),   // zombie child of pid 1 ✓
      '43': stat(43, 'live-worker', 'S', 1),   // alive
      '44': stat(44, 'other-zombie', 'Z', 99), // zombie of someone else
    });
    expect(scanZombieChildren(dir, 1)).toEqual([42]);
  });

  test('comm with spaces and parens parses (fields after LAST close paren)', () => {
    const dir = makeProcDir({
      '55': `55 (weird) name (x)) Z 1 1 0 0 -1 0 0 0 0 0 0 0 0 0 0 20 0 1 0 1 0 0`,
    });
    expect(scanZombieChildren(dir, 1)).toEqual([55]);
  });

  test('missing procDir / unreadable entries fail open to []', () => {
    expect(scanZombieChildren('/nonexistent-proc-xyz', 1)).toEqual([]);
  });
});

describe('createPid1ReaperTick — 2-scan persistence', () => {
  test('reaps only zombies that persist across two consecutive scans', () => {
    const dir = makeProcDir({ '42': stat(42, 'w', 'Z', 1) });
    const reapedPids: number[] = [];
    const tick = createPid1ReaperTick({ procDir: dir, selfPid: 1, waitpid: (p) => reapedPids.push(p) });

    expect(tick()).toBe(0);          // first sighting — never steal a Bun-tracked exit
    expect(reapedPids).toEqual([]);
    expect(tick()).toBe(1);          // persisted → reap
    expect(reapedPids).toEqual([42]);
  });

  test('a zombie that disappears between scans is never reaped', () => {
    const dir = makeProcDir({ '42': stat(42, 'w', 'Z', 1) });
    const reapedPids: number[] = [];
    const tick = createPid1ReaperTick({ procDir: dir, selfPid: 1, waitpid: (p) => reapedPids.push(p) });
    expect(tick()).toBe(0);
    rmSync(join(dir, '42'), { recursive: true, force: true }); // runtime reaped it
    expect(tick()).toBe(0);
    expect(reapedPids).toEqual([]);
  });

  test('a new zombie appearing on scan 2 waits for scan 3', () => {
    const dir = makeProcDir({ '42': stat(42, 'w', 'Z', 1) });
    const reapedPids: number[] = [];
    const tick = createPid1ReaperTick({ procDir: dir, selfPid: 1, waitpid: (p) => reapedPids.push(p) });
    tick(); // 42 pending
    mkdirSync(join(dir, '77'));
    writeFileSync(join(dir, '77', 'stat'), stat(77, 'late', 'Z', 1));
    expect(tick()).toBe(1); // 42 reaped, 77 pending
    expect(reapedPids).toEqual([42]);
    rmSync(join(dir, '42'), { recursive: true, force: true });
    expect(tick()).toBe(1); // 77 reaped
    expect(reapedPids).toEqual([42, 77]);
  });

  test('a throwing waitpid is contained (fail-open)', () => {
    const dir = makeProcDir({ '42': stat(42, 'w', 'Z', 1) });
    const tick = createPid1ReaperTick({
      procDir: dir, selfPid: 1,
      waitpid: () => { throw new Error('EPERM'); },
    });
    tick();
    expect(() => tick()).not.toThrow();
  });
});

describe('installPid1OrphanReaper — gates', () => {
  test('non-linux platform → not installed', () => {
    expect(installPid1OrphanReaper({ platform: 'darwin', selfPid: 1 })).toBe(false);
  });

  test('linux but not PID 1 → not installed', () => {
    expect(installPid1OrphanReaper({ platform: 'linux', selfPid: 4242 })).toBe(false);
  });

  test('GBRAIN_PID1_REAP=0 off-switch wins', async () => {
    await withEnv({ GBRAIN_PID1_REAP: '0' }, () => {
      expect(installPid1OrphanReaper({ platform: 'linux', selfPid: 1 })).toBe(false);
    });
  });

  test('linux + pid 1 → installs, ticks on the interval, idempotent', async () => {
    const dir = makeProcDir({ '42': stat(42, 'w', 'Z', 1) });
    const reapedPids: number[] = [];
    const ok = installPid1OrphanReaper({
      platform: 'linux', selfPid: 1, procDir: dir, intervalMs: 15,
      waitpid: (p) => reapedPids.push(p),
    });
    expect(ok).toBe(true);
    // second install is a no-op true (no duplicate timers)
    expect(installPid1OrphanReaper({ platform: 'linux', selfPid: 1, procDir: dir, intervalMs: 15 })).toBe(true);
    // two ticks: scan 1 marks pending, scan 2 reaps
    await Bun.sleep(120);
    expect(reapedPids).toContain(42);
  });
});
