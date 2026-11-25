/**
 * Claim epochs and protected writes (lane L5, step 3) on a real Rust brain, through the typed engine, the queue and
 * the napi addon (rust/crates/gbrain-store/src/fence.rs, src/core/persistence/host-fence.ts).
 *
 * - Multi-user on: a job claimed under host A's fence; A's lease is taken over; A's completeJob refuses
 *   `lease_lost` and the job row is unchanged. A call with no fence refuses `fence_missing`. The queue passes the
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
import { clearHostRegistration, fenceOpts, hostRegistrationOf, setHostRegistration } from '../src/core/persistence/host-fence.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { startWorkerFence } from '../src/core/minions/worker-fence.ts';
import { OperationError } from '../src/core/ops/contract.ts';
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
  await engine.connect({ engine: 'pglite', database_path: path } as never);
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

function register(engine: RustEngine, fence: LeaseToken, host = 'a') {
  const registration = { hostId: `${host}-host`, origin: holder(host), fence };
  setHostRegistration(engine, registration);
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

  withAddon('a protected call with no fence refuses fence_missing on a multi-user brain and changes nothing', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const queue = new MinionQueue(engine);
      const a = (await rustLeases(engine).acquire('jobs:h', holder('a'), 60_000))!;
      const job = await queue.add('work', {});
      expect(await refusal(() => engine.claimNextJob(claimSpec('w:1')))).toEqual({ code: 'lease_lost', reason: 'fence_missing' });
      expect((await engine.getJob(job.id))?.status).toBe('waiting');
      await engine.claimNextJob(claimSpec('w:1', a));
      const before = await engine.getJob(job.id);
      expect(await refusal(() => engine.completeJob(job.id, 'w:1'))).toEqual({ code: 'lease_lost', reason: 'fence_missing' });
      expect(await refusal(() => engine.renewJobLease(job.id, 'w:1', 30_000))).toEqual({ code: 'lease_lost', reason: 'fence_missing' });
      expect(await refusal(() => engine.reclaimStalledJobs(0))).toEqual({ code: 'lease_lost', reason: 'fence_missing' });
      expect(await engine.getJob(job.id)).toEqual(before);
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
      // The claim taken under the old epoch cannot be finished with the new one.
      expect(await refusal(() => queue.completeJob(job.id, 'w:1'))).toEqual({ code: 'lease_lost', reason: 'claim_epoch_mismatch' });
      await fence!.stop();
      expect(hostRegistrationOf(engine)).toBeNull();
      expect((await leases.read(second.fence.name))?.live).toBe(false);
      clearHostRegistration(engine, second);
    });
  });

  withAddon('a worker in a process that already has a registration uses it', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      const a = (await rustLeases(engine).acquire('consumer:h', holder('a'), 60_000))!;
      register(engine, a);
      expect(await startWorkerFence(engine, 'worker-1')).toBeNull();
    });
  });
});
