/**
 * The Rust engine shell (docs/designs/RUST_ENGINE.md, "PR sequence" step 8). `openRustEngine` takes an addon the
 * loader already verified and returns an engine that reports only the capabilities whose every member the store
 * serves, and refuses every other member with `engine_capability_missing` before any work. SQL-only paths refuse a
 * Rust kind instead of treating it as Postgres. These tests pass a plain object, with a fake store, as the verified
 * addon; test/rust-engine-store.test.ts runs the real one.
 */
import { describe, expect, test } from 'bun:test';
import { openRustEngine, RustEngine, rustMemberCapability } from '../src/core/rust-engine.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';
import { servedCapabilities } from '../src/core/rust-engine/store-capabilities.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { isSqlEngineKind, sqlEngineKind } from '../src/core/sql-engine-kind.ts';
import { stageBatchBytes, STAGE_BATCH_BYTES } from '../src/core/page-body/limits.ts';
import { CODES } from '../src/core/error-registry.ts';
import { ENGINE_CAPABILITIES } from '../src/core/engine-capabilities.ts';
import { OperationError } from '../src/core/ops/contract.ts';

/** A store that opens and closes and does nothing else: the lifecycle tests need no real brain. */
class FakeBrain {
  isOpen = false;
  async open() { this.isOpen = true; }
  async close() { this.isOpen = false; }
}
class FakePool { async shutdown() {} }
const addon = { target: 'linux-x64-glibc', engine_abi: 1, Pool: FakePool, Brain: FakeBrain };
/** An addon whose store open waits until the test lets it finish, so a disconnect or a second connect can land mid-open. */
function deferredAddon() {
  const brains: Array<{ isOpen: boolean }> = [];
  let release: (() => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let started: (() => void) | undefined;
  let started_ = new Promise<void>((resolve) => { started = resolve; });
  let immediate = false;
  class GatedBrain {
    isOpen = false;
    constructor() { brains.push(this); }
    async open() {
      started?.();
      if (!immediate) await new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
      this.isOpen = true;
    }
    async close() { this.isOpen = false; }
  }
  return {
    addon: { target: 'linux-x64-glibc', engine_abi: 1, Pool: FakePool, Brain: GatedBrain },
    brains,
    opening: () => started_,
    finishOpen: () => release?.(),
    failOpen: () => fail?.(Object.assign(new Error('store open failed'), { code: 'store_corrupt' })),
    /** From now on an open finishes at once. */
    finishOpenNow: () => { immediate = true; started_ = Promise.resolve(); },
  };
}
const open = () => openRustEngine({ addon, databasePath: '/var/brains/test.rust' });

/** Runs `fn`, expecting an OperationError, and returns it. */
async function refusal(fn: () => unknown): Promise<OperationError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }
  throw new Error('expected a refusal');
}

