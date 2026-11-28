/**
 * Owner failover on a Rust brain (docs/designs/RUST_ENGINE.md, "PR sequence" step 18). A process that owns the brain
 * is killed with SIGKILL while it and two clients write. The clients must take the brain over within a bound: one of
 * them becomes the owner and opens the store, the other becomes its client, and every write that any process saw
 * acknowledged is still there. A write in flight when the owner died ends with `owner_unavailable`
 * (`outcome_unknown`) and is never sent again, so it is not applied twice.
 *
 * Needs the file `bun run rust:build` writes (rust/target/addon) and skips without it; GBRAIN_TEST_RUST_ADDON_REQUIRED=1
 * makes a missing addon an error.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import type { OperationError } from '../src/core/ops/contract.ts';
import type { LeaseToken } from '../src/core/engine-sql/lease-token.ts';
import { processOrigin, startHostRegistration, type HostRegistrationHandle } from '../src/core/persistence/host-registration.ts';
import { fenceFor } from '../src/core/persistence/host-fence.ts';
import { rustLeases } from '../src/core/rust-engine/store-members/leases.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);
const CHILD = join(import.meta.dir, 'helpers', 'rust-owner-child.ts');
const SCRATCH = mkdtempSync(join(tmpdir(), 'gbrain-rust-owner-failover-'));
/** The longest a client may take, from the owner's death, to finish its first write on the new owner. */
const TAKEOVER_BOUND_MS = 6_000;

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Starts a child, collects its JSON lines, and resolves once it prints `ready`. */
function startChild(mode: string, db: string, worker: number, env: Record<string, string> = {}): Promise<{ child: ChildProcess; lines: Array<Record<string, unknown>> }> {
  const child = spawn(process.execPath, [CHILD, mode, db, String(worker)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env, GBRAIN_RUST_ENGINE_ADDON: BUILT },
  });
  const lines: Array<Record<string, unknown>> = [];
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', chunk => {
      buf += chunk;
      const parts = buf.split('\n');
      buf = parts.pop()!;
      for (const part of parts) {
        const line = JSON.parse(part) as Record<string, unknown>;
        lines.push(line);
        if (line.ready) resolve({ child, lines });
        if (line.fatal !== undefined) reject(new Error(`child failed: ${part}`));
      }
    });
    child.on('close', code => reject(new Error(`child exited ${code} before ready: ${stderr}`)));
  });
}

async function client(db: string): Promise<RustEngine> {
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const engine = openRustEngine({ addon, databasePath: db });
  await engine.connect({ engine: 'pglite', database_path: db } as never);
  return engine;
}

/** The host every process of a multi-writer case registers: one machine, so the owner of the brain holds its lease. */
const HOST = 'c06-host';

/** Registers `HOST` from `engine` (host-registration.ts) with renewal held off; a client has no store open, so it is inert. */
function register(engine: RustEngine): HostRegistrationHandle {
  return startHostRegistration(engine, { hostId: HOST, origin: processOrigin(HOST, 'local_consumer:test'), everyMs: 600_000 });
}

/** The old primary's fence is refused by the store: its renew and the commit check every protected write runs. */
async function expectFenced(engine: RustEngine, old: LeaseToken): Promise<void> {
  const leases = rustLeases(engine);
  for (const call of [() => leases.renew(old, 60_000), () => leases.assert(old)]) {
    const error = (await call().then(() => null, e => e)) as OperationError | null;
    expect(error?.code).toBe('lease_lost');
    expect(error?.reason).toBe('epoch_moved');
  }
}

/** Puts pages one after another until `stop`, recording every acknowledged slug and every error. */
function writeLoop(engine: RustEngine, name: string, stop: { now: boolean }) {
  const acked: string[] = [];
  const errors: OperationError[] = [];
  const done = (async () => {
    for (let n = 0; !stop.now; n++) {
      const slug = `fo/${name}-${n}`;
      try {
        await engine.putPage(slug, { type: 'note', title: `${name} ${n}`, compiled_truth: `Page ${n}.` });
        acked.push(slug);
      } catch (error) {
        errors.push(error as OperationError);
        // A refusal can come back at once; yield so the test's own timers still run.
        await Bun.sleep(5);
      }
    }
  })();
  return { acked, errors, done };
}

