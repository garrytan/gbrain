/**
 * A lease-fenced cycle-lock writer a TS test can drive (lane L5; test/helpers/rust-host-fence.ts): take a host lease,
 * write a cycle-lock row under its fence, take the lease over and see the old holder refused (`lease_lost` /
 * `epoch_moved`) with the row unchanged. With the switch off the same calls carry no fence and write no lease record.
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
import { rustLeases } from '../src/core/rust-engine/store-members/leases.ts';
import { tryAcquireDbLock } from '../src/core/db-lock.ts';
import { fenceFor } from '../src/core/persistence/host-fence.ts';
import { startConsumerHeartbeat } from '../src/core/persistence/consumer-heartbeat.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { lockCycleUnderFence, registerHostLease } from './helpers/rust-host-fence.ts';
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

async function refusal(fn: () => Promise<unknown>): Promise<{ code?: string; reason?: string }> {
  try { await fn(); } catch (error) { return { code: (error as { code?: string }).code, reason: (error as { reason?: string }).reason }; }
  return {};
}

/** A lock row without its read-time field (`db_now` is the clock at the read). */
function rowsWithoutReadTime(rows: ReadonlyArray<object>) {
  return rows.map(row => { const { db_now: _readTime, ...rest } = row as Record<string, unknown>; return rest; });
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LOCK = 'gbrain-sync:default';

describe('a lease-fenced cycle-lock writer for tests', () => {
  withAddon('a cycle-lock row written under a host lease; after a takeover the old holder cannot refresh it', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      expect(engine.openStore('test').multiuser).toBe(true);
      const host = await registerHostLease(engine, 'consumer:h1');
      expect(fenceFor(engine)).toEqual(host.fence);
      const lock = await lockCycleUnderFence(engine as unknown as BrainEngine, LOCK);
      const rows = () => engine.readCycleLocks({ by: 'id', lockId: LOCK });
      expect(await rows()).toHaveLength(1);
      expect(await lock.refresh()).toBe(true);
      const successor = await host.takeOver();
      expect(successor.epoch).toBe(host.fence.epoch + 1);
      const before = rowsWithoutReadTime(await rows());
      expect(await refusal(() => lock.refresh())).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(rowsWithoutReadTime(await rows())).toEqual(before);
      host.unregister();
    });
  });

  withAddon('with the switch off the same calls write the lock and no lease record, as before', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: undefined }, async () => {
      const engine = await open();
      expect(engine.openStore('test').multiuser).toBe(false);
      expect(fenceFor(engine)).toBeNull();
      const lock = await tryAcquireDbLock(engine as unknown as BrainEngine, LOCK, 30);
      expect(lock).not.toBeNull();
      expect(await lock!.refresh()).toBe(true);
      await lock!.release();
      expect(await rustLeases(engine).read('consumer:h1')).toBeNull();
    });
  });
});

describe('the consumer heartbeat row carries the host fence (I-5, host fence table)', () => {
  const report = () => ({ restart_required: false, root_barrier_age_ms: null });
  const paths = { host_json_path: '/h/host.json', persistence_home: '/h', minted_under: null };
  const identity = { pid: 4242, nonce: 'n-1', pid_ns: null };

  withAddon('after a takeover of the host lease, the old holder heartbeat is refused lease_lost and its row is not renewed', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const engine = await open();
      expect(engine.openStore('test').multiuser).toBe(true);
      const host = await registerHostLease(engine, 'consumer:h1');
      const errors: unknown[] = [];
      const beat = startConsumerHeartbeat(engine as unknown as BrainEngine, 'h1', { kind: 'sync', mode: 'full', report, paths, identity, everyMs: 3_600_000, onError: e => errors.push(e) });
      await beat.renew();
      expect(errors).toEqual([]);
      const first = await engine.listHostConsumerRows('h1');
      expect(first).toHaveLength(1);
      await Bun.sleep(5);
      await host.takeOver();
      await beat.renew();
      expect(errors.map(e => (e as { code?: string }).code)).toEqual(['lease_lost']);
      expect((await engine.listHostConsumerRows('h1'))[0].renewed_at).toBe(first[0].renewed_at);
      host.unregister();
      await beat.stop();
    });
  });
});
