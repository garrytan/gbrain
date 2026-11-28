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

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

interface PoolView { readonly queued: number; readonly running: number }
const WRITES = 16;
const page = (title: string) => ({ type: 'note', title, compiled_truth: `${title} ${'body '.repeat(200)}`, timeline: '' });

(HAVE_ADDON ? describe : describe.skip)('a read behind a burst of writes', () => {
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
    engine = openRustEngine({ addon, databasePath } as never);
    await engine.connect({ engine: 'rust', database_path: databasePath } as never);
    await engine.putPage('notes/seed', page('seed') as never);
  });

  afterAll(async () => {
    await engine?.disconnect();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('the read answers before the writes queued ahead of it have run', async () => {
    const order: string[] = [];
    const writes = Array.from({ length: WRITES }, (_, i) =>
      engine.putPage(`notes/w-${i}`, page(`w-${i}`) as never).then(() => { order.push(`w-${i}`); }));
    await Bun.sleep(0);
    // The writes are queued in the pool: more of them wait than there are workers.
    expect(pool!.queued).toBeGreaterThan(WRITES / 2);
    const read = engine.getPage('notes/seed').then((p) => { order.push('read'); return p; });
    const got = await read;
    await Promise.all(writes);
    expect(got?.title).toBe('seed');
    // Before the fix the read ran only after about WRITES - 3 writes. A read with its own lane runs at once; a few
    // writes already on a worker may still finish first.
    expect(order.indexOf('read')).toBeLessThanOrEqual(4);
  });
});
