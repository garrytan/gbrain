/**
 * A read on the store waits for the pool, not for the writes queued ahead of it.
 *
 * The store runs every call on one worker pool, and writes take turns on the store's writer. A read sent after a
 * burst of writes waited in the pool's queue until every write ahead of it had started: each write holds a worker
 * while it waits for its turn, so the read answered only after nearly all of them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { openPrincipalSession } from '../src/core/rust-engine/principal-session.ts';
import { primaryRecordsFrame } from '../src/core/rust-engine/served/follower-apply.ts';
import { storePositionReader } from '../src/core/rust-engine/served/positions.ts';
import type { RustStore } from '../src/core/rust-engine/store.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

interface PoolView { readonly queued: number; readonly running: number }
const WRITES = 16;
const page = (title: string) => ({ type: 'note', title, compiled_truth: `${title} ${'body '.repeat(200)}`, timeline: '' });

// Both modes of the switch: the test preload scrubs GBRAIN_RUST_MULTIUSER from the environment, so each block sets it
// itself for its store's open (the store reads it then) and puts it back afterwards.
for (const MULTIUSER of [false, true]) (HAVE_ADDON ? describe : describe.skip)(`a read behind a burst of writes (multi-user ${MULTIUSER ? 'on' : 'off'})`, () => {
  let dir: string;
  let engine: RustEngine;
  let pool: PoolView | undefined;

  beforeAll(async () => {
    const real = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } }) as RustAddon & { Pool: new (n: number, ...rest: unknown[]) => PoolView };
    // The same addon, with the store's pool kept so the test can see its queue.
    const addon = Object.create(real) as typeof real;
    addon.Pool = function Pool(this: unknown, ...args: unknown[]) {
      pool = new (real.Pool as new (...a: unknown[]) => PoolView)(...args);
      return pool;
    } as unknown as typeof real.Pool;
    dir = mkdtempSync(join(tmpdir(), 'gbrain-read-lane-'));
    const databasePath = join(dir, 'brain');
    const saved = { mu: process.env.GBRAIN_RUST_MULTIUSER, log: process.env.GBRAIN_RUST_COMMIT_LOG };
    if (MULTIUSER) Object.assign(process.env, { GBRAIN_RUST_MULTIUSER: '1', GBRAIN_RUST_COMMIT_LOG: '1' });
    try {
      engine = openRustEngine({ addon, databasePath } as never);
      await engine.connect({ engine: 'rust', database_path: databasePath } as never);
    } finally {
      for (const [key, value] of [['GBRAIN_RUST_MULTIUSER', saved.mu], ['GBRAIN_RUST_COMMIT_LOG', saved.log]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    expect((engine.openStoreIfOpen('getPage') as RustStore).multiuser).toBe(MULTIUSER);
    await engine.putPage('notes/seed', page('seed') as never);
    // Enough pages that a listing read takes a while, so reads pile up in the read lane.
    await Promise.all(Array.from({ length: 300 }, (_, i) => engine.putPage(`notes/bulk-${i}`, page(`bulk-${i}`) as never)));
  });

  afterAll(async () => {
    await engine?.disconnect();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Sends WRITES page writes, then `read` once they wait in the pool; resolves where the read finished among them. */
  async function readIndexBehindWrites<T>(tag: string, read: () => Promise<T>): Promise<{ index: number; value: T }> {
    const order: string[] = [];
    const writes = Array.from({ length: WRITES }, (_, i) =>
      engine.putPage(`notes/${tag}-${i}`, page(`${tag}-${i}`) as never).then(() => { order.push(`w-${i}`); }));
    await Bun.sleep(0);
    // The writes are queued in the pool: more of them wait than there are workers.
    expect(pool!.queued).toBeGreaterThan(WRITES / 2);
    const value = await read().finally(() => { order.push('read'); });
    await Promise.all(writes);
    return { index: order.indexOf('read'), value };
  }

  /** Records which members are called through the store's read-lane handle while `run` runs. */
  async function readLaneMembers(run: () => Promise<unknown>): Promise<Set<string>> {
    const store = engine.openStoreIfOpen('getPage') as RustStore & { readBrain?: object };
    const real = store.readBrain!;
    const seen = new Set<string>();
    (store as { readBrain?: object }).readBrain = new Proxy(real, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { seen.add(String(key)); return (value as (...a: unknown[]) => unknown).apply(target, args); };
      },
    });
    try { await run(); } finally { (store as { readBrain?: object }).readBrain = real; }
    return seen;
  }

  test('the read answers before the writes queued ahead of it have run', async () => {
    const { index, value } = await readIndexBehindWrites('w', () => engine.getPage('notes/seed'));
    expect(value?.title).toBe('seed');
    // Before the fix the read ran only after about WRITES - 3 writes. A read with its own lane runs at once; a few
    // writes already on a worker may still finish first.
    expect(index).toBeLessThanOrEqual(4);
  });

  test('members that write under a reading name stay out of the read lane', async () => {
    const seen = await readLaneMembers(async () => {
      await engine.getPage('notes/seed');
      await engine.resolveStrandedParents();
      await engine.resolveParentJob(987_654);
      await engine.readJobInbox(987_654, 'no-such-lock').catch(() => undefined);
    });
    expect(seen.has('readPageSnapshot')).toBe(true); // getPage's store call
    for (const writer of ['resolveStrandedParents', 'resolveParentJob', 'readJobInbox']) expect(seen.has(writer)).toBe(false);
  });

  test.if(MULTIUSER)('session admission reads in the read lane, not behind queued writes', async () => {
    const store = engine.openStoreIfOpen('getPage') as RustStore;
    const seen = await readLaneMembers(() => openPrincipalSession(store, 'not-a-token').catch(() => undefined));
    expect(seen.has('mintScope')).toBe(true);
    const { index, value } = await readIndexBehindWrites('s', () =>
      openPrincipalSession(store, 'not-a-token').then(() => 'admitted', (e: { code?: string }) => e.code));
    expect(value).toBe('permission_denied');
    expect(index).toBeLessThanOrEqual(4);
  });

  test.if(MULTIUSER)('position and commit-log reads wait in the read lane; the follower log fetch does not', async () => {
    const store = engine.openStoreIfOpen('getPage') as RustStore;
    const seen = await readLaneMembers(async () => {
      await storePositionReader(engine)();
      await engine.readCommitLog(null, 10);
      await primaryRecordsFrame(store, null, 10, 1, 1);
    });
    for (const member of ['lastCommitPosition', 'readCommitLog']) expect(seen.has(member)).toBe(true);
    // The follower's raw log fetch stays in the general queue: in the read lane it slowed writes by about half while a
    // follower ran (bench, Nov 28), and the follower still catches up within milliseconds of the last write.
    expect(seen.has('readCommitLogRaw')).toBe(false);
    const position = await readIndexBehindWrites('p', () => storePositionReader(engine)());
    expect(position.index).toBeLessThanOrEqual(4);
  });

  test('writes finish while reads keep the read lane and every idle worker busy', async () => {
    // 32 readers send a new read the moment the last one answers, so reads wait in the lane for the whole test.
    let writing = true;
    let readsDuringWrites = 0;
    let queuedReads = 0;
    const lane = pool as PoolView & { queuedReads?: number };
    const readers = Array.from({ length: 32 }, async () => {
      while (writing) {
        const read = engine.listPages({ limit: 500 } as never);
        queuedReads = Math.max(queuedReads, lane.queuedReads ?? 0);
        await read;
        readsDuringWrites += 1;
      }
    });
    await Bun.sleep(20);
    const started = performance.now();
    await Promise.all(Array.from({ length: WRITES }, (_, i) => engine.putPage(`notes/flood-${i}`, page(`flood-${i}`) as never)));
    const writeMs = performance.now() - started;
    writing = false;
    await Promise.all(readers);
    // A general worker takes a waiting write before a waiting read: reads that always wait cannot hold writes back.
    expect(queuedReads).toBeGreaterThan(0);
    expect(readsDuringWrites).toBeGreaterThan(WRITES);
    expect(writeMs).toBeLessThan(5_000);
  });

  test('a read inside a transaction sees the write that transaction has not committed yet', async () => {
    await engine.transaction(async (tx) => {
      await tx.putPage('notes/in-tx', page('in-tx') as never);
      const seen = await tx.getPage('notes/in-tx');
      expect(seen?.title).toBe('in-tx');
    });
    expect((await engine.getPage('notes/in-tx'))?.title).toBe('in-tx');
  });
});