describe('openRustEngine', () => {
  test('returns a Rust engine that keeps the verified addon and store path and reports what the store serves', () => {
    const engine = open();
    expect(engine).toBeInstanceOf(RustEngine);
    expect(engine.kind).toBe('rust');
    expect([...engine.capabilities].sort()).toEqual([...servedCapabilities()].sort());
    // The capabilities served before the family split stay served; a family that finishes a capability adds to this set
    // without editing this test (docs/designs/RUST_ENGINE_INTERFACES.md).
    expect([...engine.capabilities]).toEqual(expect.arrayContaining(['config', 'schema', 'sources', 'tags']));
    expect(engine.addon).toBe(addon);
    expect(engine.databasePath).toBe('/var/brains/test.rust');
  });

  test('every member the store does not serve refuses engine_capability_missing naming its capability, writing nothing', async () => {
    const engine = open() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const refused = Object.entries(RUST_ENGINE_MEMBERS).filter(([member, cls]) => cls !== 'implemented' && !Object.hasOwn(STORE_MEMBERS, member));
    // The count falls as families are built; the loop below checks each refused member, whatever the count.
    expect(refused.length).toBeGreaterThan(0);
    for (const [member, capability] of refused) {
      expect(typeof engine[member]).toBe('function');
      const error = await refusal(() => engine[member]!());
      expect({ member, code: error.code, reason: error.reason }).toEqual({ member, code: 'engine_capability_missing', reason: capability });
      expect(error.detail).toContain(`member=${member}`);
      expect(error.detail).toContain('written=nothing');
      expect(rustMemberCapability(member)).toBe(capability as never);
    }
    expect(rustMemberCapability('connect')).toBeNull();
    expect(rustMemberCapability('getConfig')).toBeNull(); // served now, so it no longer refuses
  });

  test('a served member before connect refuses engine_closed, and after disconnect too', async () => {
    const engine = open();
    expect((await refusal(() => engine.getConfig('k'))).code).toBe('engine_closed');
    await engine.connect({ engine: 'pglite', database_path: '/var/brains/test.rust' });
    await engine.disconnect();
    expect((await refusal(() => engine.getConfig('k'))).code).toBe('engine_closed');
  });

  test('every member class is the lifecycle or a named engine capability', () => {
    for (const cls of Object.values(RUST_ENGINE_MEMBERS)) {
      expect(cls === 'implemented' || (ENGINE_CAPABILITIES as readonly string[]).includes(cls)).toBe(true);
    }
  });

  test('connect, reconnect and disconnect run the lifecycle; disconnect runs every registered stop once', async () => {
    const engine = open();
    let stopped = 0;
    engine.registerBeforeDisconnect(async () => { stopped++; });
    const unregister = engine.registerBeforeDisconnect(async () => { stopped += 100; });
    unregister();
    engine.registerBeforeDisconnect(async () => { throw new Error('a failing stop never blocks shutdown'); });
    await engine.reconnect(); // never connected: nothing to restore
    expect(engine.connected).toBe(false);
    await engine.connect({ engine: 'pglite', database_path: '/var/brains/test.rust' });
    expect(engine.connected).toBe(true);
    await engine.reconnect();
    expect(engine.connected).toBe(true);
    expect(stopped).toBe(1);
    await engine.disconnect();
    expect(engine.connected).toBe(false);
    expect(stopped).toBe(1);
  });

  test('a disconnect that comes while connect is still opening wins: the opened store is closed and the engine stays disconnected', async () => {
    const gate = deferredAddon();
    const engine = openRustEngine({ addon: gate.addon, databasePath: '/var/brains/test.rust' });
    const connecting = engine.connect({ engine: 'pglite', database_path: '/var/brains/test.rust' });
    const settled = connecting.then(() => 'resolved', (error: { code?: string }) => error.code);
    await gate.opening();
    const disconnecting = engine.disconnect();
    gate.finishOpen();
    await disconnecting;
    expect(await settled).toBe('engine_closed');
    expect(engine.connected).toBe(false);
    expect(gate.brains.map((brain) => brain.isOpen)).toEqual([false]);
    expect((await refusal(() => engine.getConfig('k'))).code).toBe('engine_closed');
    // The engine can be connected again afterwards, and that open is the engine's one live store.
    gate.finishOpenNow();
    await engine.connect({ engine: 'pglite', database_path: '/var/brains/test.rust' });
    expect(engine.connected).toBe(true);
    expect(gate.brains.filter((brain) => brain.isOpen)).toHaveLength(1);
    await engine.disconnect();
    expect(gate.brains.filter((brain) => brain.isOpen)).toHaveLength(0);
  });

  test('a disconnect abandons a pending open at once, even while a stop hook is still running', async () => {
    const gate = deferredAddon();
    const engine = openRustEngine({ addon: gate.addon, databasePath: '/var/brains/test.rust' });
    let releaseHook: (() => void) | undefined;
    let hookRan = false;
    engine.registerBeforeDisconnect(async () => { await new Promise<void>((resolve) => { releaseHook = resolve; }); hookRan = true; });
    const connecting = engine.connect({ engine: 'pglite', database_path: '/var/brains/test.rust' });
    const settled = connecting.then(() => 'resolved', (error: { code?: string }) => error.code);
    await gate.opening();
    const disconnecting = engine.disconnect(); // the stop hook is now pending
    gate.finishOpen(); // the open completes while the hook is still pending
    expect(await settled).toBe('engine_closed'); // it never resolved as connected
    expect(engine.connected).toBe(false);
    expect(hookRan).toBe(false); // the hook was still pending when the connect settled
    expect(gate.brains.map((brain) => brain.isOpen)).toEqual([false]); // the store it opened is closed
    releaseHook?.();
    await disconnecting;
    expect(hookRan).toBe(true);
    expect(engine.connected).toBe(false);
    expect((await refusal(() => engine.getConfig('k'))).code).toBe('engine_closed');
  });

  test('connects that overlap open the store once', async () => {
    const gate = deferredAddon();
    const engine = openRustEngine({ addon: gate.addon, databasePath: '/var/brains/test.rust' });
    const config = { engine: 'pglite', database_path: '/var/brains/test.rust' } as const;
    const first = engine.connect(config);
    const second = engine.connect(config);
    await gate.opening();
    gate.finishOpen();
    await Promise.all([first, second]);
    expect(gate.brains).toHaveLength(1);
    expect(engine.connected).toBe(true);
    await engine.connect(config);
    expect(gate.brains).toHaveLength(1);
    await engine.disconnect();
    expect(gate.brains[0]!.isOpen).toBe(false);
  });

  test('a failed open rejects every overlapping connect and the next connect tries again', async () => {
    const gate = deferredAddon();
    const engine = openRustEngine({ addon: gate.addon, databasePath: '/var/brains/test.rust' });
    const config = { engine: 'pglite', database_path: '/var/brains/test.rust' } as const;
    const results = [engine.connect(config), engine.connect(config)].map((p) => p.then(() => 'resolved', () => 'rejected'));
    await gate.opening();
    gate.failOpen();
    expect(await Promise.all(results)).toEqual(['rejected', 'rejected']);
    expect(engine.connected).toBe(false);
    gate.finishOpenNow();
    await engine.connect(config);
    expect(engine.connected).toBe(true);
    await engine.disconnect();
  });

  test('a partial or unknown outcome says what may have been written', () => {
    expect(capabilityMissing('raw_sql', 'x', 'partial').detail).toContain('written=partial');
    expect(capabilityMissing('raw_sql', 'x', 'unknown').message).not.toContain('nothing ran');
  });
});

describe('Rust kind on SQL-only paths', () => {
  test('engine_capability_missing is registered with every engine capability as a reason', () => {
    const rows = CODES as unknown as Record<string, { reasons?: readonly string[] }>;
    expect(rows.engine_capability_missing?.reasons).toEqual([...ENGINE_CAPABILITIES]);
  });

  test('sqlEngineKind and stageBatchBytes refuse a Rust brain instead of treating it as Postgres', async () => {
    expect(isSqlEngineKind('pglite')).toBe(true);
    expect(isSqlEngineKind('rust')).toBe(false);
    expect(sqlEngineKind('postgres', 'x')).toBe('postgres');
    const error = await refusal(() => sqlEngineKind('rust', 'gbrain migrate'));
    expect([error.code, error.reason]).toEqual(['engine_capability_missing', 'raw_sql']);
    expect(stageBatchBytes('pglite')).toBe(STAGE_BATCH_BYTES.pglite);
    const staged = await refusal(() => stageBatchBytes('rust'));
    expect(staged.code).toBe('engine_capability_missing');
  });
});
