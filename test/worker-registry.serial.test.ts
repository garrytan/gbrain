/**
 * Unit tests for the live worker registry (issue #1815, Q1-C).
 *
 * Pins the lifecycle edges Codex flagged:
 *   - ESRCH entries pruned, EPERM entries kept alive (#9).
 *   - PID-reuse guard: an entry whose pid started long after registration is
 *     not reported (#8).
 *   - Registry path is brain-isolated under gbrainPath (#7).
 *   - Corrupt JSON skipped; cleanup unlinks.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';

let home: string;
const origHome = process.env.GBRAIN_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-reg-'));
  process.env.GBRAIN_HOME = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = origHome;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Imported lazily AFTER GBRAIN_HOME is set so gbrainPath resolves to the temp dir.
async function reg() {
  return await import('../src/core/minions/worker-registry.ts');
}

describe('classifyLiveness (Codex #9)', () => {
  test('no error = alive, ESRCH = dead, EPERM = alive, other = unknown', async () => {
    const { classifyLiveness } = await reg();
    expect(classifyLiveness(undefined)).toBe('alive');
    expect(classifyLiveness('ESRCH')).toBe('dead');
    expect(classifyLiveness('EPERM')).toBe('alive'); // not pruned just because unsignalable
    expect(classifyLiveness('EINVAL')).toBe('unknown');
  });
});

describe('parseEtimeToMs (PID-reuse guard, timezone-free)', () => {
  test('parses every portable ps etime shape', async () => {
    const { parseEtimeToMs } = await reg();
    expect(parseEtimeToMs('00:00')).toBe(0);
    expect(parseEtimeToMs('00:42')).toBe(42_000);
    expect(parseEtimeToMs('01:23')).toBe(83_000);
    expect(parseEtimeToMs('12:34:56')).toBe(((12 * 3600) + (34 * 60) + 56) * 1000);
    expect(parseEtimeToMs('3-04:05:06')).toBe(((3 * 86400) + (4 * 3600) + (5 * 60) + 6) * 1000);
    expect(parseEtimeToMs('  01:00  ')).toBe(60_000);
  });

  test('returns null when elapsed time cannot be determined', async () => {
    const { parseEtimeToMs } = await reg();
    expect(parseEtimeToMs('')).toBeNull();
    expect(parseEtimeToMs('garbage')).toBeNull();
    expect(parseEtimeToMs('not:a:number:at:all')).toBeNull();
    expect(parseEtimeToMs('Mon Sep  7 00:30:32 2026')).toBeNull(); // the old lstart shape
  });
});

describe('register + read round trip', () => {
  test('registerWorker writes under gbrainPath; readWorkers returns the live worker', async () => {
    const { registerWorker, readWorkers, workerRegistryDir } = await reg();
    expect(workerRegistryDir()).toBe(join(home, '.gbrain', 'workers'));

    const cleanup = registerWorker({
      pid: process.pid, // a definitely-alive pid
      queue: 'default',
      nice_requested: 10,
      nice_effective: 10,
      started_at: Date.now(),
    });

    const live = readWorkers(() => 10); // inject niceness read
    expect(live.length).toBe(1);
    expect(live[0]!.pid).toBe(process.pid);
    expect(live[0]!.queue).toBe('default');
    expect(live[0]!.nice_requested).toBe(10);
    expect(live[0]!.nice_now).toBe(10);

    cleanup();
    expect(readWorkers(() => 10).length).toBe(0);
  });

  test('#4885: a live worker survives a runtime zone that differs from the one ps prints in', async () => {
    const { registerWorker, readWorkers } = await reg();
    // Bun re-resolves the runtime zone on reassignment but does not hand the
    // mutation to the ps child, so a zone-dependent start-time parse drifts by
    // the offset (+12h here) and drops a live worker. etime is zone-free.
    await withEnv({ TZ: 'Etc/GMT+12' }, async () => {
      const cleanup = registerWorker({
        pid: process.pid, queue: 'default', nice_requested: 10, nice_effective: 10, started_at: Date.now(),
      });
      try {
        expect(readWorkers(() => 10).length).toBe(1);
      } finally {
        cleanup();
      }
    });
  });

  test('cleanup unlinks the entry file', async () => {
    const { registerWorker, workerRegistryDir } = await reg();
    const cleanup = registerWorker({
      pid: process.pid, queue: 'q', nice_requested: null, nice_effective: 0, started_at: Date.now(),
    });
    expect(readdirSync(workerRegistryDir()).length).toBe(1);
    cleanup();
    expect(readdirSync(workerRegistryDir()).length).toBe(0);
  });
});

describe('pruning + guards', () => {
  test('ESRCH (dead) entries are dropped and their files pruned', async () => {
    const { readWorkers, workerRegistryDir, currentBrainId } = await reg();
    const dir = workerRegistryDir();
    // A pid that is essentially never alive.
    const deadPid = 2147483600;
    const file = join(dir, `worker-${deadPid}.json`);
    require('fs').mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({
      pid: deadPid, queue: 'q', brain_id: currentBrainId(),
      started_at: Date.now(), nice_requested: 5, nice_effective: 5,
    }));
    const live = readWorkers(() => 5);
    expect(live.length).toBe(0);
    expect(existsSync(file)).toBe(false); // pruned
  });

  test('PID-reuse guard: live pid that started long after registration is skipped (Codex #8)', async () => {
    const { readWorkers, workerRegistryDir, currentBrainId } = await reg();
    const dir = workerRegistryDir();
    require('fs').mkdirSync(dir, { recursive: true });
    // Use our own (alive) pid but claim it was registered far in the past — our
    // process actually started AFTER that, so the start-time guard rejects it.
    writeFileSync(join(dir, `worker-${process.pid}.json`), JSON.stringify({
      pid: process.pid, queue: 'q', brain_id: currentBrainId(),
      started_at: 1, // epoch ~1970; our process clearly started long after
      nice_requested: 5, nice_effective: 5,
    }));
    const live = readWorkers(() => 5);
    expect(live.length).toBe(0);
  });

  test('corrupt JSON is skipped, not fatal', async () => {
    const { readWorkers, workerRegistryDir } = await reg();
    const dir = workerRegistryDir();
    require('fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `worker-${process.pid}.json`), '{ not valid json');
    expect(() => readWorkers(() => 5)).not.toThrow();
    expect(readWorkers(() => 5).length).toBe(0);
  });
});
