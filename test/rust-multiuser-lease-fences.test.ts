/**
 * The lease-fence follow-up (lane L5; docs/designs/rust-engine/multi-user-server.md, "I-5, host fence table"): the
 * lease families that kept only their own token and TTL now carry the host fence through their TypeScript callers.
 * Each test takes a host lease, registers it on the engine (test/helpers/rust-host-fence.ts), starts the caller's
 * lease, takes the host lease over, and sees the old holder's next lease write refused `lease_lost` with the brain
 * unchanged. Multi-user mode is on through the environment switch and asserted in every test.
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
import type { BrainEngine } from '../src/core/engine.ts';
import { acquirePageEmbeddingLease } from '../src/core/page-embedding-lease.ts';
import { DREAM_INLINE_PRIVATE_QUEUE_PREFIX, MinionQueue } from '../src/core/minions/queue.ts';
import { drainWakes } from '../src/core/wakeshift/drain.ts';
import { startCommitNotifier, type NotifierStore } from '../src/core/commit-notifier.ts';
import { memoryNotifierStore } from './helpers/notifier-memory-store.ts';
import { buildSegmentedProjection } from '../src/core/page-body/projection.ts';
import { continueDeferredProjectionStep, DEFERRED_CHUNK_CLAIM } from '../src/core/page-state/projections.ts';
import { basisEmbedding } from './engine-parity/harness.ts';
import { chunk } from './engine-parity/chunk-fixtures.ts';
import { claimHousekeepingTurn, completeHousekeepingTurn } from '../src/core/persistence/housekeeping-turn.ts';
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

async function open(): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const path = mkdtempSync(join(tmpdir(), 'gbrain-rust-lease-fences-'));
  dirs.push(path);
  const engine = openRustEngine({ addon, databasePath: path });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: path });
  return engine;
}

async function refusal(fn: () => Promise<unknown>): Promise<{ code?: string; reason?: string }> {
  try { await fn(); } catch (error) { return { code: (error as { code?: string }).code, reason: (error as { reason?: string }).reason }; }
  return {};
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs `fn` on a fresh brain with multi-user mode on (asserted) and a host lease registered on the engine. */
async function onStaleableHost(fn: (engine: RustEngine, takeOver: () => Promise<unknown>) => Promise<void>): Promise<void> {
  await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
    const engine = await open();
    expect(engine.openStore('test').multiuser).toBe(true);
    const host = await registerHostLease(engine, 'consumer:h1');
    try { await fn(engine, () => host.takeOver()); } finally { host.unregister(); }
  });
}

