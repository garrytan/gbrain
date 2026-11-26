/**
 * Claim epochs and protected writes (lane L5, step 3) on a real Rust brain, through the typed engine, the queue and
 * the napi addon (rust/crates/gbrain-store/src/fence.rs, src/core/persistence/host-fence.ts).
 *
 * - Multi-user on: a job claimed under host A's fence; A's lease is taken over; A's completeJob refuses
 *   `lease_lost` and the job row is unchanged. A call with no fence on a claim that host A's live lease owns refuses
 *   `held_by_another`; with no host registered it is not refused (test/rust-multiuser-single-host.test.ts). The queue passes the
 *   registered fence (`fenceOpts`) on every protected call, with no change to its callers.
 * - Switch off, plain Rust brain: the same calls with no fence behave as they always did, and nothing is registered.
 * - The job worker's own registration (`startWorkerFence`): taken on a multi-user brain, renewed, released at stop.
 *
 * The consumer's own registration (consumer-heartbeat.ts) is built elsewhere; the host registration here is set with
 * `setHostRegistration` directly, as the consumer does when it becomes the full consumer.
 *
 * Needs the addon `bash /var/tmp/l5-build-addon.sh` / `bun run rust:build` writes; skips without it
 * (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { rustLeases, type LeaseToken, type WriteOrigin } from '../src/core/rust-engine/store-members/leases.ts';
import { clearHostRegistration, effectInstallClaim, fenceOpts, hostRegistrationOf, setHostRegistration, type HostRegistration } from '../src/core/persistence/host-fence.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { withDrainLease } from '../src/core/persistence/sync-lease.ts';
import { startWorkerFence } from '../src/core/minions/worker-fence.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { completeWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { claimPersistenceEffect } from '../src/core/persistence/effect-journal.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = process.env.GBRAIN_RUST_ENGINE_ADDON
  ?? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; build the addon`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let addon: RustAddon | undefined;
const dirs: string[] = [];
const engines: RustEngine[] = [];

async function open(): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const path = mkdtempSync(join(tmpdir(), 'gbrain-rust-fence-'));
  dirs.push(path);
  const engine = openRustEngine({ addon, databasePath: path });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: path } );
  return engine;
}

const holder = (host: string): WriteOrigin => ({ host_id: `${host}-host`, incarnation: `${host}-incarnation`, writer_id: 'local_cli:test' });

async function refusal(fn: () => Promise<unknown>): Promise<{ code?: string; reason?: string }> {
  try { await fn(); } catch (error) { return { code: (error as OperationError).code, reason: (error as OperationError).reason }; }
  return {};
}

function claimSpec(lockToken: string, fence?: LeaseToken) {
  return {
    lockToken, lockDurationMs: 30_000, queue: 'default', names: ['work'], handlerTimeouts: {}, handlerLockDurations: {},
    legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 }, ...(fence ? { fence } : {}),
  };
}

/** Stands in for one holder on this engine that re-registers: a new registration replaces the one it held before. */
const held = new WeakMap<object, HostRegistration>();
function register(engine: RustEngine, fence: LeaseToken, host = 'a') {
  const registration = { hostId: `${host}-host`, origin: holder(host), fence };
  const before = held.get(engine);
  if (before) clearHostRegistration(engine, before);
  setHostRegistration(engine, registration);
  held.set(engine, registration);
  return registration;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('protected job writes through the typed engine and napi', () => {
  withAddon('a job claimed under host A, A\'s lease taken over: A\'s completeJob refuses lease_lost and the row is unchanged', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const leases = rustLeases(engine);
      const queue = new MinionQueue(engine);
      const a = (await leases.acquire('jobs:h', holder('a'), 60_000))!;
      const job = await queue.add('work', {});
      const claimed = await engine.claimNextJob(claimSpec('w:1', a));
      expect(claimed?.id).toBe(job.id);
      const before = await engine.getJob(job.id);
      // Host A pauses; its lease is taken over.
      await leases.release(a);
      const b = (await leases.acquire('jobs:h', holder('b'), 60_000))!;
      expect(b.epoch).toBe(a.epoch + 1);
      expect(await refusal(() => engine.completeJob(job.id, 'w:1', undefined, { fence: a }))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await refusal(() => engine.failJob(job.id, 'w:1', 'x', 'failed', undefined, undefined, { fence: a }))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await refusal(() => engine.renewJobLease(job.id, 'w:1', 30_000, { fence: a }))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await engine.getJob(job.id)).toEqual(before);
      // The new holder's fence cannot finish a claim taken under the old epoch.
      expect(await refusal(() => engine.completeJob(job.id, 'w:1', undefined, { fence: b }))).toEqual({ code: 'lease_lost', reason: 'claim_epoch_mismatch' });
      expect(await engine.getJob(job.id)).toEqual(before);
    });
  });

  withAddon('a protected call with no fence is not refused for it; it refuses held_by_another only where a registered holder\'s live lease owns the claim', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const queue = new MinionQueue(engine);
      const a = (await rustLeases(engine).acquire('jobs:h', holder('a'), 60_000))!;
      const job = await queue.add('work', {});
      await engine.claimNextJob(claimSpec('w:1', a));
      const before = await engine.getJob(job.id);
      expect(await refusal(() => engine.completeJob(job.id, 'w:1'))).toEqual({ code: 'lease_lost', reason: 'held_by_another' });
      expect(await refusal(() => engine.renewJobLease(job.id, 'w:1', 30_000))).toEqual({ code: 'lease_lost', reason: 'held_by_another' });
      expect(await engine.getJob(job.id)).toEqual(before);
      // A sweep with no fence is not refused; the claim is still live, so it reclaims nothing.
      expect(await refusal(() => engine.reclaimStalledJobs(0))).toEqual({});
      expect(await engine.getJob(job.id)).toEqual(before);
      // With no claim of a registered holder in the way, an unfenced call claims, renews and completes.
      const other = await queue.add('work', {});
      expect((await engine.claimNextJob(claimSpec('w:2')))?.id).toBe(other.id);
      expect(await refusal(() => engine.renewJobLease(other.id, 'w:2', 30_000))).toEqual({});
      expect(await refusal(() => engine.completeJob(other.id, 'w:2'))).toEqual({});
      // The queue passes the registered fence on its own: the same calls succeed through it.
      register(engine, a);
      expect(await queue.renewLock(job.id, 'w:1', 30_000)).toBe(true);
      expect((await queue.completeJob(job.id, 'w:1'))?.status).toBe('completed');
    });
  });

  withAddon('the queue carries the registered fence: a stale registration is refused, the row is unchanged', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const leases = rustLeases(engine);
      const queue = new MinionQueue(engine);
      const a = (await leases.acquire('consumer:h', holder('a'), 60_000))!;
      register(engine, a);
      const job = await queue.add('work', {});
      const claimed = await queue.claim('w:1', 30_000, 'default', ['work']);
      expect(claimed?.id).toBe(job.id);
      const before = await queue.getJob(job.id);
      await leases.release(a);
      await leases.acquire('consumer:h', holder('b'), 60_000);
      expect(await refusal(() => queue.completeJob(job.id, 'w:1'))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await queue.getJob(job.id)).toEqual(before);
    });
  });
});

