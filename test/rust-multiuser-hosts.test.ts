/**
 * Writers on many hosts, the consumer side (lane L5; audit row B8): on a Rust brain in multi-user mode the store keeps
 * real consumer heartbeat rows, consumer election runs as on Postgres, and the full consumer's host registration is a
 * lease whose fence every protected call reads (src/core/persistence/host-fence.ts, host-registration.ts).
 *
 * - Off (no GBRAIN_RUST_MULTIUSER): the consumer-row members answer none and write nothing, as before; the registration
 *   is inert.
 * - On: rows renew, list and probe in the SQL engines' shape on the store clock; the registration takes
 *   `consumer:<host>`, renews it, takes a new epoch after it is lost, and releases it at stop.
 *
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { rustLeases, type LeaseToken, type RustLeases, type WriteOrigin } from '../src/core/rust-engine/store-members/leases.ts';
import { clearHostRegistration, fenceFor, fenceOpts, hostLeaseName, hostRegistrationOf, setHostRegistration } from '../src/core/persistence/host-fence.ts';
import { startPersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { rustMultiuserEngine, startHostRegistration } from '../src/core/persistence/host-registration.ts';
import type { ConsumerRenewal } from '../src/core/engine-sql/persistence-claims.ts';
import { withEnv } from './helpers/with-env.ts';
import { WaiterOnlyConsumer } from '../src/core/persistence/consumer-election.ts';
import { LANE_BUSY, type PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
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
  const path = mkdtempSync(join(tmpdir(), 'gbrain-rust-hosts-'));
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

const HOST = '11111111-2222-4333-8444-555555555555';
const origin = (nonce: string): WriteOrigin => ({ host_id: HOST, incarnation: nonce, writer_id: 'local_consumer:serve' });

function renewal(pid: number, nonce: string, mode: string): ConsumerRenewal {
  return { hostId: HOST, pid, nonce, pidNs: null, kind: 'serve', mode, restartRequired: false, rootBarrierAgeMs: null, pool: null,
    hostJsonPath: '/h/host.json', persistenceHome: '/h', mintedUnder: null, version: '0', purgeMs: 120_000, bootId: null, processStart: null };
}

type RowEngine = RustEngine & {
  renewConsumerRow(r: ConsumerRenewal): Promise<void>;
  listHostConsumerRows(host: string): Promise<Array<{ nonce: string; mode: string; renewed_age_ms: string; started_at: string }>>;
  probeLiveConsumerRows(p: { hostId: string; kinds: readonly string[]; pid: number; nonce: string; liveMs: number }): Promise<Array<{ nonce: string }>>;
  deleteConsumerRow(k: { hostId: string; pid: number; nonce: string }): Promise<void>;
};

describe('consumer heartbeat rows on a Rust brain', () => {
  withAddon('off: the members answer none and keep nothing, as before', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: undefined }, async () => {
      const engine = await open() as RowEngine;
      expect(rustMultiuserEngine(engine)).toBe(false);
      await engine.renewConsumerRow(renewal(10, 'a', 'full'));
      expect(await engine.listHostConsumerRows(HOST)).toEqual([]);
      expect(await engine.probeLiveConsumerRows({ hostId: HOST, kinds: ['serve'], pid: 11, nonce: 'b', liveMs: 30_000 })).toEqual([]);
    });
  });

  withAddon('on: rows renew, list oldest first and probe the live full consumer other than the caller', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open() as RowEngine;
      expect(rustMultiuserEngine(engine)).toBe(true);
      await engine.renewConsumerRow(renewal(10, 'a', 'full'));
      await engine.renewConsumerRow(renewal(11, 'b', 'waiter_only'));
      const rows = await engine.listHostConsumerRows(HOST);
      expect(rows.map(r => [r.nonce, r.mode])).toEqual([['a', 'full'], ['b', 'waiter_only']]);
      expect(rows[0]!.started_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00$/);
      expect(Number.isInteger(Number(rows[0]!.renewed_age_ms))).toBe(true);
      const live = await engine.probeLiveConsumerRows({ hostId: HOST, kinds: ['serve'], pid: 11, nonce: 'b', liveMs: 30_000 });
      expect(live.map(r => r.nonce)).toEqual(['a']);
      await engine.deleteConsumerRow({ hostId: HOST, pid: 10, nonce: 'a' });
      expect((await engine.listHostConsumerRows(HOST)).map(r => r.nonce)).toEqual(['b']);
    });
  });
});

describe('host registration', () => {
  test('inert on a non-Rust or single-user engine: no fence, no lease call', async () => {
    const handle = startHostRegistration({ kind: 'postgres' }, { hostId: HOST, origin: origin('n') });
    expect(handle.fence).toBeNull();
    await handle.stop();
  });

  test('takes a new epoch after its lease is lost, and stop releases and clears it', async () => {
    let epoch = 0;
    let lost = false;
    const released: LeaseToken[] = [];
    const leases: RustLeases = {
      acquire: async (name) => ({ name, epoch: ++epoch, token: `t${epoch}` }),
      // As the store: the next epoch only when the record is still at the epoch the caller proved.
      takeOver: async (name, expectedEpoch) => (expectedEpoch === epoch ? { name, epoch: ++epoch, token: `t${epoch}` } : null),
      renew: async () => { if (lost) { lost = false; throw Object.assign(new Error('lost'), { code: 'lease_lost' }); } },
      release: async (l) => { released.push(l); },
      read: async () => null,
      assert: async () => undefined,
    };
    const engine = {};
    const handle = startHostRegistration(engine, { hostId: HOST, origin: origin('n'), leases, everyMs: 60_000 });
    await handle.renew();
    expect(fenceFor(engine)).toEqual({ name: hostLeaseName(HOST), epoch: 1, token: 't1' });
    expect(fenceOpts(engine)).toEqual({ fence: { name: `consumer:${HOST}`, epoch: 1, token: 't1' } });
    lost = true;
    await handle.renew();
    expect(fenceFor(engine)?.epoch).toBe(2);
    await handle.stop();
    expect(released.map(l => l.epoch)).toEqual([2]);
    expect(hostRegistrationOf(engine)).toBeNull();
    expect(fenceOpts(engine)).toEqual({});
  });

  test('a forced consumer registers under its own name', () => {
    expect(hostLeaseName(HOST, 'nonce-1')).toBe(`consumer:${HOST}:forced:nonce-1`);
  });

  withAddon('on a multi-user Rust brain: the registration holds consumer:<host> in the store, and a second process waits its turn', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const first = startHostRegistration(engine, { hostId: HOST, origin: origin('p1'), everyMs: 60_000 });
      await first.renew();
      const state = await rustLeases(engine).read(hostLeaseName(HOST));
      expect({ epoch: state?.epoch, live: state?.live, incarnation: state?.holder.incarnation }).toEqual({ epoch: 1, live: true, incarnation: 'p1' });
      expect(fenceFor(engine)?.epoch).toBe(1);
      // Another process on the host (a second registration on another engine object) gets no fence while the first holds it.
      const other = {};
      const second = startHostRegistration(other, { hostId: HOST, origin: origin('p2'), everyMs: 60_000, leases: rustLeases(engine) });
      await second.renew();
      expect(second.fence).toBeNull();
      await first.stop();
      await second.renew();
      expect(second.fence?.epoch).toBe(2);
      await second.stop();
    });
  });
});

/** A persistence consumer that claims nothing itself: the test drives the protected calls through a queue. */
function idleInner(): PersistenceConsumer {
  return { start() {}, async stop() {}, wake() {}, async tick() {}, holds: () => false, foregroundCompletions: () => 0,
    async onLane() { return LANE_BUSY; }, restartRequired: () => false, oldestRootBarrierAgeMs: () => null,
    status: () => ({ accepting: true, active_preparations: 0, active_worktrees: 0, restart_required: false }) } as unknown as PersistenceConsumer;
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 20));
  }
}

