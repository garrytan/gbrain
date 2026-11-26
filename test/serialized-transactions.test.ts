/**
 * The `serialized_transactions` capability (docs/designs/rust-engine/multi-user-server.md, audit row A1, groundwork G1):
 * the store promises it when it opens, the Rust engine reports it from that promise (never from the static served set),
 * and an engine or store without it refuses a lock skip with `engine_capability_missing` instead of racing.
 *
 * Here: the capability's lifecycle (open, reopen, owner takeover, the owner hello, transaction clones, a false or absent
 * promise) and refusals end to end through the real store, the napi error converter and the owner socket. Each site's
 * own refusal case is in test/serialized-transactions-ts-sites.test.ts (TypeScript) and
 * rust/crates/gbrain-store/tests/serialized_transactions.rs (Rust); test/serialized-transactions-guard.test.ts counts them.
 *
 * The addon tests need the file `bun run rust:build` writes (rust/target/addon) and skip without it;
 * GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error. A store that withholds the capability is opened
 * through the test seam `withholdSerializedTransactions` (the store's `OpenOptions::withhold_serialized_transactions`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { STORE_GUARANTEES, servedCapabilities } from '../src/core/rust-engine/store-capabilities.ts';
import { assertSerializedTransactions } from '../src/core/rust-engine/errors.ts';
import { provenUnderMultiuser } from '../src/core/rust-engine/lock-skip-guarantees.ts';
import { assertStoreSerializedTransactions } from '../src/core/rust-engine/store-members/common.ts';
import { mapStoreError } from '../src/core/rust-engine/store-errors.ts';
import { storePromisesSerializedTransactions } from '../src/core/rust-engine/store.ts';
import { readManagedMode } from '../src/core/persistence/managed-mode.ts';
import { ownerSocketPath } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { capabilitiesForEngineKind, type Capability } from '../src/core/engine-capabilities.ts';
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

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-serialized-'));
  dirs.push(dir);
  return dir;
}

async function open(dir = newDir(), opts: { withhold?: boolean } = {}): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const engine = openRustEngine({ addon, databasePath: dir, withholdSerializedTransactions: opts.withhold === true });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: dir } as never);
  return engine;
}

type Brain = { serializedTransactions: boolean | null; getConfig(key: string): Promise<string | null> };
const brainOf = async (engine: RustEngine): Promise<Brain> =>
  (await (engine as unknown as { storeFor(m: string): Promise<{ brain: Brain }> }).storeFor('getConfig')).brain;

afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.disconnect().catch(() => undefined);
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

async function rejection(fn: () => Promise<unknown>): Promise<OperationError | undefined> {
  try {
    await fn();
  } catch (error) {
    return error as OperationError;
  }
  return undefined;
}

/** The capability refusal a lock skip gives, naming `site`. */
function expectRefusal(err: OperationError | undefined, site: string): void {
  expect(err?.code).toBe('engine_capability_missing');
  expect(err?.reason).toBe('serialized_transactions');
  expect(String(err?.message)).toContain(site);
}

describe('serialized_transactions: where the capability comes from', () => {
  test('the static served set never holds it: it comes from the open store', () => {
    expect(STORE_GUARANTEES).toEqual(['serialized_transactions']);
    expect(servedCapabilities().has('serialized_transactions')).toBe(false);
  });

  test('neither SQL engine reports it', () => {
    expect(capabilitiesForEngineKind('pglite').has('serialized_transactions')).toBe(false);
    expect(capabilitiesForEngineKind('postgres').has('serialized_transactions')).toBe(false);
  });

  test('only an open result that says serialized_transactions: true promises it', () => {
    expect(storePromisesSerializedTransactions({ brain_id: 'b', serialized_transactions: true })).toBe(true);
    for (const opened of [{ serialized_transactions: false }, {}, { serialized_transactions: 'true' }, { serialized_transactions: 1 },
      null, undefined, 'serialized_transactions']) {
      expect(storePromisesSerializedTransactions(opened)).toBe(false);
    }
  });

  test('assertSerializedTransactions passes with the capability and fails closed without it or without a set', () => {
    expect(refusal(() => assertSerializedTransactions({ capabilities: new Set<Capability>(['serialized_transactions']) }, 'site'))).toBeUndefined();
    for (const target of [{ capabilities: new Set<Capability>(['transactions']) }, {}]) {
      const err = refusal(() => assertSerializedTransactions(target, 'site'));
      expectRefusal(err, 'site');
      expect(String((err as { detail?: unknown }).detail)).toContain('member=site');
    }
  });

  test('assertStoreSerializedTransactions passes true, refuses a closed handle (null) engine_closed, and anything else', () => {
    expect(refusal(() => assertStoreSerializedTransactions({ serializedTransactions: true }, 'lockX'))).toBeUndefined();
    expect(refusal(() => assertStoreSerializedTransactions({ serializedTransactions: null }, 'lockX'))?.code).toBe('engine_closed');
    for (const serializedTransactions of [false, undefined] as const) {
      expectRefusal(refusal(() => assertStoreSerializedTransactions({ serializedTransactions } as never, 'lockX')), 'lockX');
    }
  });

  test("the store's refusal maps to engine_capability_missing naming the member and the site", () => {
    const stored = Object.assign(new Error('serialized_transactions: lockPageKeys skips a lock that only explicit transactions holding the store\'s writer make safe, and this store does not serialize explicit transactions'), { code: 'engine_capability_missing' });
    const mapped = mapStoreError(stored, { member: 'lockPageKeys' }) as OperationError;
    expectRefusal(mapped, 'lockPageKeys (lockPageKeys)');
  });
});

