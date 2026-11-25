/**
 * The `serialized_transactions` capability (docs/designs/rust-engine/multi-user-server.md, audit row A1, groundwork G1):
 * the Rust engine reports it, the store answers the same, and an engine or store without it refuses a lock skip with
 * `engine_capability_missing` instead of racing. Each site's own refusal case is in
 * test/serialized-transactions-ts-sites.test.ts (TypeScript) and rust/crates/gbrain-store/tests/serialized_transactions.rs
 * (Rust); test/serialized-transactions-guard.test.ts counts the sites.
 *
 * The addon tests need the file `bun run rust:build` writes (rust/target/addon) and skip without it;
 * GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { STORE_GUARANTEES, servedCapabilities } from '../src/core/rust-engine/store-capabilities.ts';
import { assertSerializedTransactions } from '../src/core/rust-engine/errors.ts';
import { assertStoreSerializedTransactions } from '../src/core/rust-engine/store-members/common.ts';
import { mapStoreError } from '../src/core/rust-engine/store-errors.ts';
import type { Capability } from '../src/core/engine-capabilities.ts';
import type { OperationError } from '../src/core/ops/contract.ts';

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
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-serialized-'));
  dirs.push(dir);
  const engine = openRustEngine({ addon, databasePath: dir });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: dir } as never);
  return engine;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function refusal(fn: () => unknown): OperationError | undefined {
  try {
    fn();
  } catch (error) {
    return error as OperationError;
  }
  return undefined;
}

describe('serialized_transactions', () => {
  test('the Rust engine reports it as a store guarantee', () => {
    expect(STORE_GUARANTEES).toEqual(['serialized_transactions']);
    expect(servedCapabilities().has('serialized_transactions')).toBe(true);
  });

  withAddon('the engine and its open store agree: explicit transactions hold the writer today', async () => {
    const engine = await open();
    expect(engine.capabilities.has('serialized_transactions')).toBe(true);
    const { brain } = await (engine as unknown as { storeFor(m: string): Promise<{ brain: { serializedTransactions: boolean | null } }> }).storeFor('getConfig');
    expect(brain.serializedTransactions).toBe(true);
    // A transaction clone carries the engine's set, so a skip inside a transaction asserts the same capability.
    await engine.transaction(async tx => { expect(tx.capabilities.has('serialized_transactions')).toBe(true); });
  });

  withAddon('a closed store answers null, not false', async () => {
    const engine = await open();
    const { brain } = await (engine as unknown as { storeFor(m: string): Promise<{ brain: { serializedTransactions: boolean | null; close(): Promise<void> } }> }).storeFor('getConfig');
    await engine.disconnect();
    expect(brain.serializedTransactions).toBe(null);
  });

  withAddon('a real Rust engine without the capability refuses an engine-level lock skip', async () => {
    const engine = await open();
    (engine.capabilities as Set<Capability>).delete('serialized_transactions');
    const err = refusal(() => assertSerializedTransactions(engine, 'readManagedMode'));
    expect(err?.code).toBe('engine_capability_missing');
    expect(err?.reason).toBe('serialized_transactions');
    expect(err?.message).toContain('readManagedMode');
  });

  test('assertSerializedTransactions passes with the capability and fails closed without it or without a set', () => {
    expect(refusal(() => assertSerializedTransactions({ capabilities: new Set<Capability>(['serialized_transactions']) }, 'site'))).toBeUndefined();
    for (const target of [{ capabilities: new Set<Capability>(['transactions']) }, {}]) {
      const err = refusal(() => assertSerializedTransactions(target, 'site'));
      expect(err?.code).toBe('engine_capability_missing');
      expect(err?.reason).toBe('serialized_transactions');
      expect(String((err as { detail?: unknown }).detail)).toContain('member=site');
    }
  });

  test('assertStoreSerializedTransactions passes true and null and refuses anything else', () => {
    expect(refusal(() => assertStoreSerializedTransactions({ serializedTransactions: true }, 'lockX'))).toBeUndefined();
    expect(refusal(() => assertStoreSerializedTransactions({ serializedTransactions: null }, 'lockX'))).toBeUndefined();
    for (const serializedTransactions of [false, undefined] as const) {
      const err = refusal(() => assertStoreSerializedTransactions({ serializedTransactions } as never, 'lockX'));
      expect(err?.code).toBe('engine_capability_missing');
      expect(err?.reason).toBe('serialized_transactions');
    }
  });

  test("the store's refusal maps to engine_capability_missing naming the member and the site", () => {
    const stored = Object.assign(new Error('serialized_transactions: lockPageKeys skips a lock that only explicit transactions holding the store\'s writer make safe, and this store does not serialize explicit transactions'), { code: 'engine_capability_missing' });
    const mapped = mapStoreError(stored, { member: 'lockPageKeys' }) as OperationError;
    expect(mapped.code).toBe('engine_capability_missing');
    expect(mapped.reason).toBe('serialized_transactions');
    expect(mapped.message).toContain('lockPageKeys (lockPageKeys)');
  });
});
