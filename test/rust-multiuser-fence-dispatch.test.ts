/**
 * The host-fence dispatch refusal (lane L5, Ember's decision A; docs/designs/rust-engine/multi-user-server.md, "I-5,
 * host fence table"). On a multi-user Rust brain, a process that holds a host registration and calls a claim or lease
 * member with no fence is refused `host_fence_required` before the store is touched: the store alone cannot tell such
 * a call from a one-shot command with no host, so a caller that forgot `fenceOpts` would let a stale host write again.
 *
 * Not refused: a call with the fence; a call from a process with no registration (a one-shot command); a call on a
 * claim or handle taken before the registration (its options carry the TAKEN_UNFENCED mark); a client's call the owner
 * runs for it over the owner socket (exempt per call); and everything with the switch off.
 *
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { FenceOpts } from '../src/core/engine-sql/lease-token.ts';
import { FENCED_MEMBERS, HOST_FENCED_MEMBERS, OWN_LEASE_FAMILIES, type FencedFamily } from '../src/core/persistence/fenced-members.ts';
import { bindClaimFence, claimFenceOpts, setHostRegistration } from '../src/core/persistence/host-fence.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { serveOwnerEngine } from '../src/core/rust-engine/owner-ipc/server.ts';
import { connectOwner, installOwnerClient } from '../src/core/rust-engine/owner-ipc/client.ts';
import { registerHostLease } from './helpers/rust-host-fence.ts';
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
const cleanups: Array<() => Promise<unknown> | unknown> = [];

async function open(): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const path = mkdtempSync(join(tmpdir(), 'gbrain-rust-fence-dispatch-'));
  dirs.push(path);
  const engine = openRustEngine({ addon, databasePath: path });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: path });
  return engine;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The error code of `fn`'s rejection, or null when it resolved. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (error) { return String((error as { code?: unknown }).code ?? 'uncoded'); }
}

const HOST = 'd0000000-0000-4000-8000-0000000000f1';
type Call = (engine: BrainEngine, fence: FenceOpts) => Promise<unknown>;

/** One member of each host-fenced family, called with `fence` as its options. */
const CALLS: Record<Exclude<FencedFamily, 'notifier_lease'>, Call> = {
  write_claims: (e, f) => e.renewWriteClaim({ id: randomUUID(), token: randomUUID(), leaseMs: 30_000, phaseJson: null, ...f }),
  job_claims: (e, f) => e.reclaimStalledJobs(0, f),
  effect_claims: (e, f) => e.renewEffectClaim({ id: 1, token: randomUUID(), ...f } as never),
  cycle_lock: (e, f) => e.acquireCycleLock('gbrain-fence-dispatch', { holderPid: 1, holderHost: 'h', acquisitionToken: randomUUID(), ttlMinutes: 5, ...f } as never),
  drain_lease: (e, f) => e.refreshDrainLeaseHolder(randomUUID(), 5, f),
  consumer_rows: (e, f) => e.renewConsumerRow({ hostId: HOST, pid: 4242, nonce: 'n-1', pidNs: null, kind: 'sync', mode: 'full', restartRequired: false,
    rootBarrierAgeMs: null, pool: null, hostJsonPath: '/h/host.json', persistenceHome: '/h', mintedUnder: null, version: 'v-test', purgeMs: 600_000,
    bootId: null, processStart: null, ...f } as never),
  housekeeping_turn: (e, f) => e.claimHousekeepingTurn({ op: 'housekeeping', hostId: HOST, intervalMs: 60_000, leaseMs: 60_000, consumerKinds: ['serve'],
    consumerLiveMs: 30_000, ...f }),
  private_queue_lease: (e, f) => e.renewPrivateQueueLease('dream-private:dispatch', 'tok', 60_000, f),
  segmented_projection: (e, f) => e.claimSegmentedProjection({ sourceId: 'default', slug: 'notes/a' }, 'claim:a', f),
  deferred_replacement: (e, f) => e.releaseDeferredReplacementClaim('notes/a', 'claim:a', f),
  wake_leases: (e, f) => e.claimWakeWatch(1, 60, f),
  page_embedding_lease: (e, f) => e.takePageEmbeddingLease('embed-page:1', { holderPid: 1, holderHost: 'h', acquisitionToken: randomUUID(), ttlMinutes: 10, ...f }),
  notifier_lease_claim: (e, f) => e.claimNotifierLease({ hostId: HOST, ownerId: randomUUID(), kind: 'serve', pid: 1, leaseMs: 30_000, ...f }),
};