describe('the switch off: a plain Rust brain', () => {
  withAddon('the same calls with no fence behave as they always did, and nothing is registered', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: undefined }, async () => {
      const engine = await open();
      expect(engine.openStore('test').multiuser).toBe(false);
      const queue = new MinionQueue(engine);
      expect(fenceOpts(engine)).toEqual({});
      const job = await queue.add('work', {});
      const claimed = await queue.claim('w:1', 30_000, 'default', ['work']);
      expect(claimed?.id).toBe(job.id);
      expect(await queue.renewLock(job.id, 'w:1', 30_000)).toBe(true);
      expect((await queue.completeJob(job.id, 'w:1'))?.status).toBe('completed');
      // A stale token still changes nothing.
      expect(await queue.completeJob(job.id, 'w:1')).toBeNull();
      // A worker fence does not register on a plain brain.
      expect(await startWorkerFence(engine, 'worker-1')).toBeNull();
      expect(hostRegistrationOf(engine)).toBeNull();
    });
  });
});

describe('the job worker\'s own registration', () => {
  withAddon('takes jobs:<host>:<pid>:<nonce>, renews it, takes it again under a new epoch after a loss, releases at stop', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const leases = rustLeases(engine);
      const fence = await startWorkerFence(engine, 'worker-1', { renewMs: 25, ttlMs: 60_000 });
      expect(fence).not.toBeNull();
      const first = hostRegistrationOf(engine)!;
      expect(first.fence.name).toMatch(new RegExp(`^jobs:${first.hostId}:${process.pid}:[0-9a-f-]{36}$`));
      expect(first.origin.writer_id).toBe('job_worker:worker-1');
      expect((await leases.read(first.fence.name))?.live).toBe(true);
      // The queue now works on the multi-user brain with no consumer in the process.
      const queue = new MinionQueue(engine);
      const job = await queue.add('work', {});
      expect((await queue.claim('w:1', 30_000, 'default', ['work']))?.id).toBe(job.id);
      // The lease is lost (released behind the worker's back): the next renewal takes it again under a new epoch.
      await leases.release(first.fence);
      const deadline = Date.now() + 5_000;
      while (hostRegistrationOf(engine) === first && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      const second = hostRegistrationOf(engine)!;
      expect(second.fence.epoch).toBe(first.fence.epoch + 1);
      // The claim is bound to the registration it was taken under (the old epoch, which is gone), never to the new one.
      expect(await refusal(() => queue.completeJob(job.id, 'w:1'))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      await fence!.stop();
      expect(hostRegistrationOf(engine)).toBeNull();
      expect((await leases.read(second.fence.name))?.live).toBe(false);
      clearHostRegistration(engine, second);
    });
  });

  withAddon('a worker in a process that already has a registration takes its own lease and never borrows the other\'s (review G11)', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const leases = rustLeases(engine);
      const a = (await leases.acquire('consumer:h', holder('a'), 60_000))!;
      register(engine, a);
      const fence = await startWorkerFence(engine, 'worker-1');
      expect(fence).not.toBeNull();
      const own = fence!.fence();
      expect(own?.name).toMatch(/^jobs:/);
      expect((await leases.read(own!.name))?.live).toBe(true);
      // Stopping the worker releases its own lease only: the consumer's registration is untouched.
      await fence!.stop();
      expect((await leases.read(own!.name))?.live).toBe(false);
      expect((await leases.read('consumer:h'))?.live).toBe(true);
    });
  });
});