describe('lease families carry the host fence (I-5, host fence table)', () => {
  withAddon('family 7, the page embedding lease: after a takeover the old holder cannot renew it, and the row stays', async () => {
    await onStaleableHost(async (engine, takeOver) => {
      const lease = await acquirePageEmbeddingLease(engine as unknown as BrainEngine, 7);
      expect(lease.busy).toBe(false);
      const rows = async () => (await engine.readCycleLocks({ by: 'all' })).map(r => { const { db_now: _t, ...rest } = r as Record<string, unknown>; return rest; });
      await takeOver();
      const before = await rows();
      expect(await refusal(() => lease.busy ? Promise.resolve() : lease.assertHeld(engine as unknown as BrainEngine))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      await lease[Symbol.asyncDispose]();
      expect(await rows()).toEqual(before);
    });
  });
});

describe('family 2, the housekeeping turn', () => {
  withAddon('after a takeover the old holder cannot complete its turn or claim the next one', async () => {
    await onStaleableHost(async (engine, takeOver) => {
      const e = engine as unknown as BrainEngine;
      const hostId = 'd0000000-0000-4000-8000-0000000000d1';
      expect(await claimHousekeepingTurn(e, hostId, 60_000)).toBe(true);
      await takeOver();
      expect(await refusal(() => completeHousekeepingTurn(e, hostId))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await refusal(() => claimHousekeepingTurn(e, hostId, 0))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
    });
  });
});

describe('family 3, the private queue owner lease', () => {
  withAddon('after a takeover the old holder cannot renew its private queue lease', async () => {
    await onStaleableHost(async (engine, takeOver) => {
      const queue = new MinionQueue(engine as unknown as BrainEngine);
      const name = `${DREAM_INLINE_PRIVATE_QUEUE_PREFIX}lf3`;
      expect(await queue.renewPrivateQueueLease(name, 'tok')).toBe(0);
      await takeOver();
      expect(await refusal(() => queue.renewPrivateQueueLease(name, 'tok'))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
    });
  });
});

describe('family 6, the wake watch and wake forget leases', () => {
  const runtime = { key: {}, url: 'https://wakeshift.invalid', file: {}, api: { emit: async () => ({ matched: 1 }), end: async () => true } } as never;
  const watch = { event: 'gbrain.job.finished', target: '1', targetRef: null, principalKind: 'local_stdio' as const, principalId: 'me', memberId: null,
    wakeUser: '0'.repeat(31) + '1', wsSubscriptionId: 'ws-1', expiresAt: '2099-01-01T00:00:00.000Z' };

  withAddon('after a takeover the old holder cannot lease a due watch: the drain is refused and the watch stays unleased', async () => {
    await onStaleableHost(async (engine, takeOver) => {
      const e = engine as unknown as BrainEngine;
      const id = await engine.openWakeWatch(watch);
      await takeOver();
      expect(await refusal(() => drainWakes(e, { ids: [id], runtime }))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect((await engine.listDueWakeWatches({ ids: [id] })).map(r => r.id)).toEqual([id]);
    });
  });

  withAddon('after a takeover the old holder cannot lease a queued forget: the drain is refused', async () => {
    await onStaleableHost(async (engine, takeOver) => {
      const e = engine as unknown as BrainEngine;
      await engine.queueWakeForget('0'.repeat(31) + '2', null);
      await takeOver();
      expect(await refusal(() => drainWakes(e, { runtime }))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
    });
  });
});

describe('family 4, the segmented projection claim', () => {
  withAddon('after a takeover the old holder cannot claim a page to project: the build is refused before it starts', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      expect(engine.openStore('test').multiuser).toBe(true);
      // The projector reads a page that still needs its projection, then claims its queue row under the host fence.
      const projector = new Proxy(engine as unknown as BrainEngine, {
        get(target, prop, receiver) {
          if (prop === 'readSegmentedProjectionPage') {
            return async () => ({ id: 1, body_generation: 1, knowledge_revision: 'r2', text_projection_revision: 'r1' });
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const host = await registerHostLease(projector, 'consumer:h1');
      try {
        await host.takeOver();
        expect(await refusal(() => buildSegmentedProjection(projector, { sourceId: 'default', slug: 'notes/a' })))
          .toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      } finally { host.unregister(); }
    });
  });
});

describe('family 5, the deferred replacement claim', () => {
  const PAGE = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '' });

  withAddon('after a takeover the old holder cannot renew its continuation claim, and the claim stays as it was', async () => {
    await onStaleableHost(async (engine, takeOver) => {
      const e = engine as unknown as BrainEngine;
      await e.putPage('notes/moving', PAGE('Moving', 'a moving passage about ibex.'));
      await e.upsertChunks('notes/moving', [chunk(0, 'an old passage.'), chunk(1, 'a moving passage about ibex.', { embedding: basisEmbedding(4) })]);
      const state: { token?: string } = {};
      expect(await continueDeferredProjectionStep(e, 'default', 'notes/moving', state, 0)).toBe('more');
      const [job] = (await e.listQueuedPageProjections({ limit: 10 })).filter(j => j.slug === 'notes/moving');
      const key = { sourceIncarnation: job!.source_incarnation, slug: 'notes/moving', revision: job!.revision };
      const claimed = await e.readProjectionJobReason(key);
      expect(claimed).toBe(`${DEFERRED_CHUNK_CLAIM}:${state.token}`);
      await takeOver();
      expect(await refusal(() => continueDeferredProjectionStep(e, 'default', 'notes/moving', state, 0)))
        .toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await e.readProjectionJobReason(key)).toBe(claimed);
    });
  });
});

describe('family 1, the commit notifier lease', () => {
  const HOST = '00000000-0000-4000-8000-0000000025a6';
  const A = 'a'.repeat(40), B = 'b'.repeat(40);

  /** A notifier on `store` with one managed source whose HEAD moved; returns the state and coverage writes it sent. */
  async function notifierWrites(store: NotifierStore, t: { now: number }) {
    const sent: Array<{ kind: string; lease?: unknown }> = [];
    const recording: NotifierStore = {
      ...store,
      writeState: async (id, patch) => { sent.push({ kind: 'state', lease: patch.lease }); return store.writeState(id, patch); },
      writeCoverage: async (id, c) => { sent.push({ kind: 'coverage', lease: c.lease }); return store.writeCoverage(id, c); },
    };
    const n = startCommitNotifier({
      resident: 'serve', log: () => {}, hostId: HOST, store: recording, now: () => t.now, pollMs: 3000, quietMs: 400, heartbeatMs: 10_000,
      firstSliceSeconds: 30, sliceSeconds: 120, maxConcurrent: 1,
      setInterval: () => 'interval', clearInterval: () => {}, setTimeout: () => 'timer', clearTimeout: () => {},
      readFlag: async () => true,
      listSources: async () => [{ sourceId: 'source-a', root: '/nonexistent/source-a', gitDir: null, lastCommit: A, kind: 'managed' }],
      lastCommit: async () => A, revParse: async () => B, syncRunning: () => false, drainHeld: async () => false,
      startSync: async () => ({ jobId: 'job-1' }), jobStatus: () => ({ state: 'running' }),
    });
    await n.tick();
    t.now += 400; await n.tick();
    await n.stop();
    return sent;
  }

  test('a notifier that holds the host lease sends it with every state and coverage write', async () => {
    const t = { now: 1_000_000 };
    const store = memoryNotifierStore({ lastCommit: () => A, leases: { rows: new Map(), now: () => t.now } });
    const sent = await notifierWrites(store, t);
    expect(sent.length).toBeGreaterThan(0);
    for (const write of sent) expect(write.lease).toMatchObject({ hostId: HOST, fence: 1 });
  });

  test('with no lease (the PGLite shape) the writes carry none, as before', async () => {
    const t = { now: 1_000_000 };
    const sent = await notifierWrites(memoryNotifierStore({ lastCommit: () => A }), t);
    expect(sent.length).toBeGreaterThan(0);
    for (const write of sent) expect(write.lease).toBeUndefined();
  });

  withAddon('on a multi-user Rust brain a state write under a lost notifier lease is refused lease_lost', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      expect(engine.openStore('test').multiuser).toBe(true);
      const ownerA = 'e0000000-0000-4000-8000-0000000000a1', ownerB = 'e0000000-0000-4000-8000-0000000000b1';
      const a = await engine.claimNotifierLease({ hostId: HOST, ownerId: ownerA, kind: 'serve', pid: 1, leaseMs: 30 });
      expect(a).toMatchObject({ owner: true, fence: 1 });
      await Bun.sleep(60);
      expect(await engine.claimNotifierLease({ hostId: HOST, ownerId: ownerB, kind: 'serve', pid: 2, leaseMs: 60_000 })).toMatchObject({ owner: true, fence: 2 });
      const refused = await refusal(() => engine.writeNotifierState('default', { state: 'running', firstDue: 'keep', lease: { hostId: HOST, ownerId: ownerA, fence: 1 } }));
      expect(refused.code).toBe('lease_lost');
      await engine.writeNotifierState('default', { state: 'running', firstDue: 'keep', lease: { hostId: HOST, ownerId: ownerB, fence: 2 } });
    });
  });
});
