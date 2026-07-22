// v0.40.6.0 — pack-lock.ts contract tests.
//
// Pins the atomic-acquire, stale-detection, refresh, and cleanup behavior
// that the schema cathedral v3 mutation skeleton depends on.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquirePackLock,
  isLockStale,
  PackLockBusyError,
  withPackLock,
  type LockFileRecord,
} from '../src/core/schema-pack/pack-lock.ts';

let lockDir: string;

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'gbrain-pack-lock-test-'));
});

afterEach(() => {
  try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* swallow */ }
});

const liveAlways = (_pid: number): boolean => true;
const deadAlways = (_pid: number): boolean => false;

describe('acquirePackLock — clean acquire', () => {
  it('atomically creates the lockfile on first call', () => {
    const result = acquirePackLock('foo', { lockDir });
    expect(result.outcome).toBe('acquired');
    expect(existsSync(join(lockDir, 'foo.lock'))).toBe(true);
    expect(result.record.pid).toBe(process.pid);
    expect(result.record.ttlMs).toBeGreaterThan(0);
  });

  it('writes valid JSON record with pid, ts, ttlMs, hostname', () => {
    acquirePackLock('foo', { lockDir, ttlMs: 12345 });
    const raw = readFileSync(join(lockDir, 'foo.lock'), 'utf-8');
    const parsed = JSON.parse(raw) as LockFileRecord;
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.ttlMs).toBe(12345);
    expect(typeof parsed.ts).toBe('number');
    expect(typeof parsed.hostname).toBe('string');
  });

  it('auto-creates the parent directory on first acquire', () => {
    const deepDir = join(lockDir, 'a', 'b', 'c');
    const result = acquirePackLock('bar', { lockDir: deepDir });
    expect(result.outcome).toBe('acquired');
    expect(existsSync(join(deepDir, 'bar.lock'))).toBe(true);
  });
});

describe('acquirePackLock — contention', () => {
  it('refuses when lock is held by live process with non-expired TTL', () => {
    // Hand-craft a live, fresh lock.
    const lockPath = join(lockDir, 'foo.lock');
    const record: LockFileRecord = {
      pid: 99999,
      hostname: 'test',
      ts: Date.now(),
      ttlMs: 60_000,
    };
    writeFileSync(lockPath, JSON.stringify(record), 'utf-8');

    expect(() =>
      acquirePackLock('foo', { lockDir, isPidAlive: liveAlways }),
    ).toThrow(PackLockBusyError);
  });

  it('steals lock when holder PID is dead', () => {
    const lockPath = join(lockDir, 'foo.lock');
    writeFileSync(lockPath, JSON.stringify({
      pid: 99999, hostname: 'test', ts: Date.now(), ttlMs: 60_000,
    }), 'utf-8');

    const result = acquirePackLock('foo', { lockDir, isPidAlive: deadAlways });
    expect(result.outcome).toBe('stolen_stale');
    expect(result.record.pid).toBe(process.pid);
  });

  it('steals lock when TTL is expired even if PID is alive', () => {
    const lockPath = join(lockDir, 'foo.lock');
    writeFileSync(lockPath, JSON.stringify({
      pid: 99999, hostname: 'test', ts: Date.now() - 120_000, ttlMs: 60_000,
    }), 'utf-8');

    const result = acquirePackLock('foo', { lockDir, isPidAlive: liveAlways });
    expect(result.outcome).toBe('stolen_stale');
  });

  it('steals lock with --force even when live + non-stale', () => {
    const lockPath = join(lockDir, 'foo.lock');
    writeFileSync(lockPath, JSON.stringify({
      pid: 99999, hostname: 'test', ts: Date.now(), ttlMs: 60_000,
    }), 'utf-8');

    const result = acquirePackLock('foo', { lockDir, force: true, isPidAlive: liveAlways });
    expect(result.outcome).toBe('forced');
    expect(result.record.pid).toBe(process.pid);
  });

  it('PackLockBusyError carries heldBy + ageMs + ttlMs', () => {
    const lockPath = join(lockDir, 'foo.lock');
    const past = Date.now() - 1500;
    writeFileSync(lockPath, JSON.stringify({
      pid: 88888, hostname: 'test', ts: past, ttlMs: 60_000,
    }), 'utf-8');

    try {
      acquirePackLock('foo', { lockDir, isPidAlive: liveAlways });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PackLockBusyError);
      const lockErr = err as PackLockBusyError;
      expect(lockErr.heldBy).toBe(88888);
      expect(lockErr.ageMs).toBeGreaterThanOrEqual(1500);
      expect(lockErr.ttlMs).toBe(60_000);
    }
  });
});