describe('review G1, G3, G7, G11: the queue and the lock handle bind each claim to the fence it was taken under', () => {
  withAddon('G1: progress, token accounting and inbox reads carry the fence and are refused after the host lost its lease', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const leases = rustLeases(engine);
      const queue = new MinionQueue(engine);
      const a = (await leases.acquire('consumer:h', holder('a'), 60_000))!;
      register(engine, a);
      const job = await queue.add('work', {});
      expect((await queue.claim('w:1', 30_000, 'default', ['work']))?.id).toBe(job.id);
      expect(await queue.updateProgress(job.id, 'w:1', { n: 1 })).toBe(true);
      expect(await queue.updateTokens(job.id, 'w:1', { input: 3, output: 1 })).toBe(true);
      await queue.sendMessage(job.id, { type: 'note' }, 'admin');
      expect(await queue.readInbox(job.id, 'w:1')).toHaveLength(1);
      await queue.sendMessage(job.id, { type: 'note', n: 2 }, 'admin');
      const before = await engine.getJob(job.id);
      // The host's lease is taken over: the progress, token and inbox writes are refused and change nothing.
      await leases.release(a);
      await leases.acquire('consumer:h', holder('b'), 60_000);
      const stale = { code: 'lease_lost', reason: 'epoch_moved' };
      expect(await refusal(() => queue.updateProgress(job.id, 'w:1', { n: 2 }))).toEqual(stale);
      expect(await refusal(() => queue.updateTokens(job.id, 'w:1', { input: 100 }))).toEqual(stale);
      expect(await refusal(() => queue.readInbox(job.id, 'w:1'))).toEqual(stale);
      expect(await engine.getJob(job.id)).toEqual(before);
    });
  });

  withAddon('G11: a claim stays bound to the registration it was taken under, whatever registration is current at call time', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const leases = rustLeases(engine);
      const queue = new MinionQueue(engine);
      const a = (await leases.acquire('consumer:h', holder('a'), 60_000))!;
      const first = register(engine, a);
      const job = await queue.add('work', {});
      expect((await queue.claim('w:1', 30_000, 'default', ['work']))?.id).toBe(job.id);
      const before = await engine.getJob(job.id);
      // The host registers again under a new epoch and the engine now shows the new registration.
      await leases.release(a);
      const b = (await leases.acquire('consumer:h', holder('b'), 60_000))!;
      clearHostRegistration(engine, first);
      register(engine, b, 'b');
      expect(await refusal(() => queue.renewLock(job.id, 'w:1', 30_000))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await refusal(() => queue.completeJob(job.id, 'w:1'))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await engine.getJob(job.id)).toEqual(before);
    });
  });

  withAddon('G7: the worker timeout sweeps carry the fence: a live host ends the job and its claim epoch, a host that lost its lease ends nothing', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const leases = rustLeases(engine);
      const queue = new MinionQueue(engine);
      const a = (await leases.acquire('consumer:h', holder('a'), 60_000))!;
      register(engine, a);
      const job = await queue.add('work', {}, { timeout_ms: 20 });
      expect((await queue.claim('w:1', 30_000, 'default', ['work']))?.id).toBe(job.id);
      await new Promise(r => setTimeout(r, 80));
      // A sweep from a host that lost its lease: refused, the job stays active.
      await leases.release(a);
      await leases.acquire('consumer:h', holder('b'), 60_000);
      expect(await refusal(() => queue.handleTimeouts())).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await refusal(() => queue.handleWallClockTimeouts(30_000))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect((await engine.getJob(job.id))?.status).toBe('active');
    });
  });

  withAddon('G7: a live host\'s timeout sweep ends the job', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const queue = new MinionQueue(engine);
      const a = (await rustLeases(engine).acquire('consumer:h', holder('a'), 60_000))!;
      register(engine, a);
      const job = await queue.add('work', {}, { timeout_ms: 20 });
      expect((await queue.claim('w:1', 30_000, 'default', ['work']))?.id).toBe(job.id);
      await new Promise(r => setTimeout(r, 80));
      const dead = await queue.handleTimeouts();
      expect(dead.map(j => j.id)).toEqual([job.id]);
      expect((await engine.getJob(job.id))?.status).toBe('dead');
    });
  });

  withAddon('G3: a cycle-lock handle keeps the fence it was acquired under: after the host registers again it neither refreshes nor releases', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const leases = rustLeases(engine);
      const a = (await leases.acquire('consumer:h', holder('a'), 60_000))!;
      const first = register(engine, a);
      const handle = await tryAcquireDbLock(engine, 'gbrain-sync:default', 30);
      expect(handle).not.toBeNull();
      // The host registers again under a new epoch; the engine now shows the new registration.
      await leases.release(a);
      const b = (await leases.acquire('consumer:h', holder('b'), 60_000))!;
      clearHostRegistration(engine, first);
      register(engine, b, 'b');
      const held = () => engine.readCycleLocks({ by: 'id', lockId: 'gbrain-sync:default' });
      expect(await held()).toHaveLength(1);
      expect(await refusal(() => handle!.refresh())).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      // Release is quiet (the lock is no longer this handle's to give up) and deletes nothing.
      await handle!.release();
      expect(await held()).toHaveLength(1);
      // The operator's stale delete is a different entry point: it takes the row the snapshot showed.
      const [row] = await held();
      const { deleteLockRowExact } = await import('../src/core/db-lock.ts');
      expect((await deleteLockRowExact(engine, 'gbrain-sync:default', row!.holder_pid, row!.acquisition_token)).deleted).toBe(true);
      expect(await held()).toHaveLength(0);
    });
  });

  withAddon('G3: a handle taken and released under one live registration works as it did', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const a = (await rustLeases(engine).acquire('consumer:h', holder('a'), 60_000))!;
      register(engine, a);
      const handle = await tryAcquireDbLock(engine, 'gbrain-sync:default', 30);
      expect(await handle!.refresh()).toBe(true);
      await handle!.release();
      expect(await engine.readCycleLocks({ by: 'id', lockId: 'gbrain-sync:default' })).toHaveLength(0);
    });
  });

  withAddon('G5: the drain lease writes, renews and deletes its beacon under the cycle lock\'s own fence', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const leases = rustLeases(engine);
      const a = (await leases.acquire('consumer:h', holder('a'), 60_000))!;
      register(engine, a);
      let token = '';
      const result = await withDrainLease(engine, 'default', { holder: { kind: 'cli' } }, async () => {
        const [row] = await engine.readCycleLocks({ by: 'id', lockId: 'gbrain-sync:default' });
        token = row!.acquisition_token;
        expect(await engine.readDrainLeaseBeacon(token)).not.toBeNull();
        return { status: 'synced' } as never;
      });
      expect((result as { status: string }).status).toBe('synced');
      expect(await engine.readDrainLeaseBeacon(token)).toBeNull();
    });
  });

  withAddon('G13 (evidence): on a Rust brain a managed sync refuses managed_persistence before any statement runs, so assertDrainLease\'s raw SQL is never reached', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const a = (await rustLeases(engine).acquire('consumer:h', holder('a'), 60_000))!;
      register(engine, a);
      const raw: string[] = [];
      const executeRaw = engine.executeRaw.bind(engine);
      (engine as { executeRaw: unknown }).executeRaw = (sql: string, ...rest: unknown[]) => { raw.push(sql); return (executeRaw as (...args: unknown[]) => unknown)(sql, ...rest); };
      const { performManagedSync } = await import('../src/core/persistence/sync-run.ts');
      const failure = await refusal(() => performManagedSync(engine, { sourceId: 'default' } as never));
      expect(failure.code).toBe('engine_capability_missing');
      expect(raw).toEqual([]);
    });
  });
});