describe('a Rust brain whose owner is killed mid-write', () => {
  withAddon('embedded, one owner: a client takes over within the bound, one process owns the brain, and no acknowledged write is lost', async () => {
    const db = join(SCRATCH, 'brain-kill');
    const { child, lines } = await startChild('writer', db, 0);
    const engines: RustEngine[] = [];
    const stop = { now: false };
    try {
      expect(lines[0]!.role).toBe('owner');
      const a = await client(db);
      const b = await client(db);
      engines.push(a, b);
      expect(a.ownerRole).toBe('client');
      expect(b.ownerRole).toBe('client');

      const loops = [writeLoop(a, 'a', stop), writeLoop(b, 'b', stop)];
      // Let every process commit writes through the owner, then kill it while its own loop and both clients write.
      while (loops.some(loop => loop.acked.length < 20) || lines.filter(l => l.acked).length < 20) await Bun.sleep(10);
      const killedAt = Date.now();
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('close', resolve));
      const before = loops.map(loop => loop.acked.length);
      // Each client must write again on the new owner within the bound.
      while (loops.some((loop, i) => loop.acked.length <= before[i]! + 5)) {
        expect(Date.now() - killedAt).toBeLessThan(TAKEOVER_BOUND_MS);
        await Bun.sleep(10);
      }
      const tookOverMs = Date.now() - killedAt;
      stop.now = true;
      await Promise.all(loops.map(loop => loop.done));

      // Exactly one survivor owns the brain; the other reaches it through the new owner.
      expect([a.ownerRole, b.ownerRole].sort()).toEqual(['client', 'owner']);
      // A write in flight when the owner died has an unknown outcome and was not sent again; nothing else failed.
      for (const loop of loops) {
        for (const error of loop.errors) {
          expect(error.code).toBe('owner_unavailable');
          expect(error.reason).toBe('outcome_unknown');
        }
        expect(loop.errors.length).toBeLessThanOrEqual(1);
      }
      // Every write any process saw acknowledged, including the dead owner's own, is in the store.
      const acked = [...loops.flatMap(loop => loop.acked), ...lines.filter(l => l.acked).map(l => String(l.acked))];
      const reader = a.ownerRole === 'client' ? a : b;
      for (const slug of acked) expect((await reader.getPage(slug))?.slug ?? `missing ${slug}`).toBe(slug);
      console.log(`[failover] took over in ${tookOverMs} ms; ${acked.length} acknowledged writes all present`);
    } finally {
      stop.now = true;
      child.kill('SIGKILL');
      for (const engine of engines) await engine.disconnect().catch(() => undefined);
    }
  }, 60_000);
  withAddon('multi-writer (C06): after a takeover within the bound exactly one primary writes, the old primary is fenced by its token, and no acknowledged write is lost', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const db = join(SCRATCH, 'brain-c06-kill');
      const { child, lines } = await startChild('writer', db, 0, { GBRAIN_RUST_MULTIUSER: '1', GBRAIN_TEST_OWNER_HOST_ID: HOST });
      const engines: RustEngine[] = [];
      const registrations: HostRegistrationHandle[] = [];
      const stop = { now: false };
      try {
        expect(lines[0]!.role).toBe('owner');
        const old = lines[0]!.fence as LeaseToken;
        expect(old.name).toBe(`consumer:${HOST}`);
        const a = await client(db);
        const b = await client(db);
        engines.push(a, b);
        // A client has no store open, so it cannot hold the lease the owner writes under.
        const early = register(a);
        registrations.push(early);
        expect(await early.first).toBeNull();

        const loops = [writeLoop(a, 'c06a', stop), writeLoop(b, 'c06b', stop)];
        while (loops.some(loop => loop.acked.length < 20) || lines.filter(l => l.acked).length < 20) await Bun.sleep(10);
        const killedAt = Date.now();
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('close', resolve));
        const before = loops.map(loop => loop.acked.length);
        while (loops.some((loop, i) => loop.acked.length <= before[i]! + 5)) {
          expect(Date.now() - killedAt).toBeLessThan(TAKEOVER_BOUND_MS);
          await Bun.sleep(10);
        }
        stop.now = true;
        await Promise.all(loops.map(loop => loop.done));

        // Exactly one primary: the survivor that owns the brain takes the dead holder's lease over at once, at a higher
        // epoch, within the bound; the other survivor, its client, holds none.
        expect([a.ownerRole, b.ownerRole].sort()).toEqual(['client', 'owner']);
        const primary = a.ownerRole === 'owner' ? a : b;
        const other = primary === a ? b : a;
        const both = [register(primary), register(other)];
        registrations.push(...both);
        const [fence, none] = await Promise.all(both.map(r => r.first));
        expect(Date.now() - killedAt).toBeLessThan(TAKEOVER_BOUND_MS);
        expect(none).toBeNull();
        expect(fence?.name).toBe(old.name);
        expect(fence!.epoch).toBeGreaterThan(old.epoch);
        expect(fenceFor(primary)).toEqual(fence);
        expect(fenceFor(other)).toBeNull();
        await rustLeases(primary).assert(fence!);
        // The old primary is fenced by its token.
        await expectFenced(primary, old);

        for (const loop of loops) {
          for (const error of loop.errors) {
            expect(error.code).toBe('owner_unavailable');
            expect(error.reason).toBe('outcome_unknown');
          }
          expect(loop.errors.length).toBeLessThanOrEqual(1);
        }
        const acked = [...loops.flatMap(loop => loop.acked), ...lines.filter(l => l.acked).map(l => String(l.acked))];
        for (const slug of acked) expect((await other.getPage(slug))?.slug ?? `missing ${slug}`).toBe(slug);
      } finally {
        stop.now = true;
        child.kill('SIGKILL');
        for (const registration of registrations) await registration.stop();
        for (const engine of engines) await engine.disconnect().catch(() => undefined);
      }
    });
  }, 60_000);

  withAddon('embedded, one owner: a client whose owner disconnects cleanly takes the brain over on its next call', async () => {
    const db = join(SCRATCH, 'brain-close');
    const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    const owner = openRustEngine({ addon, databasePath: db });
    await owner.connect({ engine: 'pglite', database_path: db } as never);
    const c = await client(db);
    try {
      await c.putPage('fo/before', { type: 'note', title: 'Before', compiled_truth: 'x' });
      await owner.disconnect();
      expect(owner.ownerRole).toBeNull();
      expect((await c.getPage('fo/before'))?.title).toBe('Before');
      expect(c.ownerRole).toBe('owner');
      await c.putPage('fo/after', { type: 'note', title: 'After', compiled_truth: 'y' });
      expect((await c.getPage('fo/after'))?.title).toBe('After');
    } finally {
      await c.disconnect().catch(() => undefined);
      await owner.disconnect().catch(() => undefined);
    }
  }, 30_000);
  withAddon('multi-writer (C06): a primary that hands over cleanly leaves a higher epoch to the next primary, which writes on its next call', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const db = join(SCRATCH, 'brain-c06-close');
      const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
      const owner = openRustEngine({ addon, databasePath: db });
      await owner.connect({ engine: 'pglite', database_path: db } as never);
      const c = await client(db);
      const registrations: HostRegistrationHandle[] = [];
      try {
        const first = register(owner);
        registrations.push(first);
        const old = (await first.first)!;
        expect(old.name).toBe(`consumer:${HOST}`);
        await c.putPage('c06/before', { type: 'note', title: 'Before', compiled_truth: 'x' });
        // A clean handover: the primary releases its lease, then closes the brain.
        await first.stop();
        await owner.disconnect();
        // The client's next call makes it the primary, and that call writes.
        await c.putPage('c06/after', { type: 'note', title: 'After', compiled_truth: 'y' });
        expect(c.ownerRole).toBe('owner');
        const next = register(c);
        registrations.push(next);
        const fence = await next.first;
        expect(fence?.name).toBe(old.name);
        expect(fence!.epoch).toBeGreaterThan(old.epoch);
        expect(fenceFor(c)).toEqual(fence);
        await rustLeases(c).assert(fence!);
        await expectFenced(c, old);
        expect((await c.getPage('c06/before'))?.title).toBe('Before');
        expect((await c.getPage('c06/after'))?.title).toBe('After');
      } finally {
        for (const registration of registrations) await registration.stop();
        await c.disconnect().catch(() => undefined);
        await owner.disconnect().catch(() => undefined);
      }
    });
  }, 30_000);
});
