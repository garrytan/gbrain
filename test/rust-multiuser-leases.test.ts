/**
 * The multi-user switch (I-0) and leases with epochs (I-5) on a real Rust brain (rust/crates/gbrain-store/src/leases.rs,
 * src/core/rust-engine/store-members/leases.ts).
 *
 * - Off (no GBRAIN_RUST_MULTIUSER, no config row): the store is not in multi-user mode.
 * - The environment switch and the brain's own config row each turn it on, per brain.
 * - A takeover raises the epoch, and the old holder's renew and assert fail `lease_lost` with the reason, through napi
 *   and the TypeScript error mapping; inside a transaction the assert is one of its statements.
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
import { rustLeases, type WriteOrigin } from '../src/core/rust-engine/store-members/leases.ts';
import { rustMultiuserConfigOn, rustMultiuserFromEnv, rustMultiuserSubSwitch, RUST_MULTIUSER_CONFIG_KEY } from '../src/core/rust-engine/multiuser-switch.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

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

async function open(dir?: string): Promise<{ engine: RustEngine; dir: string }> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const path = dir ?? mkdtempSync(join(tmpdir(), 'gbrain-rust-mu-'));
  if (!dir) dirs.push(path);
  const engine = openRustEngine({ addon, databasePath: path });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: path } as never);
  return { engine, dir: path };
}

async function close(engine: RustEngine): Promise<void> {
  await engine.disconnect();
  engines.splice(engines.indexOf(engine), 1);
}

function multiuser(engine: RustEngine): boolean {
  return engine.openStore('test').multiuser;
}

const holder = (host: string): WriteOrigin => ({ host_id: `${host}-host`, incarnation: `${host}-incarnation`, writer_id: 'local_cli:test' });

async function lost(fn: () => Promise<unknown>): Promise<{ code?: string; reason?: string }> {
  try {
    await fn();
  } catch (error) {
    return { code: (error as OperationError).code, reason: (error as OperationError).reason };
  }
  return {};
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the multi-user switch (I-0)', () => {
  test('reads exactly 1 from the environment and true or 1 from config', () => {
    expect(rustMultiuserFromEnv({})).toBe(false);
    expect(rustMultiuserFromEnv({ GBRAIN_RUST_MULTIUSER: 'true' })).toBe(false);
    expect(rustMultiuserFromEnv({ GBRAIN_RUST_MULTIUSER: '1' })).toBe(true);
    expect([rustMultiuserConfigOn('true'), rustMultiuserConfigOn('1'), rustMultiuserConfigOn('yes'), rustMultiuserConfigOn(null)]).toEqual([true, true, false, false]);
  });

  withAddon('off by default; the environment and the brain config row each turn it on, per brain', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: undefined }, async () => {
      const off = await open();
      expect(multiuser(off.engine)).toBe(false);
      await off.engine.setConfig(RUST_MULTIUSER_CONFIG_KEY, 'true');
      await close(off.engine);
      const configured = await open(off.dir);
      expect(multiuser(configured.engine)).toBe(true);
      const other = await open();
      expect(multiuser(other.engine)).toBe(false);
    });
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const switched = await open();
      expect(multiuser(switched.engine)).toBe(true);
    });
  });
});

describe('leases with epochs (I-5)', () => {
  withAddon('a takeover raises the epoch and the old holder fails lease_lost with its reason', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: '1' }, async () => {
      const { engine } = await open();
      const leases = rustLeases(engine);
      const a = await leases.acquire('consumer:h1', holder('a'), 60_000);
      expect(a?.epoch).toBe(1);
      expect(a?.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(await leases.acquire('consumer:h1', holder('b'), 60_000)).toBeNull();
      await leases.renew(a!, 60_000);
      await leases.assert(a!);
      await leases.release(a!);
      expect(await lost(() => leases.assert(a!))).toEqual({ code: 'lease_lost', reason: 'released' });
      const b = await leases.acquire('consumer:h1', holder('b'), 60_000);
      expect(b?.epoch).toBe(2);
      expect(await lost(() => leases.renew(a!, 60_000))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      const state = await leases.read('consumer:h1');
      expect({ epoch: state?.epoch, live: state?.live, host: state?.holder.host_id }).toEqual({ epoch: 2, live: true, host: 'b-host' });
      expect('token' in (state ?? {})).toBe(false);
      // Inside a transaction the assert is a statement of it.
      await engine.transaction(async (tx) => {
        await rustLeases(tx as unknown as RustEngine).assert(b!);
        expect(await lost(() => rustLeases(tx as unknown as RustEngine).assert(a!))).toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      });
    });
  });
});

describe('sub-switches follow the store (I-0.v2)', () => {
  test('a sub-switch reads on when the brain is on through its config row alone, and off when the brain is off', () => {
    const env = { GBRAIN_RUST_COMMIT_LOG: '1' };
    expect(rustMultiuserSubSwitch('GBRAIN_RUST_COMMIT_LOG', { multiuser: true }, env)).toBe(true);
    expect(rustMultiuserSubSwitch('GBRAIN_RUST_COMMIT_LOG', { multiuser: false }, env)).toBe(false);
    expect(rustMultiuserSubSwitch('GBRAIN_RUST_COMMIT_LOG', { multiuser: true }, {})).toBe(false);
  });

  withAddon('a brain on only through its config row gets its sub-switches', async () => {
    await withEnv({ GBRAIN_RUST_MULTIUSER: undefined, GBRAIN_RUST_COMMIT_LOG: '1' }, async () => {
      const off = await open();
      await off.engine.setConfig(RUST_MULTIUSER_CONFIG_KEY, 'true');
      await close(off.engine);
      const configured = await open(off.dir);
      expect(rustMultiuserSubSwitch('GBRAIN_RUST_COMMIT_LOG', configured.engine.openStore('test'))).toBe(true);
      const plain = await open();
      expect(rustMultiuserSubSwitch('GBRAIN_RUST_COMMIT_LOG', plain.engine.openStore('test'))).toBe(false);
    });
  });
});
