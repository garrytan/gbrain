// pack-lock.ts must stay exclusive while a holder creates, refreshes and releases its lock file.
//
// 1. Protects: one process at a time inside withPackLock. The Rust engine addon cache
//    (src/core/rust-engine/addon-fetch.ts withAddonCacheLock) relies on it, as do schema-pack mutations: two
//    processes inside at once can delete the cached addon or restore a rejected replacement.
// 2. Fails when: the lock file is created empty and filled afterwards, a refresh rewrites it in place, or a holder
//    that lost the lock still refreshes or unlinks it. Each of these lets acquirePackLock take over a live lock.
// 3. Existing coverage (test/schema-pack-pack-lock.test.ts) runs one process and never reads the lock file while it
//    is being written.
// 4. Seam: refreshPackLock is exported so the refresh can be tested without waiting 10 s for withPackLock's timer.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquirePackLock, refreshPackLock, withPackLock } from '../src/core/schema-pack/pack-lock.ts';

let lockDir: string;

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'gbrain-pack-lock-excl-'));
});

afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true });
});

const packLockModule = resolve(import.meta.dir, '../src/core/schema-pack/pack-lock.ts');

describe('pack lock exclusivity', () => {
  it('another process never sees the lock file without its complete record', async () => {
    // The child takes and releases the lock as fast as it can. acquirePackLock treats a lock file it cannot parse as
    // corrupt and takes it over at once, so every read here that finds the file but not a complete record is a moment
    // when a second process would have entered the lock beside the child.
    const script = join(lockDir, 'child.ts');
    const lockPath = join(lockDir, 'race.lock');
    writeFileSync(
      script,
      `import { withPackLock } from ${JSON.stringify(packLockModule)};\n` +
        `const end = Date.now() + 3000;\n` +
        `while (Date.now() < end) { try { await withPackLock('race', { lockDir: ${JSON.stringify(lockDir)} }, () => 0); } catch {} }\n`,
    );
    const child = Bun.spawn([process.execPath, script], { stdout: 'ignore', stderr: 'pipe' });
    let incomplete = 0;
    let complete = 0;
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      let raw: string;
      try {
        raw = readFileSync(lockPath, 'utf-8');
      } catch {
        continue; // not held at this moment
      }
      try {
        const rec = JSON.parse(raw);
        if (typeof rec.pid === 'number' && typeof rec.ts === 'number') complete++;
        else incomplete++;
      } catch {
        incomplete++;
      }
    }
    expect(await child.exited).toBe(0);
    expect(complete).toBeGreaterThan(0);
    expect(incomplete).toBe(0);
  }, 15_000);

  it('a refresh replaces the lock file in one step instead of rewriting it in place', () => {
    const got = acquirePackLock('foo', { lockDir });
    const before = statSync(got.lockPath).ino;
    expect(refreshPackLock(got.lockPath, got.record, got.record.ts + 1_000)).toBe(true);
    expect(statSync(got.lockPath).ino).not.toBe(before);
    expect(JSON.parse(readFileSync(got.lockPath, 'utf-8')).ts).toBe(got.record.ts + 1_000);
  });

  it('a holder that lost its lock neither refreshes nor releases the new holder\'s lock', async () => {
    const foreign = JSON.stringify({ pid: process.pid, hostname: 'other', ts: Date.now(), ttlMs: 60_000, token: 'other-holder' });
    await withPackLock('foo', { lockDir }, () => {
      const lockPath = join(lockDir, 'foo.lock');
      // Another process took the lock over (for example after this holder's TTL ran out).
      writeFileSync(lockPath, foreign);
      const mine = JSON.parse('{"pid":0,"hostname":"","ts":0,"ttlMs":0,"token":"this-holder"}');
      expect(refreshPackLock(lockPath, mine, Date.now())).toBe(false);
      expect(readFileSync(lockPath, 'utf-8')).toBe(foreign);
    });
    expect(existsSync(join(lockDir, 'foo.lock'))).toBe(true);
    expect(readFileSync(join(lockDir, 'foo.lock'), 'utf-8')).toBe(foreign);
  });
});
