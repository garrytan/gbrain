/**
 * The managed lock seam on a real Rust brain (lane LM slice 3; src/core/persistence/managed-lock.ts, managed-operations.ts,
 * managed-registration.ts; plan decisions 1-5 and findings F1-F3, F7 of /code/.plans/lm/autoplan-s3/eng-native.a1.md).
 *
 * - Off (plain Rust, no multi-user switch): `managedLock` is the native lock itself, no lease, no registration, no `~L` key.
 * - On: lease first, then the owner host's native lock, released in reverse; a competing lease or a busy native lock
 *   refuses with null and leaves nothing held; a wait polls within its deadline; the process registers ITSELF (no
 *   `setHostRegistration` seeding); renewal keeps a long hold alive; a lease taken over, released or expired refuses every
 *   protected write transaction of the process `lease_lost` and writes nothing; host re-registration while old work is
 *   suspended never lends the new epoch to the old work.
 * - The expiry window (plan decision 5): the store checks expiry when the lease is asserted inside the writing
 *   transaction, not at commit; a takeover cannot land between assert and commit.
 *
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { rustLeases, type WriteOrigin } from '../src/core/rust-engine/store-members/leases.ts';
import { hostRegistrationOf } from '../src/core/persistence/host-fence.ts';
import { ensureProcessRegistration } from '../src/core/persistence/managed-registration.ts';
import { managedLock, managedLockLost, probeNativeLock } from '../src/core/persistence/managed-lock.ts';
import { heldManagedOperations } from '../src/core/persistence/managed-operations.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = process.env.GBRAIN_RUST_ENGINE_ADDON
  ?? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let addon: RustAddon | undefined;
const dirs: string[] = [];
const engines: RustEngine[] = [];

async function open(): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const path = mkdtempSync(join(tmpdir(), 'gbrain-managed-lock-'));
  dirs.push(path);
  const engine = openRustEngine({ addon, databasePath: path });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: path } as never);
  return engine;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const other: WriteOrigin = { host_id: 'bbbbbbbb-2222-4333-8444-555555555555', incarnation: 'other', writer_id: 'local_cli:other' };
const refusal = async (run: () => Promise<unknown>): Promise<{ code?: string; reason?: string } | null> => {
  try { await run(); return null; } catch (error) { return { code: (error as { code?: string }).code, reason: (error as { reason?: string }).reason }; }
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A fresh GBRAIN_HOME (the host identity and lock files live there) and the engine opened with the switch as given. */
async function withBrain<T>(multiuser: boolean, run: (engine: RustEngine, lockDir: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-home-')));
  dirs.push(home);
  return withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_MULTIUSER: multiuser ? '1' : undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
    async () => run(await open(), home));
}

const WORKTREE = '5f1c0d6e-7a3b-4c88-9a0e-1d2e3f405162';

describe('managedLock off a multi-user store', () => {
  withAddon('plain Rust: the native lock itself, no lease, no registration, no lease key', async () => {
    await withBrain(false, async (engine, home) => {
      const path = join(home, 'locks', 'wt.lock');
      const lock = await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 0 });
      expect(lock).not.toBeNull();
      expect(lock!.tokens).toBeUndefined();
      expect(managedLockLost(lock)).toBe(false);
      expect(await probeNativeLock(path)).toBeNull();
      await lock!.release();
      const free = await probeNativeLock(path);
      expect(free).not.toBeNull();
      await free!.release();
      expect(hostRegistrationOf(engine)).toBeNull();
      expect(heldManagedOperations(engine)).toEqual([]);
    });
  });
});