describe('serialized_transactions in multi-user mode (optimistic explicit transactions, I-8)', () => {
  /** An engine opened with the brain's multi-user config row set (I-0), so the process environment is left alone. */
  async function openMultiuser(): Promise<RustEngine> {
    const dir = newDir();
    const first = await open(dir);
    await first.setConfig('engine.rust.multiuser', 'true');
    await first.disconnect();
    return open(dir);
  }

  withAddon('the store answers false and the engine withholds the capability, reporting multi_writer instead', async () => {
    const engine = await openMultiuser();
    expect((engine as unknown as { multiuser: boolean }).multiuser).toBe(true);
    expect(engine.capabilities.has('serialized_transactions')).toBe(false);
    expect(engine.capabilities.has('multi_writer' as never)).toBe(true);
    expect((await brainOf(engine)).serializedTransactions).toBe(false);
  });

  withAddon('every marked skip is proven, so a multi-user brain runs them; a site with no proof would refuse there', async () => {
    const engine = await openMultiuser();
    const site = 'retireManagedSyncPassSlugMode';
    expect(provenUnderMultiuser(site)).toBe(true);
    const target = { cursorKey: 'k', sourceId: 's', incarnation: null, runId: null, requestId: null } as never;
    const retire = (e: RustEngine) => (e as unknown as { retireManagedSyncPassSlugMode(t: never, l: string): Promise<unknown> }).retireManagedSyncPassSlugMode(target, 'l');
    expect(await retire(engine)).toBe(false);
    // A site absent from the proof table refuses on a multi-user store, as every skip did before its proof.
    expect(provenUnderMultiuser('unprovenSite')).toBe(false);
    expectRefusal(refusal(() => assertStoreSerializedTransactions({ serializedTransactions: false, multiuser: true } as never, 'unprovenSite')), 'unprovenSite');
    expect(refusal(() => assertStoreSerializedTransactions({ serializedTransactions: false, multiuser: true } as never, site))).toBeUndefined();
  });
});

describe('serialized_transactions: the lifecycle on a real store', () => {
  withAddon('a normal open reports it, the store agrees, and a transaction clone carries it', async () => {
    const engine = await open();
    expect(engine.capabilities.has('serialized_transactions')).toBe(true);
    expect((await brainOf(engine)).serializedTransactions).toBe(true);
    await engine.transaction(async tx => { expect(tx.capabilities.has('serialized_transactions')).toBe(true); });
  });

  withAddon('a store that withholds it: the engine withholds it too, and so does a transaction clone', async () => {
    const engine = await open(newDir(), { withhold: true });
    expect(engine.capabilities.has('serialized_transactions')).toBe(false);
    expect((await brainOf(engine)).serializedTransactions).toBe(false);
    // Everything else the engine reports is unchanged.
    // The write journal needs serialized transactions (declarePersistence asserts it), so it is withheld too.
    for (const c of ['persistence_journal', 'managed_persistence'] as const) expect(engine.capabilities.has(c)).toBe(false);
    const rest = [...servedCapabilities()].filter(c => c !== 'persistence_journal' && c !== 'managed_persistence');
    expect([...engine.capabilities].sort()).toEqual(rest.sort());
    await engine.transaction(async tx => { expect(tx.capabilities.has('serialized_transactions')).toBe(false); });
  });

  withAddon('a normal open reports the write journal it serves alongside it', async () => {
    const engine = await open();
    expect(engine.capabilities.has('persistence_journal')).toBe(servedCapabilities().has('persistence_journal'));
  });

  withAddon('a connect that fails after the store opened leaves the capability withheld', async () => {
    const dir = newDir();
    mkdirSync(dir, { recursive: true });
    // A regular file where the owner socket goes: the store opens, then the owner server cannot listen.
    writeFileSync(ownerSocketPath(dir), 'not a socket');
    addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
    const engine = openRustEngine({ addon, databasePath: dir, ownerWaitMs: 2_000 });
    engines.push(engine);
    expect(await rejection(() => engine.connect({ engine: 'pglite', database_path: dir } as never))).toBeDefined();
    expect(engine.connected).toBe(false);
    expect(engine.capabilities.has('serialized_transactions')).toBe(false);
  });

  withAddon('disconnect withholds it, and a reopen reports it again from the new store', async () => {
    const dir = newDir();
    const engine = await open(dir);
    const brain = await brainOf(engine);
    await engine.disconnect();
    expect(engine.capabilities.has('serialized_transactions')).toBe(false);
    expect(brain.serializedTransactions).toBe(null);
    await engine.connect({ engine: 'pglite', database_path: dir } as never);
    expect(engine.capabilities.has('serialized_transactions')).toBe(true);
  });

  withAddon("a client takes its owner's answer from the hello, and a takeover replaces it with its own store's", async () => {
    const dir = newDir();
    const owner = await open(dir, { withhold: true });
    const client = await open(dir);
    expect(client.ownerRole).toBe('client');
    expect(client.capabilities.has('serialized_transactions')).toBe(false);
    await owner.disconnect();
    // The next call finds the owner gone and elects this engine, which opens its own (serializing) store.
    expect(await client.getConfig('probe')).toBe(null);
    expect(client.ownerRole).toBe('owner');
    expect(client.capabilities.has('serialized_transactions')).toBe(true);
  });

  withAddon('a serializing owner hands the capability to its client', async () => {
    const dir = newDir();
    await open(dir);
    const client = await open(dir, { withhold: true });
    expect(client.ownerRole).toBe('client');
    expect(client.capabilities.has('serialized_transactions')).toBe(true);
  });
});

