/**
 * Optimistic explicit transactions on the Rust engine in multi-user mode (docs/designs/rust-engine/multi-user-server.md,
 * interface I-1; rust-engine/optimistic-transaction.ts). With the switch off nothing changes: the capability sets stay
 * the same and the engine keeps its writer gate.
 *
 * The addon tests need the file `bun run rust:build` writes (rust/target/addon) and skip without it;
 * GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error. Serial: the switch is an environment variable.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { servedCapabilities } from '../src/core/rust-engine/store-capabilities.ts';
import { capabilitiesForEngineKind } from '../src/core/engine-capabilities.ts';
import { rustMultiuserFromEnv, RUST_MULTIUSER_CONFIG_KEY } from '../src/core/rust-engine/multiuser-switch.ts';
import { OPTIMISTIC_TRANSACTION_RETRIES, rustTransactionDeadlineMs } from '../src/core/rust-engine/optimistic-transaction.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { rustLeases } from '../src/core/rust-engine/store-members/leases.ts';

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
const savedEnv = { multiuser: process.env.GBRAIN_RUST_MULTIUSER, deadline: process.env.GBRAIN_RUST_TXN_DEADLINE_MS };

async function open(multiuser: boolean, dir?: string): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  if (multiuser) process.env.GBRAIN_RUST_MULTIUSER = '1'; else delete process.env.GBRAIN_RUST_MULTIUSER;
  const path = dir ?? mkdtempSync(join(tmpdir(), 'gbrain-rust-mu-'));
  if (!dir) dirs.push(path);
  const engine = openRustEngine({ addon, databasePath: path });
  engines.push(engine);
  await engine.connect({ engine: 'rust', database_path: path } as never);
  return engine;
}

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of [['GBRAIN_RUST_MULTIUSER', savedEnv.multiuser], ['GBRAIN_RUST_TXN_DEADLINE_MS', savedEnv.deadline]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const note = (title: string) => ({ type: 'note', title, compiled_truth: `${title} body.`, timeline: '' }) as const;

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

async function errorOf(fn: () => Promise<unknown>): Promise<{ code?: string; reason?: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    const e = error as { code?: string; reason?: string; message: string };
    return { code: e.code, reason: e.reason, message: e.message };
  }
  throw new Error('expected a rejection');
}

describe('multi-user switch', () => {
  test('off: every engine kind reports the capability set it reported before', () => {
    delete process.env.GBRAIN_RUST_MULTIUSER;
    expect(rustMultiuserFromEnv()).toBe(false);
    expect(capabilitiesForEngineKind('postgres').has('multi_writer')).toBe(false);
    expect(capabilitiesForEngineKind('pglite').has('multi_writer')).toBe(false);
  });

  test('on: Postgres reports multi_writer, PGLite does not', () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    expect(capabilitiesForEngineKind('postgres').has('multi_writer')).toBe(true);
    expect(capabilitiesForEngineKind('pglite').has('multi_writer')).toBe(false);
  });

  test('the deadline sub-switch takes a positive number of milliseconds', () => {
    expect(rustTransactionDeadlineMs({ GBRAIN_RUST_TXN_DEADLINE_MS: '250' })).toBe(250);
    expect(rustTransactionDeadlineMs({ GBRAIN_RUST_TXN_DEADLINE_MS: 'soon' })).toBeUndefined();
    expect(rustTransactionDeadlineMs({ GBRAIN_RUST_TXN_DEADLINE_MS: '0' })).toBeUndefined();
    expect(rustTransactionDeadlineMs({})).toBeUndefined();
  });
});

describe('Rust engine in multi-user mode', () => {
  withAddon('off: the engine reports exactly the served capabilities', async () => {
    delete process.env.GBRAIN_RUST_MULTIUSER;
    const engine = await open(false);
    expect(engine.multiuser).toBe(false);
    expect([...engine.capabilities].sort() as string[]).toEqual([...servedCapabilities()].sort() as string[]);
  });

  withAddon('the brain config row turns multi-user mode on for that brain at its next open', async () => {
    const first = await open(false);
    expect(first.multiuser).toBe(false);
    await first.setConfig(RUST_MULTIUSER_CONFIG_KEY, 'true');
    const dir = dirs[dirs.length - 1]!;
    await first.disconnect();
    const again = await open(false, dir);
    expect(again.multiuser).toBe(true);
    expect(again.capabilities.has('multi_writer')).toBe(true);
  });

  withAddon('on: the engine reports multi_writer', async () => {
    const engine = await open(true);
    expect(engine.multiuser).toBe(true);
    expect(engine.capabilities.has('multi_writer')).toBe(true);
    expect([...engine.capabilities].filter((c) => c !== 'multi_writer').sort() as string[]).toEqual([...servedCapabilities()].sort() as string[]);
  });

  withAddon('C13: a transaction on another page commits, and a plain write lands, while one is open', async () => {
    const engine = await open(true);
    const held = gate();
    const entered = gate();
    const slow = engine.transaction(async (tx) => {
      await tx.putPage('notes/slow', note('Slow'));
      entered.open();
      await held.wait;
      return 'slow';
    });
    await entered.wait;
    expect(await engine.transaction(async (tx) => { await tx.putPage('notes/fast', note('Fast')); return 'fast'; })).toBe('fast');
    await engine.putPage('notes/plain', note('Plain'));
    expect((await engine.getPage('notes/fast'))?.title).toBe('Fast');
    expect(await engine.getPage('notes/slow')).toBeNull();
    held.open();
    expect(await slow).toBe('slow');
    expect((await engine.getPage('notes/slow'))?.title).toBe('Slow');
  });

  withAddon('a transaction whose read went stale runs again and its last run is what commits', async () => {
    const engine = await open(true);
    await engine.putPage('notes/x', note('X0'));
    let runs = 0;
    const held = gate();
    const entered = gate();
    const reader = engine.transaction(async (tx) => {
      runs++;
      const seen = (await tx.getPage('notes/x'))?.title;
      if (runs === 1) { entered.open(); await held.wait; }
      await tx.putPage('notes/y', note(`saw ${seen}`));
      return seen;
    });
    await entered.wait;
    await engine.putPage('notes/x', note('X1'));
    held.open();
    expect(await reader).toBe('X1');
    expect(runs).toBe(2);
    expect((await engine.getPage('notes/y'))?.title).toBe('saw X1');
  });

  withAddon('a callback that keeps losing ends revision_conflict, reason transaction_contention, after nine runs', async () => {
    const engine = await open(true);
    let runs = 0;
    const err = await errorOf(() => engine.transaction(async (tx) => {
      runs++;
      await tx.putPage(`notes/lost-${runs}`, note('Lost'));
      throw Object.assign(new Error('lost'), { code: 'write_conflict' });
    }));
    expect(runs).toBe(OPTIMISTIC_TRANSACTION_RETRIES + 1);
    expect(err.code).toBe('revision_conflict');
    expect(err.reason).toBe('transaction_contention');
    expect(await engine.getPage('notes/lost-1')).toBeNull();
  });

  withAddon('an error that is not a conflict ends the transaction at once, nothing kept', async () => {
    const engine = await open(true);
    let runs = 0;
    const err = await errorOf(() => engine.transaction(async (tx) => {
      runs++;
      await tx.putPage('notes/boom', note('Boom'));
      throw new Error('boom');
    }));
    expect(err.message).toBe('boom');
    expect(runs).toBe(1);
    expect(await engine.getPage('notes/boom')).toBeNull();
  });

  withAddon('the transaction deadline ends a slow callback with timeout and keeps nothing', async () => {
    const engine = await open(true);
    process.env.GBRAIN_RUST_TXN_DEADLINE_MS = '150';
    let late: Promise<unknown> | undefined;
    const err = await errorOf(() => engine.transaction(async (tx) => {
      await tx.putPage('notes/early', note('Early'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      late = tx.putPage('notes/late', note('Late')).then(() => 'wrote', (e: { code?: string }) => e.code);
      return 'done';
    }));
    expect(err.code).toBe('timeout');
    expect(err.reason).toBe('transaction_deadline');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await late).toBe('engine_closed');
    expect(await engine.getPage('notes/early')).toBeNull();
    expect(await engine.getPage('notes/late')).toBeNull();
  });

  withAddon('C15: lockPageKeys makes a second transaction on the same page wait for the first to commit', async () => {
    const engine = await open(true);
    const order: string[] = [];
    const held = gate();
    const entered = gate();
    const key = { sourceId: 'default', slug: 'notes/k' };
    const first = engine.transaction(async (tx) => {
      await tx.lockPageKeys([key]);
      entered.open();
      await held.wait;
      await tx.putPage('notes/k', note('First'));
      order.push('first');
    });
    await entered.wait;
    const second = engine.transaction(async (tx) => {
      await tx.lockPageKeys([key]);
      order.push('second-locked');
      await tx.putPage('notes/k', note('Second'));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(order).toEqual([]);
    held.open();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second-locked']);
    expect((await engine.getPage('notes/k'))?.title).toBe('Second');
  });

  withAddon('C20: two transactions locking two pages in both orders both finish', async () => {
    const engine = await open(true);
    const a = { sourceId: 'default', slug: 'notes/a' };
    const b = { sourceId: 'default', slug: 'notes/b' };
    const both = gate();
    let ready = 0;
    const meet = async () => { if (++ready === 2) both.open(); await both.wait; };
    const lockBoth = (first: typeof a, second: typeof a, title: string) => (tx: BrainEngine) => (async () => {
      await tx.lockPageKeys([first]);
      if (ready < 2) await meet();
      await tx.lockPageKeys([second]);
      await tx.putPage(second.slug, note(title));
    })();
    await Promise.all([engine.transaction(lockBoth(a, b, 'AB')), engine.transaction(lockBoth(b, a, 'BA'))]);
    expect((await engine.getPage('notes/a'))?.title).toBe('BA');
    expect((await engine.getPage('notes/b'))?.title).toBe('AB');
  });

  withAddon('64 open transactions and retry bursts leave no executor threads behind', async () => {
    const engine = await open(true);
    const live = (addon as unknown as { liveWorkers(): number }).liveWorkers;
    const before = live();
    await engine.putPage('notes/hot', note('Hot0'));
    await Promise.all(Array.from({ length: 64 }, (_, i) => engine.transaction(async (tx) => {
      await tx.getPage('notes/hot');
      await tx.putPage(`notes/w${i}`, note(`W${i}`));
    })));
    await Promise.all(Array.from({ length: 8 }, (_, i) => engine.transaction(async (tx) => {
      const seen = (await tx.getPage('notes/hot'))?.title;
      await tx.putPage('notes/hot', note(`${seen}+${i}`));
    })));
    expect((await engine.getPage('notes/hot'))?.title.split('+').length).toBe(9);
    // Pools shut down when their attempt ends; their threads exit right after.
    for (let i = 0; i < 50 && live() > before; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(live()).toBeLessThanOrEqual(before);
  });

  // Second-model review 2.3: a callback that resumes after its deadline cannot write through the outer engine.
  withAddon('a callback resumed after its deadline cannot write through the outer engine', async () => {
    const engine = await open(true);
    process.env.GBRAIN_RUST_TXN_DEADLINE_MS = '100';
    let late: Promise<string> | undefined;
    const err = await errorOf(() => engine.transaction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      late = engine.setConfig('l1.late', 'written').then(() => 'written', (e: { code?: string }) => e.code ?? 'refused');
    }));
    expect(err.code).toBe('timeout');
    delete process.env.GBRAIN_RUST_TXN_DEADLINE_MS;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await late).not.toBe('written');
    expect(await engine.getConfig('l1.late')).toBeNull();
  });

  // Second-model review 3.1: disconnect ends a transaction that waits for a key another open one holds.
  withAddon('disconnect ends an older transaction waiting on a key a younger one holds', async () => {
    const engine = await open(true);
    const key = { sourceId: 'default', slug: 'notes/p' };
    const olderOpen = gate();
    const youngerHolds = gate();
    const never = new Promise<void>(() => undefined);
    const older = engine.transaction(async (tx) => {
      olderOpen.open();
      await youngerHolds.wait;
      await tx.lockPageKeys([key]);
    }).catch(() => 'ended');
    await olderOpen.wait;
    const younger = engine.transaction(async (tx) => {
      await tx.lockPageKeys([key]);
      youngerHolds.open();
      await never;
    }).catch(() => 'ended');
    await youngerHolds.wait;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = await Promise.race([
      engine.disconnect().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 15_000)),
    ]);
    expect(closed).toBe('closed');
    void older; void younger;
  }, 30_000);

  // I-5 on the optimistic path: a commit made under a lease epoch that moved is refused; the run again sees lease_lost.
  withAddon('a transaction whose lease was taken over before it committed ends lease_lost, nothing kept', async () => {
    const engine = await open(true);
    expect(engine.multiuser).toBe(true);
    const leases = rustLeases(engine as never);
    const origin = (host: string) => ({ host_id: `host-${host}`, incarnation: '0190a000-0000-7000-8000-000000000001', writer_id: `local_cli:${host}` });
    const a = (await leases.acquire('job-runner', origin('a'), 60_000))!;
    const checked = gate();
    const taken = gate();
    let runs = 0;
    const work = engine.transaction(async (tx) => {
      runs++;
      await rustLeases(tx as never).assert(a);
      await tx.putPage('notes/protected', note('Under epoch 1'));
      if (runs === 1) { checked.open(); await taken.wait; }
    });
    await checked.wait;
    await leases.release(a);
    const b = (await leases.acquire('job-runner', origin('b'), 60_000))!;
    expect(b.epoch).toBeGreaterThan(a.epoch);
    taken.open();
    const err = await errorOf(() => work);
    expect(err.code).toBe('lease_lost');
    expect(runs).toBe(2);
    expect(await engine.getPage('notes/protected')).toBeNull();
  });
});
