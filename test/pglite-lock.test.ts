import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';

const TEST_DIR = join(tmpdir(), 'mbrain-lock-test-' + process.pid);

describe('pglite-lock', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('acquires and releases lock', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(existsSync(join(TEST_DIR, '.mbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.mbrain-lock'))).toBe(false);
  });

  test('creates missing data directory before acquiring lock', async () => {
    const missingDataDir = join(TEST_DIR, 'missing-data-dir');

    const lock = await acquireLock(missingDataDir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(missingDataDir)).toBe(true);
    expect(existsSync(join(missingDataDir, '.mbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(missingDataDir, '.mbrain-lock'))).toBe(false);
  });

  test('prevents concurrent lock acquisition', async () => {
    const lock1 = await acquireLock(TEST_DIR, { timeoutMs: 2000 });
    expect(lock1.acquired).toBe(true);

    const originalSetTimeout = globalThis.setTimeout;
    const requestedDelays: number[] = [];
    try {
      globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        requestedDelays.push(Number(timeout ?? 0));
        return originalSetTimeout(() => {
          if (typeof handler === 'function') handler(...args);
        }, 0);
      }) as unknown as typeof globalThis.setTimeout;

      await expect(acquireLock(TEST_DIR, { timeoutMs: 50 })).rejects.toThrow(/Timed out/);

      expect(requestedDelays.length).toBeGreaterThan(0);
      expect(Math.max(...requestedDelays)).toBeLessThanOrEqual(50);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      await releaseLock(lock1);
    }
  });

  test('detects and cleans stale lock from dead process', async () => {
    const lockDir = join(TEST_DIR, '.mbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: 999999999,
      acquired_at: Date.now(),
      command: 'test',
    }));

    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    await releaseLock(lock);
  });

  test('does not steal an old lock from a still-running process', async () => {
    const lockDir = join(TEST_DIR, '.mbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: process.pid,
      acquired_at: Date.now() - (10 * 60 * 1000),
      command: 'still-running-test',
    }));

    await expect(acquireLock(TEST_DIR, { timeoutMs: 200 })).rejects.toThrow(/Timed out/);
    expect(existsSync(lockDir)).toBe(true);
  });

  test('skips lock for in-memory databases', async () => {
    const lock = await acquireLock(undefined);
    expect(lock.acquired).toBe(true);
    expect(lock.lockDir).toBe('');

    await releaseLock(lock);
  });

  test('lock file contains PID and command', async () => {
    const lock = await acquireLock(TEST_DIR);
    const lockData = JSON.parse(readFileSync(join(TEST_DIR, '.mbrain-lock', 'lock'), 'utf-8'));

    expect(lockData.pid).toBe(process.pid);
    expect(lockData.acquired_at).toBeDefined();
    expect(lockData.command).toBeDefined();

    await releaseLock(lock);
  });
});
