/**
 * `gbrain doctor` re-checks the datastore once it holds the PGLite lock.
 *
 * The missing-brain refusal (src/commands/doctor/missing-brain.ts) runs before doctor connects. But connecting
 * first waits for the datastore's kernel lock (another gbrain process may hold it), and the folder can be moved or
 * unmounted during that wait. Without a second look, the connect takes the lock and builds a new empty brain at
 * the path, which a plain run then migrates and reports healthy. The re-check runs under the held lock, before
 * anything is created, refuses the same way (`brain_missing`, exit 1) and releases the lock.
 *
 * The CLI test holds the lock from this process, starts the real CLI, waits until doctor is parked on the lock,
 * moves the folder, and releases the lock. The wait is a fixed delay (a subprocess exposes no signal that it is
 * parked on the lock): a doctor slower than the delay refuses at the first check and the test still passes, so the
 * module-level test below pins the same seam with no timing at all.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardMissingBrainAtLock, isMissingBrainRefusal } from '../src/commands/doctor/missing-brain.ts';
import { installPgliteCreateGuard } from '../src/core/pglite-create-guard.ts';
import { acquireKernelLockOnly, acquireLock, pgliteLockDirFor, releaseLock } from '../src/core/pglite-lock.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCli } from './helpers/cli-spawn.ts';

let home: string;
let store: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-after-lock-'));
  expect((await runCli(['init', '--pglite', '--no-embedding'], { home, timeoutMs: 120_000 })).exitCode).toBe(0);
  store = join(home, '.gbrain', 'brain.pglite');
  expect(existsSync(join(store, 'PG_VERSION'))).toBe(true);
}, 180_000);

afterAll(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

function listing(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      out.push(p);
      if (e.isDirectory() && !p.endsWith('.moved')) walk(p);
    }
  };
  walk(join(home, '.gbrain'));
  return out.sort();
}

describe('the datastore moves while doctor waits for the lock', () => {
  test('doctor refuses with brain_missing, creates nothing, and does not keep the lock', async () => {
    const moved = `${store}.moved`;
    const lock = await acquireLock(store);
    let released = false;
    try {
      const doctor = runCli(['doctor', '--only', 'connection', '--json'], { home, timeoutMs: 120_000 });
      await new Promise((resolve) => setTimeout(resolve, 4_000)); // doctor has passed its first check and waits on the lock
      renameSync(store, moved); // the drive is unmounted / the folder moved
      const before = listing();
      await releaseLock(lock);
      released = true;
      const r = await doctor;
      expect(existsSync(store)).toBe(false); // the connect must not build an empty brain where the real one was
      const out = JSON.parse(r.stdout) as Record<string, any>;
      expect(out.code).toBe('brain_missing');
      expect(out.reason).toBe('missing_brain');
      expect(out.health_score).toBeUndefined();
      expect(r.exitCode).toBe(1);
      expect(JSON.stringify(out)).toContain('Nothing was created there.');
      expect(existsSync(store)).toBe(false);
      expect(listing()).toEqual(before);
      // The refusal released the lock: this process can take it at once.
      const again = await acquireKernelLockOnly(store, { lockDir: pgliteLockDirFor(store), timeoutMs: 0 });
      await releaseLock(again);
    } finally {
      if (!released) await releaseLock(lock);
      if (existsSync(moved)) { rmSync(store, { recursive: true, force: true }); renameSync(moved, store); }
    }
  }, 180_000);
});

describe('the guard seam, with no timing involved', () => {
  const withHome = (run: () => Promise<void>) => withEnv({ HOME: home, GBRAIN_HOME: home }, run);

  test('acquireLock runs an installed guard under the held lock, before it creates the folder, and releases the lock when it throws', async () => {
    const dir = join(home, 'seam', 'brain.pglite');
    const seen: string[] = [];
    const remove = installPgliteCreateGuard((d) => { seen.push(d); throw new Error('refused by guard'); });
    try {
      await expect(acquireLock(dir, { timeoutMs: 0 })).rejects.toThrow('refused by guard');
    } finally { remove(); }
    expect(seen.map((d) => join(d, '.gbrain-lock'))).toEqual([pgliteLockDirFor(dir)]);
    expect(existsSync(dir)).toBe(false);
    const free = await acquireKernelLockOnly(dir, { lockDir: pgliteLockDirFor(dir), timeoutMs: 0 });
    await releaseLock(free);
    const ok = await acquireLock(dir, { timeoutMs: 0 }); // the guard is gone: an ordinary acquire creates the folder again
    await releaseLock(ok);
    expect(existsSync(dir)).toBe(true);
  });

  test('the datastore moves while a second acquirer waits behind the first: the waiter is refused with brain_missing, nothing is created', async () => {
    await withHome(async () => {
      const moved = `${store}.moved`;
      const holder = await acquireLock(store);
      const remove = guardMissingBrainAtLock('host');
      try {
        const waiter = acquireLock(store, { timeoutMs: 20_000 }); // cannot get the lock while the holder has it
        renameSync(store, moved);
        await releaseLock(holder);
        const refusal = await waiter.then(() => null, (e: unknown) => e);
        expect(isMissingBrainRefusal(refusal)).toBe(true);
        expect((refusal as { reason?: string }).reason).toBe('missing_brain');
        expect(existsSync(store)).toBe(false);
        await releaseLock(await acquireKernelLockOnly(store, { lockDir: pgliteLockDirFor(store), timeoutMs: 0 }));
        // A lock on some other folder is not this guard's to judge.
        const other = join(home, 'elsewhere.pglite');
        await releaseLock(await acquireLock(other, { timeoutMs: 0 }));
        expect(existsSync(other)).toBe(true);
      } finally {
        remove();
        if (existsSync(moved)) { rmSync(store, { recursive: true, force: true }); renameSync(moved, store); }
      }
    });
  });
});
