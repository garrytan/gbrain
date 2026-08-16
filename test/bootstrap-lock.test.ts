/**
 * Bootstrap-run mutex tests [G9, CX2-16].
 *
 * Pins the steal policy (dead PID AND age > 120s — BOTH required, the
 * pid-reuse learning), the typed BOOTSTRAP_IN_PROGRESS refusal with the
 * holder's pid, and the ownership-checked release (a replaced handle never
 * deletes the new owner's lock).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireBootstrapLock,
  bootstrapLockDir,
  releaseBootstrapLock,
  BootstrapError,
  BOOTSTRAP_LOCK_STALE_AGE_MS,
  type BootstrapLockMeta,
} from '../src/core/bootstrap/lock.ts';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'gbrain-bootstrap-lock-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

/** Plant a lock dir as if another process held it. */
function plantLock(meta: Partial<BootstrapLockMeta>): string {
  const dir = bootstrapLockDir(ws);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ pid: 1, acquired_at: Date.now(), token: 'planted', ...meta }), 'utf8');
  return dir;
}

/** A PID that is affirmatively dead: spawn a no-op child and wait it out. */
async function deadPid(): Promise<number> {
  const proc = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
  await proc.exited;
  return proc.pid;
}

describe('acquireBootstrapLock', () => {
  test('acquires and writes meta.json with our pid + token', async () => {
    const handle = await acquireBootstrapLock(ws);
    expect(existsSync(handle.dir)).toBe(true);
    const meta = JSON.parse(readFileSync(join(handle.dir, 'meta.json'), 'utf8')) as BootstrapLockMeta;
    expect(meta.pid).toBe(process.pid);
    expect(meta.token).toBe(handle.token);
    expect(handle.stole).toBe(false);
    handle.release();
    expect(existsSync(handle.dir)).toBe(false);
  });

  test('two concurrent acquires: exactly one wins, the loser gets typed BOOTSTRAP_IN_PROGRESS {pid}', async () => {
    const results = await Promise.allSettled([acquireBootstrapLock(ws), acquireBootstrapLock(ws)]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const err = (losses[0] as PromiseRejectedResult).reason as BootstrapError;
    expect(err).toBeInstanceOf(BootstrapError);
    expect(err.code).toBe('BOOTSTRAP_IN_PROGRESS');
    expect(err.details.pid).toBe(process.pid);
    expect(err.message).toContain(`bootstrap already running (pid ${process.pid})`);
    (wins[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireBootstrapLock>>>).value.release();
  });

  test('release then re-acquire works', async () => {
    const first = await acquireBootstrapLock(ws);
    first.release();
    const second = await acquireBootstrapLock(ws);
    expect(second.stole).toBe(false);
    second.release();
  });

  test('steals a stale holder: pid dead AND age > 120s', async () => {
    plantLock({ pid: await deadPid(), acquired_at: Date.now() - (BOOTSTRAP_LOCK_STALE_AGE_MS + 60_000) });
    const handle = await acquireBootstrapLock(ws);
    expect(handle.stole).toBe(true);
    const meta = JSON.parse(readFileSync(join(handle.dir, 'meta.json'), 'utf8')) as BootstrapLockMeta;
    expect(meta.pid).toBe(process.pid);
    handle.release();
  });

  test('refuses a dead-pid holder that is YOUNG (mkdir-then-meta race / pid-reuse guard)', async () => {
    plantLock({ pid: await deadPid(), acquired_at: Date.now() - 5_000 });
    await expect(acquireBootstrapLock(ws)).rejects.toMatchObject({ code: 'BOOTSTRAP_IN_PROGRESS' });
  });

  test('never steals a LIVE holder, no matter how old', async () => {
    plantLock({ pid: process.pid, acquired_at: Date.now() - 10 * BOOTSTRAP_LOCK_STALE_AGE_MS });
    try {
      await acquireBootstrapLock(ws);
      throw new Error('expected refusal');
    } catch (e) {
      expect((e as BootstrapError).code).toBe('BOOTSTRAP_IN_PROGRESS');
      expect((e as BootstrapError).details.pid).toBe(process.pid);
    }
  });

  test('corrupt meta + young dir → refuse (cannot prove staleness)', async () => {
    const dir = bootstrapLockDir(ws);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), 'not json', 'utf8');
    await expect(acquireBootstrapLock(ws)).rejects.toMatchObject({ code: 'BOOTSTRAP_IN_PROGRESS' });
  });

  test('corrupt meta + old dir (mtime) → stealable', async () => {
    const dir = bootstrapLockDir(ws);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), 'not json', 'utf8');
    const old = (Date.now() - (BOOTSTRAP_LOCK_STALE_AGE_MS + 60_000)) / 1000;
    utimesSync(dir, old, old);
    const handle = await acquireBootstrapLock(ws);
    expect(handle.stole).toBe(true);
    handle.release();
  });

  test('missing workspace dir → NOT_A_WORKSPACE, not a cryptic mkdir error', async () => {
    await expect(acquireBootstrapLock(join(ws, 'does-not-exist'))).rejects.toMatchObject({ code: 'NOT_A_WORKSPACE' });
  });
});

describe('releaseBootstrapLock', () => {
  test('ownership-checked: a replaced handle never deletes the new owner\'s lock', async () => {
    const handle = await acquireBootstrapLock(ws);
    // Simulate being stolen-and-replaced: a different token now owns the dir.
    writeFileSync(
      join(handle.dir, 'meta.json'),
      JSON.stringify({ pid: 99999, acquired_at: Date.now(), token: 'someone-else' }),
      'utf8',
    );
    handle.release();
    expect(existsSync(handle.dir)).toBe(true); // the new owner's lock survives
    releaseBootstrapLock({ dir: handle.dir, token: 'someone-else' });
    expect(existsSync(handle.dir)).toBe(false);
  });

  test('best-effort on unreadable meta: removes the dir (mirrors pglite-lock)', async () => {
    const handle = await acquireBootstrapLock(ws);
    writeFileSync(join(handle.dir, 'meta.json'), 'not json', 'utf8');
    handle.release();
    expect(existsSync(handle.dir)).toBe(false);
  });
});