describe('managedLock on a multi-user Rust brain', () => {
  withAddon('takes the lease and the native lock, refuses a second take, and frees both on release (reverse order)', async () => {
    await withBrain(true, async (engine, home) => {
      const path = join(home, 'locks', 'wt.lock');
      const leases = rustLeases(engine);
      const first = await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 0 });
      expect(first!.tokens!.map(t => t.name)).toEqual([`managed:worktree:${WORKTREE}`]);
      expect(first!.hostFence).not.toBeNull();
      expect((await leases.read(`managed:worktree:${WORKTREE}`))!.live).toBe(true);
      expect(await probeNativeLock(path)).toBeNull();
      expect(await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 0 })).toBeNull();
      await first!.release();
      await first!.release();
      expect((await leases.read(`managed:worktree:${WORKTREE}`))!.released).toBe(true);
      const free = await probeNativeLock(path);
      expect(free).not.toBeNull();
      await free!.release();
      const again = await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 0 });
      expect(again).not.toBeNull();
      expect(again!.tokens![0]!.epoch).toBeGreaterThan(first!.tokens![0]!.epoch);
      await again!.release();
    });
  });

  withAddon('F3: the process registers itself on the first managed lock (no setHostRegistration seeding) and releases at disconnect', async () => {
    await withBrain(true, async (engine, home) => {
      expect(hostRegistrationOf(engine)).toBeNull();
      const lock = await managedLock(engine, 'topology', 'brain-1', { path: join(home, 'locks', 'topology.lock'), waitMs: 0 });
      const registration = hostRegistrationOf(engine);
      expect(registration).not.toBeNull();
      expect(registration!.fence.name.startsWith('process:')).toBe(true);
      expect(lock!.hostFence).toEqual(registration!.fence);
      const leases = rustLeases(engine);
      expect((await leases.read(registration!.fence.name))!.live).toBe(true);
      await lock!.release();
      // The registration is released with its engine (a before-disconnect hook), so a restart never waits out a stale lease.
      await engine.disconnect();
    });
  });

  withAddon('a competing managed lease refuses the take before the native lock is touched', async () => {
    await withBrain(true, async (engine, home) => {
      const path = join(home, 'locks', 'wt.lock');
      const leases = rustLeases(engine);
      const rival = (await leases.acquire(`managed:worktree:${WORKTREE}`, other, 60_000))!;
      expect(await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 0 })).toBeNull();
      const free = await probeNativeLock(path);
      expect(free).not.toBeNull();
      await free!.release();
      expect((await leases.read(`managed:worktree:${WORKTREE}`))!.epoch).toBe(rival.epoch);
      expect(heldManagedOperations(engine)).toEqual([]);
    });
  });

  withAddon('a busy native lock hands back the lease it took, so a rival can take it at once', async () => {
    await withBrain(true, async (engine, home) => {
      const path = join(home, 'locks', 'wt.lock');
      const hold = await probeNativeLock(path);
      expect(hold).not.toBeNull();
      expect(await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 0 })).toBeNull();
      await hold!.release();
      const rival = await rustLeases(engine).acquire(`managed:worktree:${WORKTREE}`, other, 60_000);
      expect(rival).not.toBeNull();
      expect(heldManagedOperations(engine)).toEqual([]);
    });
  });

  withAddon('a wait polls the lease inside its deadline and ends with null, never an error; a freed lease is then taken', async () => {
    await withBrain(true, async (engine, home) => {
      const path = join(home, 'locks', 'wt.lock');
      const leases = rustLeases(engine);
      const rival = (await leases.acquire(`managed:worktree:${WORKTREE}`, other, 60_000))!;
      const started = Date.now();
      expect(await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 150 })).toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(120);
      expect(Date.now() - started).toBeLessThan(1500);
      const waiting = managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 2000 });
      await sleep(80);
      await leases.release(rival);
      const lock = await waiting;
      expect(lock).not.toBeNull();
      await lock!.release();
    });
  });

  withAddon('renewal keeps a hold alive well past its ttl', async () => {
    await withBrain(true, async (engine, home) => {
      const path = join(home, 'locks', 'wt.lock');
      const lock = (await managedLock(engine, 'refresh', WORKTREE, { path, waitMs: 0, timing: { ttlMs: 500, renewMs: 60 } }))!;
      await sleep(1400);
      expect(lock.lost).toBe(false);
      expect(await rustLeases(engine).acquire(`managed:refresh:${WORKTREE}`, other, 60_000)).toBeNull();
      await engine.transaction(async tx => { await tx.setConfig('renewal.kept', 'yes'); });
      expect(await engine.getConfig('renewal.kept')).toBe('yes');
      await lock.release();
    });
  });

  withAddon('F2: a managed lease taken over while the host lease is still live refuses every write transaction lease_lost and writes nothing', async () => {
    await withBrain(true, async (engine, home) => {
      const path = join(home, 'locks', 'wt.lock');
      const leases = rustLeases(engine);
      // No renewal inside the test window: the lease lapses, a rival takes it over, and the host fence stays live throughout.
      const lock = (await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 0, timing: { ttlMs: 250, renewMs: 600_000 } }))!;
      await engine.transaction(async tx => { await tx.setConfig('before.takeover', '1'); });
      await sleep(320);
      const rival = (await leases.acquire(`managed:worktree:${WORKTREE}`, other, 60_000))!;
      expect(rival.epoch).toBe(lock.tokens![0]!.epoch + 1);
      expect((await leases.read(lock.hostFence!.name))!.live).toBe(true);
      const outcome = await refusal(() => engine.transaction(async tx => { await tx.setConfig('after.takeover', '1'); }));
      expect(outcome).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await engine.getConfig('after.takeover')).toBeNull();
      expect(await engine.getConfig('before.takeover')).toBe('1');
      await lock.release();
      // Released: the process writes again, and the rival's lease is untouched by the old holder's release.
      await engine.transaction(async tx => { await tx.setConfig('after.release', '1'); });
      expect((await leases.read(`managed:worktree:${WORKTREE}`))!.epoch).toBe(rival.epoch);
    });
  });

  withAddon('a renewal that finds the lease lost marks the handle lost for good; its protected writes refuse until it releases', async () => {
    await withBrain(true, async (engine, home) => {
      const path = join(home, 'locks', 'wt.lock');
      const leases = rustLeases(engine);
      const lock = (await managedLock(engine, 'topology', 'brain-1', { path, waitMs: 0, timing: { ttlMs: 60_000, renewMs: 40 } }))!;
      await leases.release(lock.tokens![0]!);
      const rival = await leases.acquire('managed:topology:brain-1', other, 60_000);
      expect(rival).not.toBeNull();
      for (let i = 0; i < 50 && !lock.lost; i++) await sleep(20);
      expect(lock.lost).toBe(true);
      expect(managedLockLost(lock)).toBe(true);
      const outcome = await refusal(() => engine.transaction(async tx => { await tx.setConfig('lost.write', '1'); }));
      expect(outcome?.code).toBe('lease_lost');
      expect(await engine.getConfig('lost.write')).toBeNull();
      await leases.release(rival!);
      // Never re-acquires into the old work: the handle stays lost although the name is free again.
      await sleep(120);
      expect(lock.lost).toBe(true);
      await lock.release();
      await engine.transaction(async tx => { await tx.setConfig('lost.after', '1'); });
    });
  });

  withAddon('host re-registration while old work is suspended: the old operation never borrows the new epoch', async () => {
    await withBrain(true, async (engine, home) => {
      const path = join(home, 'locks', 'wt.lock');
      const leases = rustLeases(engine);
      const registered = (await ensureProcessRegistration(engine, 'test', { everyMs: 40 }))!;
      const old = (await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 0 }))!;
      expect(old.hostFence).toEqual(registered.fence);
      // The host lease is lost (as after a sleep past its ttl) and the registration takes a new epoch.
      await leases.release(registered.fence);
      for (let i = 0; i < 100 && hostRegistrationOf(engine)!.fence.epoch === registered.fence.epoch; i++) await sleep(20);
      const current = hostRegistrationOf(engine)!;
      expect(current.fence.epoch).toBeGreaterThan(registered.fence.epoch);
      // The suspended operation still holds its managed lease, but its captured host fence is the old epoch: refused.
      const outcome = await refusal(() => engine.transaction(async tx => { await tx.setConfig('borrowed.epoch', '1'); }));
      expect(outcome?.code).toBe('lease_lost');
      expect(await engine.getConfig('borrowed.epoch')).toBeNull();
      await old.release();
      // New work started after the re-registration carries the new epoch and writes.
      const fresh = (await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 0 }))!;
      expect(fresh.hostFence).toEqual(current.fence);
      await engine.transaction(async tx => { await tx.setConfig('new.epoch', '1'); });
      expect(await engine.getConfig('new.epoch')).toBe('1');
      await fresh.release();
    });
  });

  withAddon('F7: the expiry window is the assert, not the commit: a takeover cannot land between them, and the next write refuses', async () => {
    await withBrain(true, async (engine, home) => {
      const path = join(home, 'locks', 'wt.lock');
      const leases = rustLeases(engine);
      const name = `managed:worktree:${WORKTREE}`;
      const lock = (await managedLock(engine, 'worktree', WORKTREE, { path, waitMs: 0, timing: { ttlMs: 300, renewMs: 600_000 } }))!;
      let takeover: Promise<unknown> | undefined;
      await engine.transaction(async tx => {
        // The lease was asserted live as this transaction began. Past its expiry, with no takeover, the writer commits:
        // this is the named window (documented in multi-user-server.md), not a guarantee of expiry at commit.
        await tx.setConfig('window.commit', 'yes');
        await sleep(380);
        // A rival that wants the (now expired) lease waits for the open transaction: no takeover lands before the commit.
        takeover = leases.acquire(name, other, 60_000);
        let settled = false;
        void takeover.then(() => { settled = true; });
        await sleep(120);
        expect(settled).toBe(false);
      });
      expect(await engine.getConfig('window.commit')).toBe('yes');
      const rival = (await takeover) as { epoch: number } | null;
      expect(rival).not.toBeNull();
      expect(rival!.epoch).toBe(lock.tokens![0]!.epoch + 1);
      // Once the takeover has landed, the old holder's next write is refused and writes nothing.
      expect(await refusal(() => engine.transaction(async tx => { await tx.setConfig('window.after', 'no'); }))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await engine.getConfig('window.after')).toBeNull();
      await lock.release();
    });
  });
});
