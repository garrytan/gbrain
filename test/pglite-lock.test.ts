import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, type LockHandle } from '../src/core/pglite-lock';

const TEST_DIR = join(tmpdir(), 'gbrain-lock-test-' + process.pid);
const LOCK_DIR = '.gbrain-lock';
const LOCK_FILE = 'lock';

function lockDir(dir = TEST_DIR): string {
  return join(dir, LOCK_DIR);
}

function lockPath(dir = TEST_DIR): string {
  return join(lockDir(dir), LOCK_FILE);
}

function seedLock(
  dir: string,
  data: Record<string, unknown>,
): void {
  mkdirSync(lockDir(dir), { recursive: true });
  writeFileSync(lockPath(dir), JSON.stringify({
    owner_id: 'seed-owner',
    pid: process.pid,
    host: 'test-host',
    acquired_at: Date.now(),
    last_refreshed_at: Date.now(),
    command: 'seeded-test-lock',
    ...data,
  }));
}

describe('pglite-lock', () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('acquires and releases lock', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(existsSync(lockDir())).toBe(true);

    await releaseLock(lock);
    expect(existsSync(lockDir())).toBe(false);
  });

  test('creates missing data directory before acquiring lock', async () => {
    const missingDataDir = join(TEST_DIR, 'missing-data-dir');

    const lock = await acquireLock(missingDataDir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(missingDataDir)).toBe(true);
    expect(existsSync(lockDir(missingDataDir))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(lockDir(missingDataDir))).toBe(false);
  });

  test('prevents concurrent lock acquisition', async () => {
    const lock1 = await acquireLock(TEST_DIR, { timeoutMs: 2000 });
    expect(lock1.acquired).toBe(true);

    // Second lock attempt should timeout
    await expect(acquireLock(TEST_DIR, { timeoutMs: 1000 })).rejects.toThrow(/Timed out/);

    await releaseLock(lock1);
  });

  test('detects and cleans stale lock from dead process', async () => {
    // Simulate a stale lock from a dead process
    seedLock(TEST_DIR, {
      pid: 999999999, // Non-existent PID
      acquired_at: Date.now(),
      last_refreshed_at: Date.now(),
    });

    // Should clean up the stale lock and acquire
    const lock = await acquireLock(TEST_DIR, {
      deadPidGraceMs: 0,
      host: 'test-host',
      isProcessAlive: () => 'dead',
    });
    expect(lock.acquired).toBe(true);

    await releaseLock(lock);
  });

  test('does not steal live lock with old acquire time and fresh heartbeat', async () => {
    const now = Date.now();
    seedLock(TEST_DIR, {
      pid: process.pid,
      acquired_at: now - 10 * 60_000,
      last_refreshed_at: now,
    });

    await expect(acquireLock(TEST_DIR, {
      timeoutMs: 20,
      staleThresholdMs: 5 * 60_000,
      heartbeatIntervalMs: 5,
      host: 'test-host',
      isProcessAlive: () => 'alive',
      now: () => now,
    })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockDir())).toBe(true);
    const current = JSON.parse(readFileSync(lockPath(), 'utf-8'));
    expect(current.owner_id).toBe('seed-owner');
  });

  test('does not steal live lock with stale heartbeat', async () => {
    const now = Date.now();
    seedLock(TEST_DIR, {
      pid: process.pid,
      acquired_at: now - 20 * 60_000,
      last_refreshed_at: now - 10 * 60_000,
    });

    await expect(acquireLock(TEST_DIR, {
      timeoutMs: 20,
      staleThresholdMs: 5 * 60_000,
      heartbeatIntervalMs: 5,
      host: 'test-host',
      isProcessAlive: () => 'alive',
      now: () => now,
    })).rejects.toThrow(/Timed out/);
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).owner_id).toBe('seed-owner');
  });

  test('does not force-steal old-format live lock without heartbeat metadata', async () => {
    const now = Date.now();
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(lockPath(), JSON.stringify({
      pid: process.pid,
      acquired_at: now - 10 * 60_000,
      command: 'legacy-lock',
    }));

    await expect(acquireLock(TEST_DIR, {
      timeoutMs: 20,
      staleThresholdMs: 5 * 60_000,
      heartbeatIntervalMs: 5,
      host: 'test-host',
      isProcessAlive: () => 'alive',
      now: () => now,
    })).rejects.toThrow(/Timed out/);
    const current = JSON.parse(readFileSync(lockPath(), 'utf-8'));
    expect(current.command).toBe('legacy-lock');
  });

  test('does not clean dead pid inside grace window', async () => {
    const now = Date.now();
    seedLock(TEST_DIR, {
      pid: 999999999,
      acquired_at: now - 1000,
      last_refreshed_at: now - 1000,
    });

    await expect(acquireLock(TEST_DIR, {
      timeoutMs: 20,
      deadPidGraceMs: 60_000,
      heartbeatIntervalMs: 5,
      host: 'test-host',
      isProcessAlive: () => 'dead',
      now: () => now,
    })).rejects.toThrow(/Timed out/);
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).owner_id).toBe('seed-owner');
  });

  test('treats unknown pid probe result as unsafe to steal', async () => {
    const now = Date.now();
    seedLock(TEST_DIR, {
      pid: 999999999,
      acquired_at: now - 20 * 60_000,
      last_refreshed_at: now - 20 * 60_000,
    });

    await expect(acquireLock(TEST_DIR, {
      timeoutMs: 20,
      deadPidGraceMs: 0,
      heartbeatIntervalMs: 5,
      host: 'test-host',
      isProcessAlive: () => 'unknown',
      now: () => now,
    })).rejects.toThrow(/Timed out/);
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).owner_id).toBe('seed-owner');
  });

  test('treats EPERM-equivalent pid probe result as alive', async () => {
    const now = Date.now();
    seedLock(TEST_DIR, {
      pid: 999999999,
      acquired_at: now - 20 * 60_000,
      last_refreshed_at: now - 20 * 60_000,
    });

    await expect(acquireLock(TEST_DIR, {
      timeoutMs: 20,
      deadPidGraceMs: 0,
      heartbeatIntervalMs: 5,
      host: 'test-host',
      isProcessAlive: () => 'alive',
      now: () => now,
    })).rejects.toThrow(/Timed out/);
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).owner_id).toBe('seed-owner');
  });

  test('does not steal cross-host lock', async () => {
    const now = Date.now();
    seedLock(TEST_DIR, {
      pid: 999999999,
      host: 'other-host',
      acquired_at: now - 20 * 60_000,
      last_refreshed_at: now - 20 * 60_000,
    });

    await expect(acquireLock(TEST_DIR, {
      timeoutMs: 20,
      deadPidGraceMs: 0,
      heartbeatIntervalMs: 5,
      host: 'test-host',
      isProcessAlive: () => 'dead',
      now: () => now,
    })).rejects.toThrow(/Timed out/);
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).host).toBe('other-host');
  });

  test('does not remove fresh missing metadata during initialization grace', async () => {
    const now = Date.now();
    mkdirSync(lockDir(), { recursive: true });

    await expect(acquireLock(TEST_DIR, {
      timeoutMs: 20,
      initGraceMs: 60_000,
      heartbeatIntervalMs: 5,
      host: 'test-host',
      now: () => now,
    })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockDir())).toBe(true);
  });

  test('recovers old corrupt metadata as orphaned', async () => {
    const now = Date.now();
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(lockPath(), 'not-json');

    const lock = await acquireLock(TEST_DIR, {
      timeoutMs: 100,
      initGraceMs: 0,
      heartbeatIntervalMs: 5,
      host: 'test-host',
      now: () => now,
    });
    expect(lock.acquired).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).owner_id).toBeDefined();

    await releaseLock(lock);
  });

  test('skips lock for in-memory (undefined dataDir)', async () => {
    const lock = await acquireLock(undefined);
    expect(lock.acquired).toBe(true);
    expect(lock.lockDir).toBe('');

    // Release should be a no-op
    await releaseLock(lock);
  });

  test('lock file contains PID and command', async () => {
    const lock = await acquireLock(TEST_DIR, {
      heartbeatIntervalMs: 5,
      host: 'test-host',
    });
    const lockData = JSON.parse(readFileSync(lockPath(), 'utf-8'));

    expect(lockData.pid).toBe(process.pid);
    expect(lockData.host).toBe('test-host');
    expect(lockData.owner_id).toBeDefined();
    expect(lockData.acquired_at).toBeDefined();
    expect(lockData.last_refreshed_at).toBeDefined();
    expect(lockData.command).toBeDefined();

    await releaseLock(lock);
  });

  test('heartbeat refreshes last_refreshed_at and stops after release', async () => {
    let now = 1000;
    const lock = await acquireLock(TEST_DIR, {
      heartbeatIntervalMs: 5,
      host: 'test-host',
      now: () => now,
    });
    const initial = JSON.parse(readFileSync(lockPath(), 'utf-8'));
    expect(initial.last_refreshed_at).toBe(1000);

    now = 2000;
    await new Promise(resolve => setTimeout(resolve, 20));
    const refreshed = JSON.parse(readFileSync(lockPath(), 'utf-8'));
    expect(refreshed.last_refreshed_at).toBe(2000);

    await releaseLock(lock);
    expect(existsSync(lockDir())).toBe(false);
  });

  test('release does not remove same-pid different-owner lock', async () => {
    const lock = await acquireLock(TEST_DIR, {
      heartbeatIntervalMs: 5,
      host: 'test-host',
    });
    const replacement = {
      pid: process.pid,
      host: 'test-host',
      owner_id: 'different-owner',
      acquired_at: Date.now(),
      last_refreshed_at: Date.now(),
      command: 'replacement-owner',
    };
    writeFileSync(lockPath(), JSON.stringify(replacement));

    await releaseLock(lock);
    expect(existsSync(lockDir())).toBe(true);
    expect(JSON.parse(readFileSync(lockPath(), 'utf-8')).owner_id).toBe('different-owner');
  });

  test('release is a no-op for corrupt, missing-file, and missing-directory locks', async () => {
    const corruptLock = await acquireLock(TEST_DIR, {
      heartbeatIntervalMs: 5,
      host: 'test-host',
    });
    writeFileSync(lockPath(), 'not-json');

    await releaseLock(corruptLock);
    expect(existsSync(lockDir())).toBe(true);

    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    const missingFileLock = await acquireLock(TEST_DIR, {
      heartbeatIntervalMs: 5,
      host: 'test-host',
    });
    rmSync(lockPath(), { force: true });

    await releaseLock(missingFileLock);
    expect(existsSync(lockDir())).toBe(true);

    rmSync(TEST_DIR, { recursive: true, force: true });
    await releaseLock(missingFileLock);
    expect(existsSync(lockDir())).toBe(false);
  });

  test('releases lock on disconnect even if DB close fails', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    // Simulate DB already closed
    await releaseLock(lock);
    expect(existsSync(lockDir())).toBe(false);

    // Second acquisition should work
    const lock2 = await acquireLock(TEST_DIR);
    expect(lock2.acquired).toBe(true);
    await releaseLock(lock2);
  });
});