describe('request and effect claims under a host fence (G2, G6, G8, G18)', () => {
  const REQUEST = 'b0000000-0000-4000-8000-0000000000b1';
  const TOKEN = 'c0000000-0000-4000-8000-0000000000c1';
  const TOKEN_2 = 'c0000000-0000-4000-8000-0000000000c2';
  const HOST_ID = 'd0000000-0000-4000-8000-0000000000d1';
  const COUNTERS = ['principal:local_cli:parity-writer', 'brain'];
  const failure = { code: 'git_failed', message: 'refused' };

  async function admit(engine: RustEngine) {
    const membership = await engine.readSourceMembership('default');
    await engine.lockPersistenceCounters(COUNTERS);
    return engine.insertWriteRequest({
      principalKind: 'local_cli', principalId: 'parity-writer', requestId: REQUEST, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: membership!.incarnation, pageId: null, slug: 'notes/a', worktreeId: null, topologyGeneration: null, digest: 'digest',
      intent: {}, authority: {}, intentBytes: 10, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'v-test',
      admitterHostId: null, counterKeys: COUNTERS, clientRequestId: null, state: 'queued', deferredRefreshId: null,
    } as never);
  }

  /** A registered host A, with a request claimed under it. */
  async function claimed(engine: RustEngine) {
    const leases = rustLeases(engine);
    const a = (await leases.acquire('consumer:h', holder('a'), 60_000))!;
    register(engine, a);
    const row = await admit(engine);
    expect(await engine.stampWriteClaim(row.id, TOKEN, 30_000, '{}', fenceOpts(engine))).not.toBeNull();
    return { leases, a, row };
  }

  withAddon('G18: a late renewal or release after a completed claim gets the inactive answer, not an epoch refusal', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const { a, row } = await claimed(engine);
      const current = (await getWriteRequestById(engine, row.id))!;
      await engine.transaction(tx => completeWrite(tx, current, 'failed', {}, failure));
      expect(await engine.renewWriteClaim({ id: row.id, token: TOKEN, leaseMs: 30_000, phaseJson: null, fence: a })).toBe(false);
      await engine.releaseUnpublishedClaim({ id: row.id, token: TOKEN, reason: 'late', charge: false, fence: a });
      expect((await getWriteRequestById(engine, row.id))!.state).toBe('failed');
    });
  });

  withAddon('G6: a delayed direct stamp of another live host does not take a live claim, nor a finished request', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const { leases, row } = await claimed(engine);
      const other = (await leases.acquire('consumer:o', holder('o'), 60_000))!;
      expect(await engine.stampWriteClaim(row.id, TOKEN_2, 30_000, '{}', { fence: other })).toBeNull();
      expect((await getWriteRequestById(engine, row.id))!.execution_token).toBe(TOKEN);
      const current = (await getWriteRequestById(engine, row.id))!;
      await engine.transaction(tx => completeWrite(tx, current, 'failed', {}, failure));
      expect(await engine.stampWriteClaim(row.id, TOKEN_2, 30_000, '{}', { fence: other })).toBeNull();
      expect((await getWriteRequestById(engine, row.id))!.state).toBe('failed');
    });
  });

  withAddon('G6: the effect claim passes the owners it proved dead, so a dead owner\'s effect is claimed before its lease lapses', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const { leases, row } = await claimed(engine);
      const membership = await engine.readSourceMembership('default');
      await engine.insertPublicationEffects({ requestId: row.id, revision: null, sourceId: 'default', sourceIncarnation: membership!.incarnation,
        worktreeId: null, effects: [{ kind: 'embedding', data: { slug: 'notes/a', page_id: 1 } }] } as never);
      const first = await claimPersistenceEffect(engine, HOST_ID);
      expect(first?.state).toBe('running');
      // Held by this live process: not claimable again, with or without a proof of death that names someone else.
      expect(await claimPersistenceEffect(engine, HOST_ID, ['1:other:x'])).toBeNull();
      const owner = (first as unknown as { claim_owner: { owner: { pid: number; nonce: string; start: string } } }).claim_owner.owner;
      const taken = await claimPersistenceEffect(engine, HOST_ID, [`${owner.pid}:${owner.nonce}:${owner.start}`]);
      expect(taken?.id).toBe(first!.id);
      expect(taken?.execution_token).not.toBe(first!.execution_token);
      void leases;
    });
  });

  withAddon('G2: a vector install under a taken-over host lease is refused in its own write', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const { leases, a, row } = await claimed(engine);
      const membership = await engine.readSourceMembership('default');
      await engine.insertPublicationEffects({ requestId: row.id, revision: null, sourceId: 'default', sourceIncarnation: membership!.incarnation,
        worktreeId: null, effects: [{ kind: 'embedding', data: { slug: 'notes/a', page_id: 1 } }] } as never);
      const effect = (await claimPersistenceEffect(engine, HOST_ID))!;
      const column = { name: 'embedding', type: 'vector', dimensions: 2 } as never;
      const claim = { effectId: effect.id, token: effect.execution_token!, fence: a };
      const vectors = [{ chunk_index: 0, chunk_text: 'x', vector: new Float32Array([0.5, 1]), hash: 'h', expected: null }];
      // The claim holds: the install is reached (the page does not exist, so nothing is installed).
      expect(await engine.installSegmentedVectors(999_999, column, null, vectors, claim)).toBe(0);
      await leases.release(a);
      const b = (await leases.acquire('consumer:h', holder('b'), 60_000))!;
      expect((await refusal(() => engine.installSegmentedVectors(999_999, column, null, vectors, claim))).code).toBe('lease_lost');
      expect((await refusal(() => engine.installSegmentedVectors(999_999, column, null, vectors, { ...claim, fence: b }))).reason).toBe('claim_epoch_mismatch');
    });
  });

  withAddon('G8: a successor settles the failure a predecessor recorded, and the predecessor\'s claim epoch is retired', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const { leases, a, row } = await claimed(engine);
      const journal = await engine.publicationJournalStore();
      await journal.markPublicationStarted(row.id, { fence: a });
      await journal.recordRecovery({ id: row.id, executionToken: TOKEN, recovery: { files: [] } as never, bytes: 0, keys: [], fence: a }, true);
      await journal.markRecovering(row.id, TOKEN, 'publication_refused', failure, { fence: a });
      await leases.release(a);
      const b = (await leases.acquire('consumer:h', holder('b'), 60_000))!;
      register(engine, b, 'b');
      const current = (await getWriteRequestById(engine, row.id))!;
      expect(current.state).toBe('recovering');
      // Ordinary completion needs the predecessor's claim epoch.
      expect(await refusal(() => engine.transaction(tx => completeWrite(tx, current, 'failed', {}, failure)))).toEqual({ code: 'lease_lost', reason: 'claim_epoch_mismatch' });
      // Recovery's own completion checks the current owner's fence and the recovery state instead.
      const done = await engine.transaction(tx => completeWrite(tx, current, 'failed', {}, failure, undefined, true));
      expect(done.state).toBe('failed');
      expect(await engine.renewWriteClaim({ id: row.id, token: TOKEN, leaseMs: 30_000, phaseJson: null, fence: b })).toBe(false);
    });
  });
  withAddon('G2b: the effect installs read their claim under the host fence and the claim epoch in their own transaction', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const { leases, a, row } = await claimed(engine);
      const membership = await engine.readSourceMembership('default');
      await engine.insertPublicationEffects({ requestId: row.id, revision: null, sourceId: 'default', sourceIncarnation: membership!.incarnation,
        worktreeId: null, effects: [{ kind: 'embedding', data: { slug: 'notes/a', page_id: 1 } }] } as never);
      const effect = (await claimPersistenceEffect(engine, HOST_ID))!;
      const claim = effectInstallClaim(engine, effect)!;
      expect(claim.fence).toEqual(a);
      expect(await engine.transaction(tx => tx.lockEffectClaimRow(effect.id, effectInstallClaim(tx, effect)))).toMatchObject({ state: 'running', execution_token: effect.execution_token });
      await leases.release(a);
      const b = (await leases.acquire('consumer:h', holder('b'), 60_000))!;
      expect(await refusal(() => engine.transaction(tx => tx.lockEffectClaimRow(effect.id, claim)))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await refusal(() => engine.transaction(tx => tx.lockEffectClaimRow(effect.id, { ...claim, fence: b })))).toEqual({ code: 'lease_lost', reason: 'claim_epoch_mismatch' });
      // No claim at all (a plain read) is the answer it always was.
      expect(await engine.lockEffectClaimRow(effect.id)).toMatchObject({ state: 'running' });
    });
  });

  withAddon('G18b: a claimant\'s publication step after its claim finished gets its normal answer, not an epoch refusal', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const { a, row } = await claimed(engine);
      const current = (await getWriteRequestById(engine, row.id))!;
      await engine.transaction(tx => completeWrite(tx, current, 'failed', {}, failure));
      const journal = await engine.publicationJournalStore();
      expect(await journal.recordRecovery({ id: row.id, executionToken: TOKEN, recovery: { files: [] } as never, bytes: 0, keys: [], fence: a }, true)).toBe(false);
      await journal.markRecovering(row.id, TOKEN, 'late', failure, { fence: a });
      await journal.markPublicationStarted(row.id, { fence: a });
      expect((await getWriteRequestById(engine, row.id))!.state).toBe('failed');
    });
  });
});
