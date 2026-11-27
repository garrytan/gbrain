/**
 * The engine swap run (PR S5b, src/core/engine-swap/run.ts) on a real PGLite primary and a real seeded Rust store.
 *
 * Authoring gate (docs/TESTING.md): (1) protects a brain moving to the Rust engine: every acknowledged write reaches
 * the Rust store, the old engine is fenced, and authority never points at an engine that was not verified. (2) Fails
 * when a state is skipped or reordered, when a kill, a full disk, a failed digest or a failed route probe leaves
 * authority on Rust or loses a write, when `--resume` cannot finish a stopped run, or when the fence lets a write
 * through. (3) Nothing else runs a swap. (4) Seams: the shadow child's RPC runs in process (test/helpers/follow-rig.ts),
 * the route probe is injected (a fresh process cannot open a store this process holds), and the record's filesystem
 * calls are replaced to inject a full disk; the primary, the store, the reconcile and the digests are real.
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes it an error).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openReadSource } from '../src/shadow/read-pool.ts';
import { runSwapStates, startRecord, type SwapRunDeps } from '../src/core/engine-swap/run.ts';
import { readSwapRecord, REAL_FS, type SwapFs, type SwapState } from '../src/core/engine-swap/record.ts';
import { primaryFenced } from '../src/core/engine-swap/fence.ts';
import { planFailback, runFailback, verifyFailback } from '../src/core/engine-swap/failback.ts';
import { readGraduationRow } from '../src/core/persistence/graduation-schema.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { fillSeedFixture } from './helpers/shadow-seed-fixture.ts';
import { openFollowRig, type FollowRig } from './helpers/follow-rig.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

interface World { home: string; primary: PGLiteEngine; rig: FollowRig; addon: RustAddon; dbPath: string; deps: SwapRunDeps }
const dirs: string[] = [];
let world: World | null = null;

async function open(over: Partial<SwapRunDeps> = {}): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-swap-run-'));
  dirs.push(home);
  const dbPath = join(home, '.gbrain', 'brain.pglite');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath }));
  const primary = new PGLiteEngine();
  await primary.connect({ engine: 'pglite', database_path: dbPath });
  await primary.initSchema();
  await fillSeedFixture(primary);
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const shadowDir = join(home, 'shadow');
  const rig = await openFollowRig(primary, addon, shadowDir, 'pglite');
  const reads = openReadSource(primary, { pauseMs: 0 });
  const deps: SwapRunDeps = {
    primary, config: { engine: 'pglite', database_path: dbPath } as never, brainKey: 'pglite-test', shadowDir,
    rustStore: join(shadowDir, 'store'), hostId: '00000000-0000-4000-8000-000000000001',
    openRust: async () => ({ rpc: rig.rpc, reads, close: async () => undefined }),
    prober: async () => ({ effective_engine: 'rust', database_path: join(shadowDir, 'store'), ok: true }),
    routeCheck: () => null,
    recordPath: join(home, '.gbrain', 'engine-swap', 'pglite-test', 'run.json'),
    intervalRows: 2,
    ...over,
  };
  world = { home, primary, rig, addon, dbPath, deps };
  return world;
}

/** Runs with GBRAIN_HOME pointing at the world, so the authority switch rewrites its config file. */
function inHome<T>(w: World, fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: w.home }, fn);
}

const configEngine = (w: World): string => JSON.parse(readFileSync(join(w.home, '.gbrain', 'config.json'), 'utf8')).engine;

async function expectRefused(p: Promise<unknown>, reason: string): Promise<void> {
  const error = await p.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(OperationError);
  expect((error as OperationError).code).toBe('engine_swap_refused');
  expect((error as OperationError).reason).toBe(reason);
}

