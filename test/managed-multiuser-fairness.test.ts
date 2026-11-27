/**
 * Background-writer progress under the managed double guard (lane LM slice 3, gate F1; finding F6 of
 * /code/.plans/lm/autoplan-s3/eng-native.a1.md; the multi-user port of test/effect-catchup-contention-gbra133.test.ts).
 *
 * On a multi-user Rust brain a worktree lock is the I-5 lease with the owner host's native lock beneath it. I-5 acquisition
 * has no waiter order, so fairness comes from the native layer that stays: a waiting background writer leaves a marker beside
 * the native lock (worktree-lease.ts `noteWaiting`) and other processes of the host yield to it once it has waited its
 * grace. The lease is taken before the native lock and handed back when the native lock is busy, so the marker protocol
 * orders same-host writers exactly as it did. These cases run it for real:
 *
 * - A contender in ANOTHER process takes and gives back the worktree lock in a tight loop (a sync drain's publications).
 *   An effect worker in this process, on the multi-user store, keeps getting its turns, and the contender keeps getting
 *   its own: neither is shut out.
 * - A live waiter's marker makes a no-wait take yield; a crashed waiter's marker (dead pid) and a stale one never block.
 * - Parallel lane leases (`joinLease`, `acquireWorktreeShared`) stay unreachable on a multi-user Rust brain: bulk lanes
 *   are Postgres-only (sync-group.ts), and the shared take refuses here as well.
 *
 * Needs the Rust addon: runs with GBRAIN_TEST_RUST_ARM=1 (as the Rust CI job does), and is skipped otherwise.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rustArmRequested } from './engine-parity/rust-arm.ts';
import { openManagedMultiuserBrain, type ManagedMultiuserBrain } from './helpers/rust-managed-multiuser.ts';
import { acquireWorktree, acquireWorktreeShared, acquireWorktreeWaiting, joinWorktreeLease, type WorktreeBinding } from '../src/core/persistence/ownership.ts';
import { clearWaiting, foreignWaiterAhead, FOREIGN_WAIT_GRACE_MS } from '../src/core/persistence/worktree-lease.ts';
import { resolveBulkSettings } from '../src/core/persistence/sync-group.ts';
import { managedLockLost } from '../src/core/persistence/managed-lock.ts';

describe.skipIf(!rustArmRequested())('background writers keep their turns under the managed double guard on a multi-user Rust brain', () => {
  let b: ManagedMultiuserBrain;
  let binding: WorktreeBinding;
  beforeAll(async () => {
    b = await openManagedMultiuserBrain({ activate: true });
    binding = await b.binding();
  }, 120_000);
  afterAll(async () => { await b.close(); }, 60_000);

  const markerDir = () => `${binding.coordination_path}.waiters`;

  test('an effect worker finishes its turns while a writer in another process keeps taking the lock, and that writer keeps getting turns', () => b.env(async () => {
    const stop = join(b.home, 'contender.stop'), stats = join(b.home, 'contender.json');
    const child = spawn(process.execPath, [join(import.meta.dir, 'fixtures', 'worktree-contender.ts'), JSON.stringify(binding), stop, stats],
      { env: { ...process.env, GBRAIN_HOME: b.home, GBRAIN_RUST_MULTIUSER: undefined as never }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', chunk => { if (String(chunk).includes('ready')) resolve(); });
      child.on('exit', code => reject(new Error(`the contender exited (${code}) before it held the lock`)));
    });
    let turns = 0;
    const deadline = Date.now() + 60_000;
    try {
      while (turns < 20 && Date.now() < deadline) {
        const lock = await acquireWorktreeWaiting(binding, b.engine, 10_000);
        if (!lock) continue;
        expect(managedLockLost(lock)).toBe(false);
        // The double guard: the managed lease is held while this turn holds the native lock.
        expect((lock as { tokens?: unknown[] }).tokens?.length).toBe(1);
        await Bun.sleep(5);
        await lock.release();
        turns++;
        // The turn's end: another process no longer yields to this worker until it waits again.
        clearWaiting(binding.coordination_path!);
      }
    } finally {
      writeFileSync(stop, '');
      await new Promise(resolve => child.exitCode === null ? child.on('exit', resolve) : resolve(null));
    }
    const result = existsSync(stats) ? JSON.parse(readFileSync(stats, 'utf8')) as { held: number; refused: number } : { held: 0, refused: 0 };
    expect(turns).toBe(20);
    // The other writer was held back only for the effect worker's turns, never shut out.
    expect(result.held).toBeGreaterThan(5);
  }), 120_000);

  test('a live waiter makes a no-wait take yield; a crashed waiter and a stale marker never block', () => b.env(async () => {
    mkdirSync(markerDir(), { recursive: true });
    const live = spawn('sleep', ['120']);
    const dead = spawn('true');
    await new Promise(resolve => dead.on('exit', resolve));
    try {
      const marker = (pid: number, since: number, at: number) => writeFileSync(join(markerDir(), String(pid)), JSON.stringify({ since, at }));
      // A live waiter, waiting past its grace, is ahead of this process: a no-wait take yields and holds nothing.
      marker(live.pid!, Date.now() - FOREIGN_WAIT_GRACE_MS - 2_000, Date.now());
      await Bun.sleep(150);
      expect(foreignWaiterAhead(binding.coordination_path!)).toBe(true);
      expect(await acquireWorktree(binding, 0, undefined, b.engine)).toBeNull();
      expect(await b.engine.getWorktreeBinding(binding.source_id, binding.owner_host_id)).not.toBeNull();
      // It crashes: its marker names a dead pid and is ignored (and removed); the take goes through.
      live.kill('SIGKILL');
      await new Promise(resolve => live.on('exit', resolve));
      await Bun.sleep(150);
      const afterCrash = await acquireWorktree(binding, 0, undefined, b.engine);
      expect(afterCrash).not.toBeNull();
      await afterCrash!.release();
      // A dead pid's marker and a stale one (not refreshed for over five seconds) are ignored as well.
      rmSync(markerDir(), { recursive: true, force: true });
      mkdirSync(markerDir(), { recursive: true });
      marker(dead.pid!, Date.now() - 10_000, Date.now());
      marker(1, Date.now() - 20_000, Date.now() - 10_000);
      await Bun.sleep(150);
      const ignored = await acquireWorktree(binding, 0, undefined, b.engine);
      expect(ignored).not.toBeNull();
      await ignored!.release();
    } finally { live.kill('SIGKILL'); rmSync(markerDir(), { recursive: true, force: true }); }
  }), 60_000);

  test('parallel lane leases are unreachable on a multi-user Rust brain: bulk lanes are off, the shared take refuses, no lease can be joined', () => b.env(async () => {
    const settings = await resolveBulkSettings(b.engine, undefined, 8);
    expect(settings).toMatchObject({ enabled: false, lanes: 1, lanesMax: 1 });
    expect(await acquireWorktreeShared(binding, b.engine)).toBeNull();
    expect(joinWorktreeLease(binding)).toBeNull();
  }), 60_000);
});
