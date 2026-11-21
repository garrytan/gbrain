/**
 * The Rust engine shell (docs/designs/RUST_ENGINE.md, "PR sequence" step 8). `openRustEngine` takes an addon the
 * loader already verified and returns an engine that reports only the capabilities whose every member the store
 * serves, and refuses every other member with `engine_capability_missing` before any work. SQL-only paths refuse a
 * Rust kind instead of treating it as Postgres. These tests pass a plain object, with a fake store, as the verified
 * addon; test/rust-engine-store.test.ts runs the real one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// Connect takes the owner lock and socket next to the brain file, so each
// run uses its own temporary directory.
const BRAIN_DIR = mkdtempSync(join(tmpdir(), 'gbrain-rust-shell-brain-'));
const BRAIN_PATH = join(BRAIN_DIR, 'test.rust');
afterAll(() => rmSync(BRAIN_DIR, { recursive: true, force: true }));

const open = () => openRustEngine({ addon, databasePath: BRAIN_PATH });

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
    expect(engine.databasePath).toBe(BRAIN_PATH);
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
    await engine.connect({ engine: 'pglite', database_path: BRAIN_PATH });
    await engine.disconnect();
    expect((await refusal(() => engine.getConfig('k'))).code).toBe('engine_closed');
  });

  test('every member class is the lifecycle or a named engine capability', () => {
    for (const cls of Object.values(RUST_ENGINE_MEMBERS)) {
      expect(cls === 'implemented' || (ENGINE_CAPABILITIES as readonly string[]).includes(cls)).toBe(true);
    }
  });

  test('connect, reconnect and disconnect run the lifecycle; disconnect runs every registered stop once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-shell-'));
    const engine = openRustEngine({ addon, databasePath: join(dir, 'brain.rust') });
    let stopped = 0;
    engine.registerBeforeDisconnect(async () => { stopped++; });
    const unregister = engine.registerBeforeDisconnect(async () => { stopped += 100; });
    unregister();
    engine.registerBeforeDisconnect(async () => { throw new Error('a failing stop never blocks shutdown'); });
    await engine.reconnect(); // never connected: nothing to restore
    expect(engine.connected).toBe(false);
    await engine.connect({ engine: 'pglite', database_path: join(dir, 'brain.rust') });
    expect(engine.connected).toBe(true);
    expect(engine.ownerRole).toBe('owner');
    await engine.reconnect();
    expect(engine.connected).toBe(true);
    expect(stopped).toBe(1);
    await engine.disconnect();
    expect(engine.connected).toBe(false);
    expect(engine.ownerRole).toBeNull();
    expect(stopped).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a disconnect that comes while connect is still opening wins: the opened store is closed and the engine stays disconnected', async () => {
    const gate = deferredAddon();
    const engine = openRustEngine({ addon: gate.addon, databasePath: BRAIN_PATH });
    const connecting = engine.connect({ engine: 'pglite', database_path: BRAIN_PATH });
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
    await engine.connect({ engine: 'pglite', database_path: BRAIN_PATH });
    expect(engine.connected).toBe(true);
    expect(gate.brains.filter((brain) => brain.isOpen)).toHaveLength(1);
    await engine.disconnect();
    expect(gate.brains.filter((brain) => brain.isOpen)).toHaveLength(0);
  });

  test('a disconnect abandons a pending open at once, even while a stop hook is still running', async () => {
    const gate = deferredAddon();
    const engine = openRustEngine({ addon: gate.addon, databasePath: BRAIN_PATH });
    let releaseHook: (() => void) | undefined;
    let hookRan = false;
    engine.registerBeforeDisconnect(async () => { await new Promise<void>((resolve) => { releaseHook = resolve; }); hookRan = true; });
    const connecting = engine.connect({ engine: 'pglite', database_path: BRAIN_PATH });
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
    const engine = openRustEngine({ addon: gate.addon, databasePath: BRAIN_PATH });
    const config = { engine: 'pglite', database_path: BRAIN_PATH } as const;
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
    const engine = openRustEngine({ addon: gate.addon, databasePath: BRAIN_PATH });
    const config = { engine: 'pglite', database_path: BRAIN_PATH } as const;
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

/**
 * Transaction-local settings on the Rust shell (store-members/transactions.ts, rust/docs/store/transactions.md item
 * 12). The name checks run before any store call, so the fake store answers them. Postgres accepts a custom name only
 * as two or more simple identifiers separated by dots, and an unknown name with no dot not at all; the Rust engine
 * keeps a `gbrain.*` name only when Postgres would take it and no schema SQL reads it.
 */
describe('Rust transaction settings: the names the shell keeps', () => {
  const SETTINGS_FILE = join(import.meta.dir, '..', 'src/core/rust-engine/store-members/transactions.ts');
  /** The names of one `const <name>: ReadonlySet<string> = new Set([...])` in transactions.ts. */
  function setNames(constName: string): string[] {
    // test-reads-source-ok[structural]: which list a name sits in is not observable (scope and custom names behave alike), and transactions.ts may export only engine members.
    const match = readFileSync(SETTINGS_FILE, 'utf8').match(new RegExp(`const ${constName}: ReadonlySet<string> = new Set\\(\\[([^\\]]*)\\]\\)`));
    expect(match).not.toBeNull();
    return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  }
  /** Every `gbrain.*` name SQL under src reads with current_setting('gbrain.<name>'. */
  function schemaReadNames(): string[] {
    const names = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|sql)$/.test(entry.name)) {
          for (const m of readFileSync(path, 'utf8').matchAll(/current_setting\(\s*'(gbrain\.[a-z0-9_.]+)'/g)) names.add(m[1]!);
        }
      }
    };
    walk(join(import.meta.dir, '..', 'src'));
    return [...names].sort();
  }
  const refused = async (run: () => Promise<unknown>) => {
    const error = await refusal(run);
    return [error.code, error.reason];
  };

  test('a name Postgres rejects, and a name schema SQL reads, refuse; a custom gbrain name is kept', async () => {
    const engine = open();
    await engine.connect({ engine: 'pglite', database_path: BRAIN_PATH });
    try {
      for (const name of ['gbrain.', 'gbrain..x', 'gbrain.1x', 'parity_first', ...setNames('SCHEMA_READ_SETTINGS')]) {
        expect({ name, read: await refused(() => engine.readTransactionSettings([name])) })
          .toEqual({ name, read: ['engine_capability_missing', 'transactions'] });
        expect({ name, apply: await refused(() => engine.applyTransactionSettings([name], ['v'])) })
          .toEqual({ name, apply: ['engine_capability_missing', 'transactions'] });
      }
      // Outside a transaction a kept name reads unset, as on PGLite.
      expect(await engine.readTransactionSettings(['gbrain.parity_first', 'gbrain.parity.nested'])).toEqual([null, null]);
    } finally {
      await engine.disconnect();
    }
  });

  test('every gbrain setting schema SQL reads is one the store keeps or one the shell refuses', () => {
    const kept = [...setNames('TRUST_SETTINGS'), ...setNames('SCOPE_SETTINGS')];
    const refusedNames = setNames('SCHEMA_READ_SETTINGS');
    expect(kept.length).toBeGreaterThan(0);
    expect(refusedNames.length).toBeGreaterThan(0);
    const read = schemaReadNames();
    expect(read).toContain('gbrain.writer_quiesced');
    expect(read.filter((name) => !kept.includes(name) && !refusedNames.includes(name))).toEqual([]);
  });
});
