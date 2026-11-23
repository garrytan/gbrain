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
import { connectOwner, installOwnerClient, ownerConnectionFor } from '../src/core/rust-engine/owner-ipc/client.ts';
import { ownerLockPath, ownerSocketPath } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import type { BrainEngine } from '../src/core/engine.ts';

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

  // The election opens the store before the owner socket listens, so no client call reaches an owner whose store is
  // still opening. When the open then fails, or a disconnect abandons it, the owner role is given up and the lock is
  // free for the next owner.
  for (const outcome of ['fails', 'is abandoned'] as const) {
    test(`no client reaches the owner while the open is pending, and the owner role is given up when the open ${outcome}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-shell-early-'));
      const db = join(dir, 'brain.rust');
      const gate = deferredAddon();
      const engine = openRustEngine({ addon: gate.addon, databasePath: db });
      const config = { engine: 'pglite', database_path: db } as const;
      const settled = engine.connect(config).then(() => 'resolved', (error: { code?: string }) => error.code ?? 'rejected');
      let close = () => {};
      try {
        await gate.opening();
        const early = await connectOwner(ownerSocketPath(db), { timeoutMs: 500 }).then(
          (conn) => { close = installOwnerClient({ kind: 'rust', capabilities: new Set<string>() } as unknown as BrainEngine, conn); return 'connected'; },
          () => 'refused',
        );
        expect(early).toBe('refused');
        const timeout = Bun.sleep(3_000).then(() => 'hung');
        let disconnected: Promise<void> = Promise.resolve();
        if (outcome === 'fails') gate.failOpen();
        else { disconnected = engine.disconnect(); gate.finishOpen(); }
        expect(await Promise.race([settled, timeout])).not.toBe('hung');
        expect(await Promise.race([disconnected.then(() => 'done'), timeout])).toBe('done');
        expect(await settled).not.toBe('resolved');
        expect(engine.connected).toBe(false);
        expect(engine.ownerRole).toBeNull();
        // The lock was given up: the next connect becomes the owner again.
        gate.finishOpenNow();
        await engine.connect(config);
        expect(engine.ownerRole).toBe('owner');
        await engine.disconnect();
      } finally {
        close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test('a disconnect during a pending open keeps the owner lock until the open has settled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-shell-lock-'));
    const db = join(dir, 'brain.rust');
    const gate = deferredAddon();
    const engine = openRustEngine({ addon: gate.addon, databasePath: db });
    const settled = engine.connect({ engine: 'pglite', database_path: db }).then(() => 'resolved', (error: { code?: string }) => error.code);
    try {
      await gate.opening();
      const disconnecting = engine.disconnect();
      await Bun.sleep(50);
      // The store open is still running, so no other process may take the brain yet.
      const early = await tryAcquireNativeLock(ownerLockPath(db));
      await early?.release();
      expect(early).toBeNull();
      gate.finishOpen();
      await disconnecting;
      expect(await settled).toBe('engine_closed');
      expect(gate.brains.map((brain) => brain.isOpen)).toEqual([false]);
      const after = await tryAcquireNativeLock(ownerLockPath(db));
      expect(after).not.toBeNull();
      await after?.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a store close that rejects still releases the owner lock, and disconnect rethrows the close error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-shell-close-'));
    const db = join(dir, 'brain.rust');
    class BrokenCloseBrain extends FakeBrain {
      async close() { this.isOpen = false; throw Object.assign(new Error('store close failed'), { code: 'store_io' }); }
    }
    const engine = openRustEngine({ addon: { ...addon, Brain: BrokenCloseBrain }, databasePath: db });
    try {
      await engine.connect({ engine: 'pglite', database_path: db });
      expect(engine.ownerRole).toBe('owner');
      const outcome = await engine.disconnect().then(() => 'resolved', (error: unknown) => error);
      expect(outcome).not.toBe('resolved');
      expect(engine.connected).toBe(false);
      expect(engine.ownerRole).toBeNull();
      const lock = await tryAcquireNativeLock(ownerLockPath(db));
      expect(lock).not.toBeNull();
      await lock?.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=a client that takes over its brain but fails the store open ends disconnected, frees the owner lock and socket, and reconnects; fails_when=the failed takeover keeps the role or stays connected; why_new=only fresh connects and early calls covered, never a takeover whose open fails; seam=none; no_claim=owner success
  test('a client promoted to owner whose store open fails ends disconnected, gives up the owner role and lock, and an explicit reconnect succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-shell-takeover-'));
    const db = join(dir, 'brain.rust');
    const config = { engine: 'pglite', database_path: db } as const;
    const first = openRustEngine({ addon, databasePath: db });
    const gate = deferredAddon();
    const engine = openRustEngine({ addon: gate.addon, databasePath: db, ownerWaitMs: 3_000 });
    try {
      await first.connect(config);
      expect(first.ownerRole).toBe('owner');
      await engine.connect(config);
      expect(engine.ownerRole).toBe('client');
      expect(engine.connected).toBe(true);
      // The owner goes away; the client's next call runs the election, wins it, and its store open fails.
      await first.disconnect();
      for (let i = 0; i < 200 && !ownerConnectionFor(engine)?.closed; i++) await Bun.sleep(10);
      expect(ownerConnectionFor(engine)?.closed).toBe(true);
      const call = engine.getConfig('k').then(() => 'resolved', (error: { code?: string }) => error.code ?? 'rejected');
      await gate.opening();
      expect(engine.ownerRole).toBe('owner');
      gate.failOpen();
      // The call that ran the failed takeover ends with the store's own error, not the engine_closed the emptied engine gives.
      const failure = await call;
      expect(failure).not.toBe('resolved');
      expect(failure).not.toBe('engine_closed');
      expect({ connected: engine.connected, role: engine.ownerRole, stats: engine.ownerStats() }).toEqual({ connected: false, role: null, stats: null });
      expect((await refusal(() => engine.getConfig('k'))).code).toBe('engine_closed');
      // The lock and the socket were given up: another process can take the brain, and nothing answers there.
      const lock = await tryAcquireNativeLock(ownerLockPath(db));
      expect(lock).not.toBeNull();
      await lock?.release();
      const answered = await connectOwner(ownerSocketPath(db), { timeoutMs: 200 }).then(connection => { connection.close(); return true; }, () => false);
      expect(answered).toBe(false);
      // An explicit reconnect takes the brain again.
      gate.finishOpenNow();
      await engine.reconnect();
      expect(engine.connected).toBe(true);
      expect(engine.ownerRole).toBe('owner');
      expect(gate.brains.at(-1)!.isOpen).toBe(true);
    } finally {
      await engine.disconnect();
      await first.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // Value: protects=a call that finds the owner gone while disconnect runs does not start an election that outlives the disconnect; fails_when=the late call opens a store and takes the owner lock after disconnect resolved; why_new=failover tests never overlapped a call with disconnect; seam=none; no_claim=takeover success
  test('a call made while disconnect runs after the owner went away does not take the brain over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-shell-late-call-'));
    const db = join(dir, 'brain.rust');
    const config = { engine: 'pglite', database_path: db } as const;
    const first = openRustEngine({ addon, databasePath: db });
    const engine = openRustEngine({ addon, databasePath: db, ownerWaitMs: 3_000 });
    try {
      await first.connect(config);
      await engine.connect(config);
      expect(engine.ownerRole).toBe('client');
      await first.disconnect();
      for (let i = 0; i < 200 && !ownerConnectionFor(engine)?.closed; i++) await Bun.sleep(10);
      expect(ownerConnectionFor(engine)?.closed).toBe(true);
      const stopping = engine.disconnect();
      const late = engine.getConfig('k').then(() => 'resolved', (error: { code?: string }) => error.code ?? 'rejected');
      await Promise.all([stopping, late]);
      // Give a leaked election the time it would need to publish its store.
      await Bun.sleep(300);
      expect({ connected: engine.connected, role: engine.ownerRole, stats: engine.ownerStats() }).toEqual({ connected: false, role: null, stats: null });
      expect(await late).not.toBe('resolved');
      const lock = await tryAcquireNativeLock(ownerLockPath(db));
      expect(lock).not.toBeNull();
      await lock?.release();
    } finally {
      await engine.disconnect();
      await first.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

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

  test('sqlEngineKind refuses a Rust brain instead of treating it as Postgres, and stageBatchBytes batches its staging like the SQL engines', async () => {
    expect(isSqlEngineKind('pglite')).toBe(true);
    expect(isSqlEngineKind('rust')).toBe(false);
    expect(sqlEngineKind('postgres', 'x')).toBe('postgres');
    const error = await refusal(() => sqlEngineKind('rust', 'gbrain migrate'));
    expect([error.code, error.reason]).toEqual(['engine_capability_missing', 'raw_sql']);
    expect(stageBatchBytes('pglite')).toBe(STAGE_BATCH_BYTES.pglite);
    expect(stageBatchBytes('rust')).toBe(STAGE_BATCH_BYTES.pglite);
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
