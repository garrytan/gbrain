/**
 * The engine swap run, end to end, on a real Postgres 17 primary whose text sorts in an ICU locale (en-US), with the
 * real Rust store and addon: swap, write on Rust, fail back (src/core/engine-swap/run.ts, failback.ts).
 *
 * Authoring gate (docs/TESTING.md): (1) protects a Postgres brain moving to the Rust engine and back: every write
 * acknowledged before the fence reaches the Rust store, including one in flight while the fence lands; no write is
 * acknowledged after the fence; the pg_dump checkpoint is real; the database URL leaves the config and comes back;
 * and failback brings the Rust writes home with both engines reading the same. (2) Fails when the fence lets a write
 * through, loses a write that committed while it waited, records a checkpoint that does not list every table, leaves
 * the database URL in the record or the config after the switch, or when failback loses a Rust write. (3)
 * test/engine-swap-run.serial.test.ts and test/engine-swap-kill.serial.test.ts run on PGLite only; the Postgres unit
 * files (engine-swap-pg-*.test.ts) never run a whole swap. (4) Seams: the shadow child's RPC runs in process
 * (test/helpers/follow-rig.ts) and the route probe is injected; the primary, pg_dump, the store, the reconcile, the
 * digests, the fence and failback are real. Needs DATABASE_URL (a disposable Postgres) and the addon; skips without them
 * (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openReadSource } from '../src/shadow/read-pool.ts';
import { runSwapStates, startRecord, type SwapRunDeps } from '../src/core/engine-swap/run.ts';
import { readSwapRecord } from '../src/core/engine-swap/record.ts';
import { primaryFenced } from '../src/core/engine-swap/fence.ts';
import { SYSTEM_PG_TOOLS } from '../src/core/engine-swap/pg-checkpoint.ts';
import { planFailback, runFailback, verifyFailback } from '../src/core/engine-swap/failback.ts';
import { readGraduationRow } from '../src/core/persistence/graduation-schema.ts';
import { fillSeedFixture } from './helpers/shadow-seed-fixture.ts';
import { openFollowRig, type FollowRig } from './helpers/follow-rig.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const URL_ = process.env.DATABASE_URL;

interface World { home: string; primary: PostgresEngine; url: string; rig: FollowRig; deps: SwapRunDeps; close: () => Promise<void> }
let world: World | null = null;
const homes: string[] = [];

async function open(): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-swap-pg-'));
  homes.push(home);
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const db = await isolatedPersistencePostgres(URL_!, 'instance', 4, { collation: 'icu-en-US' });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: db.databaseUrl }), { mode: 0o600 });
  await fillSeedFixture(db.engine);
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const shadowDir = join(home, 'shadow');
  const rig = await openFollowRig(db.engine, addon, shadowDir, 'postgres');
  const reads = openReadSource(db.engine, { pauseMs: 0 });
  const deps: SwapRunDeps = {
    primary: db.engine, config: { engine: 'postgres', database_url: db.databaseUrl } as never, brainKey: 'postgres-test', shadowDir,
    rustStore: join(shadowDir, 'store'), hostId: '00000000-0000-4000-8000-000000000002',
    openRust: async () => ({ rpc: rig.rpc, reads, close: async () => undefined }),
    prober: async () => ({ effective_engine: 'rust', database_path: join(shadowDir, 'store'), ok: true }),
    routeCheck: () => null,
    recordPath: join(home, '.gbrain', 'engine-swap', 'postgres-test', 'run.json'),
    intervalRows: 2,
    postgres: { url: db.databaseUrl, tools: SYSTEM_PG_TOOLS },
  };
  world = { home, primary: db.engine, url: db.databaseUrl, rig, deps, close: async () => { await reads.close().catch(() => undefined); await rig.close().catch(() => undefined); await db.close(); } };
  return world;
}

const inHome = <T>(w: World, fn: () => Promise<T>): Promise<T> => withEnv({ GBRAIN_HOME: w.home }, fn);
const config = (w: World): Record<string, unknown> => JSON.parse(readFileSync(join(w.home, '.gbrain', 'config.json'), 'utf8'));
const slugs = async (e: { executeRaw: (sql: string) => Promise<Array<{ slug: string }>> }): Promise<string[]> =>
  (await e.executeRaw(`SELECT slug FROM pages WHERE deleted_at IS NULL ORDER BY slug COLLATE "C"`)).map(r => r.slug);
const rustSlugs = async (w: World): Promise<string[]> =>
  (await (w.rig.rust as unknown as { listAllPageRefs(): Promise<Array<{ slug: string }>> }).listAllPageRefs()).map(r => r.slug).sort();

(HAVE_ADDON && URL_ ? describe : describe.skip)('engine swap run on a Postgres 17 ICU primary', () => {
  afterEach(async () => {
    if (world) await world.close().catch(() => undefined);
    world = null;
    for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
  });

  test('a full run: pg_dump checkpoint, fence, verify, switch; the database URL leaves the config and never enters the record', async () => {
    const w = await open();
    await w.primary.putPage('notes/late-example', { type: 'note', title: 'Late', compiled_truth: 'Written after the seed.', timeline: '' });
    const done = await inHome(w, async () => runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps));
    expect(done.state).toBe('succeeded');
    expect(done.checkpoint!.path.endsWith('.dump')).toBe(true);
    expect(done.checkpoint!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(done.verify!.allocators.every(a => a.ok)).toBe(true);
    expect(config(w).engine).toBe('rust');
    expect(config(w).database_url).toBeUndefined();
    expect(readFileSync(w.deps.recordPath, 'utf8')).not.toContain(w.url);
    expect(await rustSlugs(w)).toEqual(await slugs(w.primary as never));
    expect(await primaryFenced(w.primary, done.run_id)).toBe(true);
    // Only the run passes the fence: a plain session on the same database is refused.
    const other = postgres(w.url, { max: 1 });
    try {
      const refused = await other`INSERT INTO config (key, value) VALUES ('example.after-fence', 'x')`.then(() => null, (e: unknown) => e);
      expect(String((refused as Error)?.message)).toContain('graduation_in_progress');
    } finally { await other.end(); }
  }, 300_000);

  test('a write in flight while the fence lands either commits and reaches Rust, or is refused; none is acknowledged and lost', async () => {
    const w = await open();
    // A second writer holds an open transaction that writes a page, so the fence must wait for (or refuse) it.
    const writer = postgres(w.url, { max: 1 });
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    let acknowledged = false;
    const inflight = writer.begin(async (tx) => {
      await tx`INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter) VALUES ('notes/in-flight-example', 'default', 'note', 'In flight', 'Committed while the fence waited.', '', '{}'::jsonb)`;
      await held;
    }).then(() => { acknowledged = true; }, () => { acknowledged = false; });
    await new Promise(r => setTimeout(r, 200));
    const run = inHome(w, async () => runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps));
    await new Promise(r => setTimeout(r, 1_000));
    release();
    await inflight;
    await writer.end();
    const done = await run;
    expect(done.state).toBe('succeeded');
    const onPrimary = (await slugs(w.primary as never)).includes('notes/in-flight-example');
    const onRust = (await rustSlugs(w)).includes('notes/in-flight-example');
    // Acknowledged means committed on the primary, and a committed write before the fence is carried to Rust.
    expect({ acknowledged, onPrimary, onRust }).toEqual(acknowledged ? { acknowledged: true, onPrimary: true, onRust: true } : { acknowledged: false, onPrimary: false, onRust: false });
    expect(await rustSlugs(w)).toEqual(await slugs(w.primary as never));
  }, 300_000);

  test('swap, write on Rust, fail back to Postgres: every Rust write reaches the primary and both engines read the same', async () => {
    const w = await open();
    const done = await inHome(w, async () => runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps));
    expect(done.state).toBe('succeeded');
    const rust = w.rig.rust;
    await rust.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Edited on the Rust engine.', timeline: '' });
    await rust.putPage('notes/rust-only-example', { type: 'note', title: 'Rust only', compiled_truth: 'Made on the Rust engine.', timeline: '' });
    await rust.setConfig('example.failback', 'from-rust');
    const failback = {
      primary: w.primary, rust, recordPath: w.deps.recordPath, brainKey: 'postgres-test', runDir: join(w.home, '.gbrain', 'engine-swap', 'postgres-test'),
      writers: async () => null,
      prober: async () => ({ effective_engine: 'postgres', database_path: null, ok: true }),
    };
    const plan = await inHome(w, () => planFailback(failback));
    expect(plan.pages).toMatchObject({ changed: 1, added: 1, removed: 0 });
    const back = await inHome(w, () => runFailback(failback, plan.plan_hash));
    expect(back.failback!.state).toBe('succeeded');
    expect((await verifyFailback(rust, w.primary)).mismatches).toEqual([]);
    expect((await w.primary.getPage('people/alice-example'))!.compiled_truth).toBe('Edited on the Rust engine.');
    expect((await w.primary.getPage('notes/rust-only-example'))!.title).toBe('Rust only');
    expect(await w.primary.getConfig('example.failback')).toBe('from-rust');
    expect(config(w)).toMatchObject({ engine: 'postgres', database_url: w.url });
    expect((await readGraduationRow(w.primary))!.state).toBe('rolled_back');
    expect(await primaryFenced(w.primary, done.run_id)).toBe(false);
  }, 300_000);
});