describe('two real consumers on one host (pause, takeover, resume)', () => {
  withAddon('a consumer paused past its host lease is fenced out: its claimed job cannot finish, the new consumer works', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      // Two consumer processes of one host, each with its own engine handle on the brain.
      const engineA = Object.create(engine) as BrainEngine;
      const engineB = Object.create(engine) as BrainEngine;
      const start = (e: BrainEngine) => new WaiterOnlyConsumer(e, { engine: 'rust' } as never, idleInner,
        { kind: 'serve', hostId: HOST, pollMs: 1_000_000, idleMaxMs: 1_000_000, phaseMs: 2_000, heartbeatEveryMs: 1_000_000, hostLeaseTtlMs: 2_000,
          singleConsumer: async () => true, ceilingMs: async () => 600_000, log: () => undefined });
      const a = start(engineA);
      a.start();
      await waitFor(() => fenceFor(engineA) !== null);
      expect(fenceFor(engineA)).toMatchObject({ name: hostLeaseName(HOST), epoch: 1 });

      // A claims a job under its registration.
      const queueA = new MinionQueue(engineA);
      const job = await queueA.add('work', {});
      expect((await queueA.claim('w:a', 200, 'default', ['work']))?.id).toBe(job.id);
      const claimed = await queueA.getJob(job.id);

      // A pauses (no renewal); B starts on the same host and takes the host lease once A's expires.
      const b = start(engineB);
      b.start();
      await b.probeTick();
      // A's lease is still live: B keeps probing, never advertises full, and gets no error.
      expect(b.mode).not.toBe('full');
      expect(fenceFor(engineB)).toBeNull();
      // A's lease (2 s) runs out; B takes it over under a new epoch.
      await new Promise(r => setTimeout(r, 2_200));
      await b.probeTick();
      expect(b.mode).toBe('full');
      expect(fenceFor(engineB)).toMatchObject({ name: hostLeaseName(HOST), epoch: 2 });

      // A resumes with its old registration still in hand: its protected writes refuse, and the job row is unchanged.
      expect(fenceFor(engineA)?.epoch).toBe(1);
      const refused = await queueA.completeJob(job.id, 'w:a').then(() => null, (e: { code?: string; reason?: string }) => ({ code: e.code, reason: e.reason }));
      expect(refused).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await queueA.getJob(job.id)).toEqual(claimed);

      // B works under the new epoch: it reclaims the stalled job and finishes it.
      const queueB = new MinionQueue(engineB);
      const reclaimed = await engineB.reclaimStalledJobs(0, { fence: fenceFor(engineB)! });
      expect(reclaimed.requeued.map(j => j.id).concat(reclaimed.dead.map(j => j.id))).toContain(job.id);
      expect((await queueB.claim('w:b', 30_000, 'default', ['work']))?.id).toBe(job.id);
      expect((await queueB.completeJob(job.id, 'w:b'))?.status).toBe('completed');

      await a.stop();
      await b.stop();
      expect(fenceFor(engineB)).toBeNull();
    });
  });
});

