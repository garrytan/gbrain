import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
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

function lockFile(slug: string, sourceId = 'default') {
  const sha = createHash('sha256').update(sourceId).update('\0').update(slug).digest('hex');
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

  test('same slug in different sources uses independent locks', async () => {
    const first = await acquirePageLock('people/alice', { lockRoot: tmp, sourceId: 'team-a' });
    const second = await acquirePageLock('people/alice', { lockRoot: tmp, sourceId: 'team-b' });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.sourceId).toBe('team-a');
    expect(second!.sourceId).toBe('team-b');
    expect(existsSync(lockFile('people/alice', 'team-a'))).toBe(true);
    expect(existsSync(lockFile('people/alice', 'team-b'))).toBe(true);
    await first!.release();
    await second!.release();
  });

  test('fails closed on an orphaned lock instead of racing to steal it', async () => {
    const slug = 'meetings/2026-04-29';
    const path = lockFile(slug);
    require('node:fs').mkdirSync(tmp, { recursive: true });
    writeFileSync(path, `999999999\n2024-01-01T00:00:00Z\n`);
    const lock = await acquirePageLock(slug, { lockRoot: tmp });
    expect(lock).toBeNull();
    expect(readFileSync(path, 'utf8')).toContain('999999999');
  });

  // #2840: PID liveness is namespace-local. A foreign holder may resolve to
  // ESRCH locally, so PID probing must never authorize lock theft.
  test('does not steal a fresh lock whose holder PID is not visible in this namespace', async () => {
    const slug = 'people/charlie';
    const path = lockFile(slug);
    require('node:fs').mkdirSync(tmp, { recursive: true });
    // Foreign-host holder: PID 999999999 is ESRCH locally, heartbeat is fresh.
    writeFileSync(path, `999999999\n${new Date().toISOString()}\n`);
    const lock = await acquirePageLock(slug, { lockRoot: tmp });
    expect(lock).toBeNull();
    // The holder's lockfile must be untouched (not unlinked, not overwritten).
    const content = readFileSync(path, 'utf-8').trim();
    expect(content.split('\n')[0]).toBe('999999999');
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
    // Acquire — this writes the lock with our pid + ownership token.
    const lock = await acquirePageLock(slug, { lockRoot: tmp });
    expect(lock).not.toBeNull();
    // Manually rewrite with a foreign pid.
    writeFileSync(path, `888888888\n${new Date().toISOString()}\n`);
    // Release should be a no-op (different holder).
    await lock!.release();
    expect(existsSync(path)).toBe(true);
  });

  // #2840 false-self direction: PIDs collide across namespaces. A foreign
  // process whose recorded PID equals OUR process.pid must not be treated
  // as "us" — ownership is the per-acquire token, never the bare PID.
  test('release() does not unlink a same-pid lock acquired by a foreign process', async () => {
    const slug = 'test/pid-collision-release';
    const path = lockFile(slug);
    require('node:fs').mkdirSync(tmp, { recursive: true });
    const lock = await acquirePageLock(slug, { lockRoot: tmp });
    expect(lock).not.toBeNull();
    // Simulate a foreign-namespace process with a colliding PID that took
    // over the lock (e.g. after our TTL lapsed): same pid, different token.
    const foreign = `${process.pid}\n${new Date().toISOString()}\nforeign-token-not-ours\n`;
    writeFileSync(path, foreign);
    await lock!.release();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(foreign);
  });

  test('refresh() does not clobber a lock we no longer own', async () => {
    const slug = 'test/refresh-lost-ownership';
    const path = lockFile(slug);
    require('node:fs').mkdirSync(tmp, { recursive: true });
    const lock = await acquirePageLock(slug, { lockRoot: tmp });
    expect(lock).not.toBeNull();
    // A foreign process (colliding pid, different token) now holds the lock.
    const foreign = `${process.pid}\n${new Date().toISOString()}\nforeign-token-not-ours\n`;
    writeFileSync(path, foreign);
    await lock!.refresh();
    // refresh must be a no-op — the foreign holder's heartbeat is untouched.
    expect(readFileSync(path, 'utf-8')).toBe(foreign);
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