(HAVE_ADDON ? describe : describe.skip)('engine swap run on PGLite', () => {
  beforeEach(() => { world = null; });
  afterEach(async () => {
    if (world) { await world.rig.close().catch(() => undefined); await world.primary.disconnect().catch(() => undefined); }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('a run checkpoints, fences, verifies, switches and probes; a write after the seed reaches the store', async () => {
    const w = await open();
    // Written after the seed and never followed: only the final reconcile behind the fence can carry it.
    await w.primary.putPage('notes/late-example', { type: 'note', title: 'Late', compiled_truth: 'Written after the seed.', timeline: '' });
    const done = await inHome(w, async () => runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps));
    expect(done.state).toBe('succeeded');
    expect(done.error).toBeNull();
    expect(done.checkpoint!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(done.fence!.tables).toBeGreaterThan(10);
    expect(done.verify!.passes[1]!.repaired_rows).toBe(0);
    expect(done.verify!.digests.find(d => d.relation === 'pages')!.rows).toBe(3);
    expect(done.verify!.allocators.every(a => a.ok)).toBe(true);
    expect(configEngine(w)).toBe('rust');
    expect(readSwapRecord(w.deps.recordPath)!.state).toBe('succeeded');
    // The late page is in the Rust store, and the old engine refuses writes: only the run can pass its fence.
    expect((await w.rig.rust.getPage('notes/late-example'))?.title).toBe('Late');
    expect(await primaryFenced(w.primary, done.run_id)).toBe(true);
    const write = await w.primary.putPage('notes/after-example', { type: 'note', title: 'After', compiled_truth: 'x', timeline: '' }).then(() => null, e => e);
    expect(String((write as Error)?.message)).toContain('graduation_in_progress');
  }, 120_000);

  for (const at of ['checkpointed', 'fenced', 'verified', 'switched'] as SwapState[]) {
    test(`a kill before ${at} leaves authority on the old engine, and --resume finishes the run`, async () => {
      let armed = true;
      const w = await open({ beforeState: (s) => { if (armed && s === at) { armed = false; throw new Error('killed'); } } });
      const first = await inHome(w, async () => runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps).then(() => null, e => e));
      expect(String((first as Error).message)).toBe('killed');
      const stopped = readSwapRecord(w.deps.recordPath)!;
      expect(stopped.state).toBe(at);
      // Before the switch is recorded, the config still names the old engine.
      if (at !== 'switched') expect(configEngine(w)).toBe('pglite');
      // Before the fence, the old primary still takes writes.
      if (at === 'checkpointed') await w.primary.putPage('notes/before-fence', { type: 'note', title: 'Before', compiled_truth: 'ok', timeline: '' });
      const done = await inHome(w, async () => runSwapStates(stopped, w.deps));
      expect(done.state).toBe('succeeded');
      expect(configEngine(w)).toBe('rust');
      if (at === 'checkpointed') expect((await w.rig.rust.getPage('notes/before-fence'))?.title).toBe('Before');
    }, 120_000);
  }

  test('a full disk while recording the checkpoint stops the run before the fence, and --resume finishes it', async () => {
    let fail = true;
    const fs: SwapFs = { ...REAL_FS, rename: (from, to) => { if (fail && to.endsWith('run.json')) { const r = readFileSync(from, 'utf8'); if (r.includes('"checkpointed"')) { fail = false; throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } } REAL_FS.rename(from, to); } };
    const w = await open({ fs });
    const first = await inHome(w, async () => runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps).then(() => null, e => e));
    expect((first as { code?: string }).code).toBe('ENOSPC');
    expect(readSwapRecord(w.deps.recordPath)!.state).toBe('planned');
    expect(await primaryFenced(w.primary, readSwapRecord(w.deps.recordPath)!.run_id)).toBe(false);
    // The unrecorded checkpoint file is replaced, never trusted; the resume finishes the run.
    expect(configEngine(w)).toBe('pglite');
    const done = await inHome(w, async () => runSwapStates(readSwapRecord(w.deps.recordPath)!, w.deps));
    expect(done.state).toBe('succeeded');
  }, 120_000);

  test('a failed final digest keeps the old authority and the fence, and is resumable', async () => {
    let lie = true;
    const w = await open();
    const honest = w.deps.openRust;
    w.deps.openRust = async () => {
      const side = await honest();
      return { ...side, rpc: async <T>(method: string, args?: Record<string, unknown>, ms?: number): Promise<T> => {
        const value = await side.rpc<T>(method, args, ms);
        if (lie && method === 'relationDigest' && args?.lo === null && args?.hi === null && args?.relation === 'pages') return { ...(value as object), digest: '00' } as T;
        return value;
      } };
    };
    await inHome(w, async () => expectRefused(runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps), 'digest_mismatch'));
    const stopped = readSwapRecord(w.deps.recordPath)!;
    expect(stopped.state).toBe('fenced');
    expect(stopped.error).toMatchObject({ code: 'digest_mismatch', reason: 'digest_mismatch', state: 'fenced' });
    expect(configEngine(w)).toBe('pglite');
    expect(await primaryFenced(w.primary, stopped.run_id)).toBe(true);
    lie = false;
    expect((await inHome(w, async () => runSwapStates(stopped, w.deps))).state).toBe('succeeded');
  }, 120_000);

  test('a failed route probe undoes the switch at once, so authority never points at an unverified engine', async () => {
    let ok = false;
    const w = await open({ prober: async () => ({ effective_engine: ok ? 'rust' : 'pglite', database_path: ok ? join(world!.deps.shadowDir, 'store') : world!.dbPath, ok: true }) });
    await inHome(w, async () => expectRefused(runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps), 'verification_incomplete'));
    const stopped = readSwapRecord(w.deps.recordPath)!;
    expect(stopped.state).toBe('verified');
    expect(stopped.error?.code).toBe('route_probe_failed');
    expect(configEngine(w)).toBe('pglite');
    ok = true;
    expect((await inHome(w, async () => runSwapStates(stopped, w.deps))).state).toBe('succeeded');
    expect(configEngine(w)).toBe('rust');
  }, 120_000);

  test('a checkpoint changed after it was written is never trusted', async () => {
    let armed = true;
    const w = await open({ beforeState: (s) => { if (armed && s === 'checkpointed') { armed = false; throw new Error('killed'); } } });
    await inHome(w, async () => runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps).then(() => null, () => null));
    const stopped = readSwapRecord(w.deps.recordPath)!;
    writeFileSync(stopped.checkpoint!.path, 'tampered');
    await inHome(w, async () => expectRefused(runSwapStates(stopped, w.deps), 'verification_incomplete'));
    expect(readSwapRecord(w.deps.recordPath)!.error?.code).toBe('checkpoint_changed');
    expect(await primaryFenced(w.primary, stopped.run_id)).toBe(false);
  }, 120_000);

  test('a route override found before the switch refuses it and changes nothing', async () => {
    const w = await open();
    const { routeOverrideRefusal } = await import('../src/core/engine-swap/route.ts');
    w.deps.routeCheck = () => routeOverrideRefusal(['DATABASE_URL'], []);
    await inHome(w, async () => expectRefused(runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps), 'route_override'));
    expect(readSwapRecord(w.deps.recordPath)!.state).toBe('verified');
    expect(configEngine(w)).toBe('pglite');
  }, 120_000);
  test('swap, write on the Rust engine, failback: the writes reach the old primary and both engines read the same', async () => {
    const w = await open();
    const done = await inHome(w, async () => runSwapStates(startRecord(w.deps, 'planhash', 'policyhash'), w.deps));
    expect(done.state).toBe('succeeded');
    // Writes served by the real Rust engine after the swap: an edit, a new page with a tag and a timeline entry, a key.
    const rust = w.rig.rust;
    await rust.putPage('notes/late-example', { type: 'note', title: 'Late', compiled_truth: 'Edited on the Rust engine.', timeline: '' });
    await rust.putPage('notes/rust-only-example', { type: 'note', title: 'Rust only', compiled_truth: 'Made on the Rust engine.', timeline: '' });
    await rust.setConfig('example.failback', 'from-rust');
    const failback = {
      primary: w.primary, rust, recordPath: w.deps.recordPath, brainKey: 'pglite-test', runDir: join(w.home, '.gbrain', 'engine-swap', 'pglite-test'),
      writers: async () => null,
      prober: async () => ({ effective_engine: 'pglite', database_path: w.dbPath, ok: true }),
    };
    const plan = await inHome(w, () => planFailback(failback));
    expect(plan.pages.changed + plan.pages.added).toBeGreaterThanOrEqual(1);
    const back = await inHome(w, () => runFailback(failback, plan.plan_hash));
    expect(back.failback!.state).toBe('succeeded');
    expect((await verifyFailback(rust, w.primary)).mismatches).toEqual([]);
    expect((await w.primary.getPage('notes/late-example'))!.compiled_truth).toBe('Edited on the Rust engine.');
    expect(await w.primary.getConfig('example.failback')).toBe('from-rust');
    expect(configEngine(w)).toBe('pglite');
    expect((await readGraduationRow(w.primary))!.state).toBe('rolled_back');
  }, 180_000);
});
