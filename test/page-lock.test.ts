import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { acquirePageLock, withPageLock } from '../src/core/page-lock.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'page-lock-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function lockFile(slug: string) {
  const sha = createHash('sha256').update(slug).digest('hex');
  return join(tmp, `${sha}.lock`);
}

describe('acquirePageLock', () => {
  test('acquires lock when none exists', async () => {
    const lock = await acquirePageLock('people/alice', { lockRoot: tmp });
    expect(lock).not.toBeNull();
    expect(lock!.slug).toBe('people/alice');
    expect(existsSync(lockFile('people/alice'))).toBe(true);
    await lock!.release();
    expect(existsSync(lockFile('people/alice'))).toBe(false);
  });

  test('returns null when a live holder exists (timeoutMs=0)', async () => {
    const first = await acquirePageLock('companies/acme', { lockRoot: tmp });
    expect(first).not.toBeNull();
    const second = await acquirePageLock('companies/acme', { lockRoot: tmp });
    expect(second).toBeNull();
    await first!.release();
  });

  test('reclaims stale lock (mtime > 5 min)', async () => {
    const slug = 'meetings/2026-04-29';
    // Write a fake stale lock with a non-existent PID.
    const path = lockFile(slug);
    require('node:fs').mkdirSync(tmp, { recursive: true });
    writeFileSync(path, `999999999\n2024-01-01T00:00:00Z\n`);
    // Backdate mtime by 10 minutes.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(path, tenMinAgo, tenMinAgo);

    const lock = await acquirePageLock(slug, { lockRoot: tmp });
    expect(lock).not.toBeNull();
    // We replaced the stale content with our own pid + fresh timestamp.
    const content = readFileSync(path, 'utf-8').trim();
    expect(content.split('\n')[0]).toBe(String(process.pid));
    await lock!.release();
  });

  test('reclaims lock when holder PID is no longer alive', async () => {
    const slug = 'people/charlie';
    const path = lockFile(slug);
    require('node:fs').mkdirSync(tmp, { recursive: true });
    // PID 999999999 is virtually guaranteed to not exist.
    writeFileSync(path, `999999999\n${new Date().toISOString()}\n`);
    const lock = await acquirePageLock(slug, { lockRoot: tmp });
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  test('refresh() updates timestamp', async () => {
    const lock = await acquirePageLock('test/refresh', { lockRoot: tmp });
    expect(lock).not.toBeNull();
    const path = lockFile('test/refresh');
    const t1 = readFileSync(path, 'utf-8');
    await new Promise(r => setTimeout(r, 50));
    await lock!.refresh();
    const t2 = readFileSync(path, 'utf-8');
    // Same pid, different timestamp.
    expect(t1.split('\n')[0]).toBe(t2.split('\n')[0]);
    expect(t1).not.toBe(t2);
    await lock!.release();
  });

  test('release() does not delete a lock held by a different pid', async () => {
    const slug = 'test/foreign-release';
    const path = lockFile(slug);
    require('node:fs').mkdirSync(tmp, { recursive: true });
    writeFileSync(path, `999999999\n${new Date().toISOString()}\n`);
    // Acquire — this rewrites the lock with our pid.
    const lock = await acquirePageLock(slug, { lockRoot: tmp });
    expect(lock).not.toBeNull();
    // Manually rewrite with a foreign pid.
    writeFileSync(path, `888888888\n${new Date().toISOString()}\n`);
    // Release should be a no-op (different pid).
    await lock!.release();
    expect(existsSync(path)).toBe(true);
  });
});

describe('withPageLock', () => {
  test('runs the callback under the lock and releases on success', async () => {
    let ran = false;
    await withPageLock('synthesis/test', async () => {
      ran = true;
      expect(existsSync(lockFile('synthesis/test'))).toBe(true);
    }, { lockRoot: tmp, timeoutMs: 5000 });
    expect(ran).toBe(true);
    expect(existsSync(lockFile('synthesis/test'))).toBe(false);
  });

  test('releases lock even when callback throws', async () => {
    await expect(
      withPageLock('synthesis/throws', async () => {
        throw new Error('boom');
      }, { lockRoot: tmp, timeoutMs: 5000 }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockFile('synthesis/throws'))).toBe(false);
  });

  test('throws when timeout elapses with a live holder', async () => {
    const first = await acquirePageLock('held/page', { lockRoot: tmp });
    expect(first).not.toBeNull();
    await expect(
      withPageLock('held/page', async () => 'unreachable', {
        lockRoot: tmp,
        timeoutMs: 200,
      }),
    ).rejects.toThrow();
    await first!.release();
  });
});

describe('SHA-256 path safety', () => {
  test('slugs with slashes/unicode produce safe filenames', async () => {
    const slug = 'people/alíce-éxample/sub';
    const lock = await acquirePageLock(slug, { lockRoot: tmp });
    expect(lock).not.toBeNull();
    const lockPath = lockFile(slug);
    // Filename is a 64-char hex sha + '.lock', not the raw slug.
    const filename = lockPath.split(sep).pop()!;
    expect(filename).toMatch(/^[0-9a-f]{64}\.lock$/);
    await lock!.release();
  });
});