describe('review fixes (second-model review G9, G11)', () => {
  test('G11: two holders on one engine keep their own registrations; one stopping leaves the other', () => {
    const engine = {};
    const one = { hostId: HOST, origin: origin('1'), fence: { name: 'consumer:h', epoch: 1, token: 't1' } };
    const two = { hostId: HOST, origin: origin('2'), fence: { name: 'jobs:h:1:n', epoch: 1, token: 't2' } };
    setHostRegistration(engine, one);
    setHostRegistration(engine, two);
    expect(fenceFor(engine)).toEqual(one.fence);
    clearHostRegistration(engine, one);
    expect(fenceFor(engine)).toEqual(two.fence);
    clearHostRegistration(engine, one);
    expect(fenceFor(engine)).toEqual(two.fence);
    clearHostRegistration(engine, two);
    expect(fenceFor(engine)).toBeNull();
  });

  withAddon('G9: the production consumer on a multi-user Rust brain elects and holds its host lease before claiming', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const consumer = startPersistenceConsumer(engine as unknown as BrainEngine, { engine: 'rust' } as never);
      try {
        expect(consumer).toBeInstanceOf(WaiterOnlyConsumer);
        await waitFor(() => fenceFor(engine) !== null);
        expect(fenceFor(engine)?.name.startsWith('consumer:')).toBe(true);
      } finally {
        await stopPersistenceConsumer(engine as unknown as BrainEngine);
      }
      expect(fenceFor(engine)).toBeNull();
    });
  });
});

describe('a host lease left by a process that exited without releasing it', () => {
  withAddon('is taken over at once at the next epoch when the holder is provably gone; a live holder still waits', async () => {
    const { processOrigin } = await import('../src/core/persistence/host-registration.ts');
    const { consumerIdentity } = await import('../src/core/persistence/consumer-heartbeat.ts');
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const self = consumerIdentity();
      // A process of this machine that has exited: its pid is gone.
      const child = Bun.spawnSync(['true']);
      const deadPid = child.pid;
      const dead = { ...self, pid: deadPid, nonce: 'dead-nonce' };
      const leases = rustLeases(engine);
      const left = await leases.acquire(hostLeaseName(HOST), processOrigin(HOST, 'local_consumer:serve', dead), 60_000);
      expect(left?.epoch).toBe(1);
      const reg = startHostRegistration(engine, { hostId: HOST, origin: processOrigin(HOST, 'local_consumer:serve', self), self, everyMs: 60_000 });
      expect(await reg.first).toMatchObject({ name: hostLeaseName(HOST), epoch: 2 });
      await reg.stop();
      // A live holder (this very process under another nonce) is not taken over.
      const live = await leases.acquire(hostLeaseName(HOST), processOrigin(HOST, 'local_consumer:serve', { ...self, nonce: 'live-nonce' }), 60_000);
      expect(live?.epoch).toBe(3);
      const waits = startHostRegistration({}, { hostId: HOST, origin: processOrigin(HOST, 'local_consumer:serve', { ...self, nonce: 'other' }), self: { ...self, nonce: 'other' }, everyMs: 60_000, leases });
      expect(await waits.first).toBeNull();
      await waits.stop();
    });
  });
});
