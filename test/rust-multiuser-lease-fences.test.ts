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
