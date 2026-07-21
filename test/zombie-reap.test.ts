/**
 * Tests for src/core/zombie-reap.ts — the SIGCHLD installer that lets
 * Bun/Node reap exited child processes.
 *
 * Background: without a SIGCHLD listener, child processes spawned by the
 * worker (shell jobs, embed batches, sub-agents) become zombies on exit.
 * The runtime only calls waitpid() internally when at least one SIGCHLD
 * listener is registered. A no-op handler is sufficient.
 *
 * Cross-file leak guard (codex review #6): mutating global `process` signal
 * listeners in the parallel test pool can leak across files in the same
 * shard process. `afterAll` MUST call `_uninstallSigchldHandlerForTests()`
 * so the next file in the shard sees a clean listener set.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import {
  installSigchldHandler,
  _uninstallSigchldHandlerForTests,
} from '../src/core/zombie-reap.ts';

afterAll(() => {
  _uninstallSigchldHandlerForTests();
});

describe('installSigchldHandler', () => {
  test('registers a SIGCHLD listener after first call', () => {
    const before = process.listeners('SIGCHLD').length;
    installSigchldHandler();
    const after = process.listeners('SIGCHLD').length;
    expect(after).toBeGreaterThanOrEqual(before + (before === 0 ? 1 : 0));
    expect(process.listeners('SIGCHLD').length).toBeGreaterThanOrEqual(1);
  });

  test('idempotent: two calls leave exactly one of our listeners', () => {
    // Start clean — remove any handler from the previous test (this file's
    // own only — afterAll handles the global cleanup).
    _uninstallSigchldHandlerForTests();
    installSigchldHandler();
    const afterFirst = process.listeners('SIGCHLD').length;
    installSigchldHandler();
    const afterSecond = process.listeners('SIGCHLD').length;
    // The includes() guard in installSigchldHandler must prevent the
    // second call from adding a duplicate. EventEmitter does NOT dedupe.
    expect(afterSecond).toBe(afterFirst);
  });
});

// #2443: PID-1 orphan reaper — /proc stat parsing + two-sweep confirmation.
import {
  parseProcStatLine,
  createOrphanSweeper,
  installPid1OrphanReaper,
} from '../src/core/zombie-reap.ts';

describe('parseProcStatLine (#2443)', () => {
  test('parses a plain zombie git child of PID 1', () => {
    expect(parseProcStatLine('336 (git) Z 1 336 1 0 -1 4227084')).toEqual({
      pid: 336,
      state: 'Z',
      ppid: 1,
    });
  });

  test('handles comm with spaces and parens (splits on LAST close-paren)', () => {
    expect(parseProcStatLine('42 (my (weird) prog) R 7 42 7')).toEqual({
      pid: 42,
      state: 'R',
      ppid: 7,
    });
  });

  test('returns null on garbage', () => {
    expect(parseProcStatLine('')).toBeNull();
    expect(parseProcStatLine('not a stat line')).toBeNull();
  });
});

describe('createOrphanSweeper (#2443)', () => {
  test('reaps only pids seen in two consecutive sweeps', async () => {
    const reaped: number[] = [];
    let zombies: number[] = [10, 11];
    const sweeper = createOrphanSweeper(() => zombies, (pid) => reaped.push(pid));

    await sweeper.sweep(); // first sighting — nothing reaped yet
    expect(reaped).toEqual([]);

    zombies = [10, 12]; // 11 vanished (runtime reaped it), 12 is new
    await sweeper.sweep();
    expect(reaped).toEqual([10]); // persisted across two sweeps → orphan

    zombies = [12];
    await sweeper.sweep();
    expect(reaped).toEqual([10, 12]);
  });

  test('a pid that disappears between sweeps is never reaped', async () => {
    const reaped: number[] = [];
    let zombies: number[] = [77];
    const sweeper = createOrphanSweeper(() => zombies, (pid) => reaped.push(pid));
    await sweeper.sweep();
    zombies = [];
    await sweeper.sweep();
    expect(reaped).toEqual([]);
  });
});

describe('installPid1OrphanReaper (#2443)', () => {
  test('no-op unless PID 1 on Linux', () => {
    expect(installPid1OrphanReaper({ pid: process.pid, platform: 'linux' })).toBeNull();
    expect(installPid1OrphanReaper({ pid: 1, platform: 'darwin' })).toBeNull();
  });

  test('installs an interval sweeper as PID 1 on Linux and reaps persistent zombies', async () => {
    const reaped: number[] = [];
    const stop = installPid1OrphanReaper({
      pid: 1,
      platform: 'linux',
      intervalMs: 5,
      listZombieChildren: () => [99],
      reapPid: (pid) => reaped.push(pid),
    });
    expect(stop).not.toBeNull();
    try {
      await new Promise((r) => setTimeout(r, 40));
      expect(reaped.length).toBeGreaterThan(0);
      expect(reaped[0]).toBe(99);
    } finally {
      stop!();
    }
  });
});