/** A multi-user Rust engine (asserted) with a host lease registered on it. */
async function registered() {
  return withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
    const engine = await open();
    expect(engine.openStore('test').multiuser).toBe(true);
    const host = await registerHostLease(engine, 'consumer:h1');
    cleanups.push(() => host.unregister());
    return { engine, e: engine as unknown as BrainEngine, fence: { fence: host.fence } as FenceOpts };
  });
}

describe('the dispatch refuses a registered process that calls a lease member with no fence', () => {
  test('the shared list covers every family but the own-lease ones, and every case below names one', () => {
    const families = Object.keys(FENCED_MEMBERS).filter(f => !OWN_LEASE_FAMILIES.has(f as FencedFamily)).sort();
    expect(Object.keys(CALLS).sort()).toEqual(families);
    expect(HOST_FENCED_MEMBERS.has('writeNotifierState')).toBe(false);
    expect(HOST_FENCED_MEMBERS.size).toBe(Object.values(FENCED_MEMBERS).flat().length - FENCED_MEMBERS.notifier_lease.length);
  });

  for (const [family, call] of Object.entries(CALLS)) {
    withAddon(`${family}: no fence is refused host_fence_required; with the fence the call reaches the store`, async () => {
      const { e, fence } = await registered();
      expect(await codeOf(() => call(e, {}))).toBe('host_fence_required');
      expect(await codeOf(() => call(e, fence))).not.toBe('host_fence_required');
    });
  }

  withAddon('a process with no registration (a one-shot command) is not refused', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const e = await open() as unknown as BrainEngine;
      for (const call of Object.values(CALLS)) expect(await codeOf(() => call(e, {}))).not.toBe('host_fence_required');
    });
  });

  withAddon('with the switch off a registration on the engine changes nothing', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: undefined }, async () => {
      const engine = await open();
      expect(engine.openStore('test').multiuser).toBe(false);
      setHostRegistration(engine, { hostId: 'h', origin: { host_id: 'h', incarnation: 'i', writer_id: 'w' }, fence: { name: 'consumer:h', epoch: 1, token: randomUUID() } });
      for (const call of Object.values(CALLS)) expect(await codeOf(() => call(engine as unknown as BrainEngine, {}))).not.toBe('host_fence_required');
    });
  });
});

describe('claims and handles taken before the registration finish as they were taken', () => {
  withAddon('a cycle lock taken with no host registered is refreshed and released after one registers', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      expect(engine.openStore('test').multiuser).toBe(true);
      const handle = await tryAcquireDbLock(engine as unknown as BrainEngine, 'gbrain-taken-before', 5);
      expect(handle).not.toBeNull();
      const host = await registerHostLease(engine, 'consumer:h1');
      cleanups.push(() => host.unregister());
      expect(await codeOf(() => handle!.refresh())).toBeNull();
      expect(await codeOf(() => handle!.release())).toBeNull();
    });
  });

  withAddon('a write claim stamped with no fence is renewed after a registration appears', async () => {
    const { e } = await registered();
    const token = randomUUID();
    bindClaimFence(token, null);
    expect(await codeOf(() => e.renewWriteClaim({ id: randomUUID(), token, leaseMs: 30_000, phaseJson: null, ...claimFenceOpts(e, token) }))).not.toBe('host_fence_required');
  });
});

describe('a client call the owner runs for it is exempt', () => {
  withAddon('a client of a registered owner renews a private queue lease with no fence; the owner itself is refused', async () => {
    const { engine, e } = await registered();
    const sock = join(dirs[dirs.length - 1]!, 'owner.sock');
    const server = (await serveOwnerEngine(e, sock))!;
    cleanups.push(() => server.close());
    const client = { kind: 'rust', capabilities: new Set<string>() } as unknown as BrainEngine;
    const undo = installOwnerClient(client, await connectOwner(server.socketPath));
    cleanups.push(undo);
    expect(await codeOf(() => client.renewPrivateQueueLease('dream-private:dispatch', 'tok', 60_000))).toBeNull();
    expect(await codeOf(() => engine.renewPrivateQueueLease('dream-private:dispatch', 'tok', 60_000))).toBe('host_fence_required');
  });
});