describe('acquirePackLock — corruption recovery', () => {
  it('steals when lockfile content is unparseable', () => {
    const lockPath = join(lockDir, 'foo.lock');
    writeFileSync(lockPath, 'not-valid-json{{{', 'utf-8');
    const result = acquirePackLock('foo', { lockDir, isPidAlive: liveAlways });
    expect(result.outcome).toBe('stolen_stale');
  });

  it('steals when lockfile is empty', () => {
    const lockPath = join(lockDir, 'foo.lock');
    writeFileSync(lockPath, '', 'utf-8');
    const result = acquirePackLock('foo', { lockDir, isPidAlive: liveAlways });
    expect(result.outcome).toBe('stolen_stale');
  });

  it('steals when lockfile shape is missing required fields', () => {
    const lockPath = join(lockDir, 'foo.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 'not-a-number' }), 'utf-8');
    const result = acquirePackLock('foo', { lockDir, isPidAlive: liveAlways });
    expect(result.outcome).toBe('stolen_stale');
  });
});

describe('isLockStale — policy unit tests', () => {
  it('returns live when ts is fresh and pid is alive', () => {
    const rec: LockFileRecord = { pid: 1, hostname: 'h', ts: 1000, ttlMs: 60_000 };
    expect(isLockStale(rec, 30_000, liveAlways)).toEqual({ stale: false, reason: 'live' });
  });

  it('returns ttl_expired when age > ttl, regardless of PID', () => {
    const rec: LockFileRecord = { pid: 1, hostname: 'h', ts: 1000, ttlMs: 1000 };
    expect(isLockStale(rec, 5000, liveAlways)).toEqual({ stale: true, reason: 'ttl_expired' });
  });

  it('returns pid_dead when age <= ttl but PID is dead', () => {
    const rec: LockFileRecord = { pid: 1, hostname: 'h', ts: 1000, ttlMs: 60_000 };
    expect(isLockStale(rec, 2000, deadAlways)).toEqual({ stale: true, reason: 'pid_dead' });
  });

  it('checks ttl BEFORE pid (avoids unnecessary kill syscall)', () => {
    const rec: LockFileRecord = { pid: 1, hostname: 'h', ts: 1000, ttlMs: 1000 };
    let pidProbed = false;
    const probe = (_pid: number) => { pidProbed = true; return true; };
    isLockStale(rec, 5000, probe);
    expect(pidProbed).toBe(false);
  });
});

describe('withPackLock — wrapper contract', () => {
  it('runs the callback and releases lock on success', async () => {
    let ran = false;
    await withPackLock('foo', { lockDir }, async () => {
      ran = true;
      expect(existsSync(join(lockDir, 'foo.lock'))).toBe(true);
    });
    expect(ran).toBe(true);
    expect(existsSync(join(lockDir, 'foo.lock'))).toBe(false);
  });

  it('releases lock even when callback throws', async () => {
    await expect(
      withPackLock('foo', { lockDir }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(join(lockDir, 'foo.lock'))).toBe(false);
  });

  it('returns the callback value', async () => {
    const result = await withPackLock('foo', { lockDir }, async () => 42);
    expect(result).toBe(42);
  });

  it('serializes two concurrent withPackLock calls (second throws BUSY)', async () => {
    let firstReleased = false;
    const first = withPackLock('foo', { lockDir }, async () => {
      // Hold for 50ms.
      await new Promise((r) => setTimeout(r, 50));
      firstReleased = true;
    });
    // Give first a moment to acquire.
    await new Promise((r) => setTimeout(r, 10));
    await expect(
      withPackLock('foo', { lockDir, isPidAlive: liveAlways }, async () => 'second'),
    ).rejects.toThrow(PackLockBusyError);
    await first;
    expect(firstReleased).toBe(true);
  });
});

describe('cleanup invariants', () => {
  it('does not leak file descriptors across many acquire/release cycles', async () => {
    // Smoke test — 100 cycles. If we leaked fds, EMFILE would eventually fire.
    for (let i = 0; i < 100; i++) {
      await withPackLock('foo', { lockDir }, async () => {
        return i;
      });
    }
    expect(existsSync(join(lockDir, 'foo.lock'))).toBe(false);
  });
});