describe('serialized_transactions: refusals end to end, nothing written', () => {
  withAddon('a Rust-side skip refuses through the store and the napi error converter, and writes nothing', async () => {
    const engine = await open(newDir(), { withhold: true });
    await engine.setConfig('probe', 'before');
    const err = await rejection(() => engine.transaction(async tx => {
      await tx.setConfig('probe', 'inside');
      await tx.lockPageKeys([{ sourceId: 'default', slug: 'notes/a' }]);
    }));
    expectRefusal(err, 'lockPageKeys');
    expect(await engine.getConfig('probe')).toBe('before');
  });

  withAddon('a TypeScript-only no-op skip refuses before any store call; with the capability it is still a no-op', async () => {
    const withheld = await open(newDir(), { withhold: true });
    expectRefusal(await rejection(() => withheld.lockMentionSources(['default'], false)), 'lockMentionSources');
    const normal = await open();
    expect(await normal.lockMentionSources(['default'], false)).toBeUndefined();
  });

  withAddon('an engine-level skip refuses on a Rust engine without the capability', async () => {
    const engine = await open(newDir(), { withhold: true });
    expectRefusal(await rejection(() => readManagedMode(engine as never, { lock: 'update' })), 'readManagedMode');
    // Without a lock the read is not a skip and answers as before.
    expect(await readManagedMode(engine as never)).toBe(false);
  });

  withAddon('a lock check made before a takeover is made again on the store that ran the read', async () => {
    const dir = newDir();
    const owner = await open(dir);
    const client = await open(dir, { withhold: true });
    expect(client.capabilities.has('serialized_transactions')).toBe(true);
    await owner.disconnect();
    // The read elects this engine, whose own store withholds the capability: the lock request refuses after the read.
    expectRefusal(await rejection(() => readManagedMode(client as never, { lock: 'update' })), 'readManagedMode');
    expect(client.ownerRole).toBe('owner');
  });

  withAddon('a derived-link replacement with wanted rows refuses before it publishes anything', async () => {
    const engine = await open(newDir(), { withhold: true });
    await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'Body.', timeline: '' } as never);
    await engine.putPage('notes/b', { type: 'note', title: 'B', compiled_truth: 'Body.', timeline: '' } as never);
    const snap = (await engine.readPageSnapshot('notes/a', { sourceId: 'default' }))!;
    const before = await engine.getLinks('notes/a');
    const err = await rejection(() => engine.replaceDerivedLinks(
      { slug: 'notes/a', sourceId: 'default', expectedRevision: snap.revision, sourceIncarnation: snap.sourceIncarnation },
      [{ from_slug: 'notes/a', to_slug: 'notes/b', link_type: 'mentions', context: 'b', link_source: 'markdown', from_source_id: 'default', to_source_id: 'default' }] as never,
      { wanted: { producers: ['markdown'], rows: [], readAt: null } } as never));
    expectRefusal(err, 'replaceDerivedLinks.wanted');
    expect(await engine.getLinks('notes/a')).toEqual(before);
  });

  withAddon('a refusal crosses the owner socket with its code and reason', async () => {
    const dir = newDir();
    const owner = await open(dir, { withhold: true });
    await owner.setConfig('probe', 'before');
    const client = await open(dir);
    expect(client.ownerRole).toBe('client');
    expectRefusal(await rejection(() => client.readOauthClientForUpdate('client-a')), 'readOauthClientForUpdate');
    expect(await client.getConfig('probe')).toBe('before');
  });
});
