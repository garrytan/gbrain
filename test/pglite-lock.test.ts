import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, type LockHandle } from '../src/core/pglite-lock';

const TEST_DIR = join(tmpdir(), 'gbrain-lock-test-' + process.pid);

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
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);
  });

  test('creates missing data directory before acquiring lock', async () => {
    const missingDataDir = join(TEST_DIR, 'missing-data-dir');

    const lock = await acquireLock(missingDataDir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(missingDataDir)).toBe(true);
    expect(existsSync(join(missingDataDir, '.gbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(missingDataDir, '.gbrain-lock'))).toBe(false);
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
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: 999999999, // Non-existent PID
      acquired_at: Date.now(),
      command: 'test',
    }));

    // Should clean up the stale lock and acquire
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

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
    const lock = await acquireLock(TEST_DIR);
    const lockData = JSON.parse(readFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), 'utf-8'));

    expect(lockData.pid).toBe(process.pid);
    expect(lockData.acquired_at).toBeDefined();
    expect(lockData.command).toBeDefined();

    await releaseLock(lock);
  });

  test('releases lock on disconnect even if DB close fails', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    // Simulate DB already closed
    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);

    // Second acquisition should work
    const lock2 = await acquireLock(TEST_DIR);
    expect(lock2.acquired).toBe(true);
    await releaseLock(lock2);
  });
});

describe('pglite-lock #2058 heartbeat + steal-grace', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function writeHolder(fields: { pid: number; acquiredAgoMs: number; refreshedAgoMs: number }) {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir, { recursive: true });
    const now = Date.now();
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: fields.pid,
      acquired_at: now - fields.acquiredAgoMs,
      refreshed_at: now - fields.refreshedAgoMs,
      command: 'test holder',
    }));
  }

  test('[REGRESSION] a LIVE holder with a fresh heartbeat is NOT stolen even when the lock is old', async () => {
    // The WAL-corruption bug: a >5min embed used to get its lock force-removed.
    // Now an alive holder that heartbeated recently is left alone regardless of
    // age. acquired 20min ago, but refreshed just now → must wait, not steal.
    writeHolder({ pid: process.pid, acquiredAgoMs: 20 * 60_000, refreshedAgoMs: 0 });

    await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
    // Holder's lock still present (was never stolen).
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('[REGRESSION #2348] a LIVE PID with a STALE heartbeat is NOT stolen', async () => {
    // The #2348 corruption: a live `gbrain dream`/embed holder whose heartbeat
    // lapsed (the JS event loop is blocked during a long synchronous WASM
    // import) used to get its lock reaped past the grace window — letting a
    // second OS process open the same data dir and corrupt the catalog +
    // pgvector extension state. A live PID is now NEVER stolen, regardless of
    // how stale its heartbeat is. Acquire must time out, not steal.
    writeHolder({ pid: process.pid, acquiredAgoMs: 25 * 60_000, refreshedAgoMs: 20 * 60_000 });

    await expect(acquireLock(TEST_DIR, { timeoutMs: 1200 })).rejects.toThrow(/Timed out/);
    // The live holder's lock is still present — never force-removed.
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
  });

  test('[REGRESSION] releaseLock does NOT remove a lock that was stolen + re-acquired by another process', async () => {
    // We acquire, then simulate a steal: another process reaped us past grace
    // and now owns the lock (different pid + acquired_at). Our releaseLock must
    // NOT delete their live lock — doing so would let a third process in
    // alongside the new owner (the #2058 corruption class).
    const lock: LockHandle = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(lock.ownerToken).toBeDefined();
    if (lock.heartbeat) clearInterval(lock.heartbeat); // stop our heartbeat for a deterministic test

    // Overwrite the lock file as if process B re-acquired it.
    const lockFile = join(TEST_DIR, '.gbrain-lock', 'lock');
    const bNow = Date.now() + 1;
    writeFileSync(lockFile, JSON.stringify({ pid: 999999, acquired_at: bNow, refreshed_at: bNow, command: 'process B' }));

    await releaseLock(lock); // our (stale) handle

    // B's lock survives — we did not clobber it.
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    const after = JSON.parse(readFileSync(lockFile, 'utf-8'));
    expect(after.pid).toBe(999999);

    // Cleanup for afterEach.
    rmSync(join(TEST_DIR, '.gbrain-lock'), { recursive: true, force: true });
  });

  test('acquire starts a heartbeat and seeds refreshed_at; release clears it', async () => {
    const lock: LockHandle = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(lock.heartbeat).toBeDefined();
    const data = JSON.parse(readFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), 'utf-8'));
    expect(data.refreshed_at).toBeDefined();
    expect(typeof data.refreshed_at).toBe('number');

    await releaseLock(lock);
    expect(lock.heartbeat).toBeUndefined();
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(false);
  });
});
