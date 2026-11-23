/**
 * Shadow follow with the real Rust addon on a PGLite primary (src/shadow/follower.ts, follow-child.ts, reconcile.ts):
 * scenarios in test/helpers/shadow-follow-scenarios.ts. Postgres twin: test/e2e/shadow-follow.test.ts.
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes it an error).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { attachShadowParts } from '../src/shadow/attach.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import { FollowChild } from '../src/shadow/follow-child.ts';
import { readFollowerFile } from '../src/shadow/follow-status.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { readPasses } from '../src/shadow/follow-status.ts';
import { readSeedRecord, writeSeedRecord, type SeedRecord } from '../src/shadow/seed.ts';
import { shadowBrainKey, shadowDirFor, type ShadowState } from '../src/shadow/state.ts';
import { fillSeedFixture, seedInto } from './helpers/shadow-seed-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { defineFollowScenarios } from './helpers/shadow-follow-scenarios.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

let primary: PGLiteEngine;
let addon: RustAddon;
const dirs: string[] = [];

const STOP_COMMAND = 'gbrain engine shadow stop --delete';
const ON = { version: 1, enabled: true, started_at: 'x', sample_rate: 0, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' } as unknown as ShadowState;
/** The record a seed wrote before follow existed: no `digests` field, and a store with no digest entries. */
const legacyRecord = (seed: SeedRecord): SeedRecord => { const { digests: _digests, ...rest } = seed; return rest as SeedRecord; };
const sampleRecord = (): SeedRecord => ({
  version: 1, seed_id: 'seed-legacy', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', primary_engine: 'pglite',
  relations: {}, losses: { values: {}, not_copied: [], gaps: {} }, unseeded_gap_rows: {}, unseeded_gap_rows_total: 0, non_terminal_jobs: 0, segmented_pages: 0, digests: true,
});
const capture = () => { const out: string[] = []; const err: string[] = []; return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }; };

// These need no addon, so the stress gate (which has none) still runs them.
describe('a seed written before shadow follow existed', () => {
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  async function inLegacyBrain(fn: (dir: string, deps: { config: () => { engine: 'pglite'; database_path: string } }) => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-legacy-'));
    dirs.push(home);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
      const dir = shadowDirFor(shadowBrainKey(config)!);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'seed.json'), JSON.stringify(legacyRecord(sampleRecord())));
      await fn(dir, { config: () => config });
    });
  }

  test('status says plainly that the brain needs a reseed and gives the commands, in markdown and in --json', async () => {
    await inLegacyBrain(async (_dir, deps) => {
      const json = capture();
      expect(await runEngineShadow(['status', '--json'], { ...deps, ...json.deps })).toBe(0);
      const follower = JSON.parse(json.out.join('\n')).follower;
      expect(follower.state).toBe('needs_reseed');
      expect(follower.action).toContain(STOP_COMMAND);
      expect(follower.action).toContain('gbrain engine shadow seed');
      const md = capture();
      expect(await runEngineShadow(['status'], { ...deps, ...md.deps })).toBe(0);
      const text = md.out.join('\n');
      expect(text).toContain('needs a reseed');
      expect(text).toContain(STOP_COMMAND);
    });
  });

  test('reconcile refuses it with the same commands instead of failing quietly', async () => {
    await inLegacyBrain(async (_dir, deps) => {
      const run = capture();
      expect(await runEngineShadow(['reconcile'], { ...deps, ...run.deps })).toBe(1);
      expect(run.err.join('\n')).toContain(STOP_COMMAND);
    });
  });

  test('follow does not run: no follower, no reconciler, and the child keeps no follower file', async () => {
    await inLegacyBrain(async (dir) => {
      const engine = { registerBeforeDisconnect: () => {} } as never;
      const attached = attachShadowParts(engine, dir, ON, { gbrainArgv: ['unused'] });
      expect(attached.follower).toBeUndefined();
      expect(attached.reconciler).toBeUndefined();
      const child = new FollowChild({ dir, store: async () => { throw new Error('no store'); }, owner: () => true, writeControl: () => {} });
      child.tick();
      await child.close();
      expect(readFollowerFile(dir)).toBeNull();
      expect(readSeedRecord(dir)?.digests).toBeUndefined();
    });
  });
});

(HAVE_ADDON ? describe : describe.skip)('shadow follow on PGLite', () => {
  beforeAll(async () => {
    primary = new PGLiteEngine();
    await primary.connect({});
    await primary.initSchema();
    addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  });
  afterAll(async () => { await primary.disconnect(); });
  beforeEach(async () => { await resetPgliteState(primary); });
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  defineFollowScenarios({
    primary: () => primary, addon: () => addon, kind: 'pglite',
    tempDir: () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-follow-')); dirs.push(dir); return dir; },
  });

  test('gbrain engine shadow reconcile runs a full pass through a real child and repairs a changed row', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-reconcile-'));
    dirs.push(home);
    await fillSeedFixture(primary);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT }, async () => {
      const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
      const dir = shadowDirFor(shadowBrainKey(config)!);
      const { record } = await seedInto(primary, addon, dir, 'pglite');
      writeSeedRecord(dir, record);
      await primary.executeRaw(`UPDATE pages SET title = 'Changed Before Reconcile' WHERE slug = 'people/alice-example'`);
      const keep = Object.create(primary, { disconnect: { value: async () => {} } }) as PGLiteEngine;
      const out: string[] = [];
      const err: string[] = [];
      const code = await runEngineShadow(['reconcile', '--json'], {
        config: () => config, openPrimary: async () => keep, out: (l) => out.push(l), err: (l) => err.push(l),
        reconcileSupervisor: { argv: [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), 'engine', 'shadow', '__child', dir] },
      });
      expect(err).toEqual([]);
      expect(code).toBe(0);
      const pass = JSON.parse(out.join('\n'));
      expect(pass).toMatchObject({ kind: 'full', repaired_rows: 1, repaired_by_relation: { pages: 1 } });
      expect(readPasses(dir)).toHaveLength(1);
    });
  }, 120_000);

  test('a seeded brain is followed by default: writes through the attached engine reach the store via the real child', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-attach-'));
    dirs.push(home);
    await fillSeedFixture(primary);
    const { record } = await seedInto(primary, addon, home, 'pglite');
    writeSeedRecord(home, record);
    const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 0, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' };
    await withEnv({ GBRAIN_RUST_ENGINE_ADDON: BUILT }, async () => {
      const attached = attachShadowParts(primary, home, state as never, { gbrainArgv: [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts')] });
      expect(attached.follower).toBeDefined();
      await attached.engine.putPage('people/dora-example', { type: 'person', title: 'Dora Example', compiled_truth: 'Dora.', timeline: '' });
      await attached.follower!.settle();
      attached.supervisor.stop(); // ends the child's stdin: it applies what it holds, writes its status and exits
      attached.reconciler!.stop();
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !(readFollowerFile(home)?.applied_rows ?? 0)) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readFollowerFile(home)!.applied_rows).toBeGreaterThan(0);
    });
    const rust = openRustEngine({ addon, databasePath: join(home, 'store') });
    await rust.connect({ engine: 'pglite', database_path: join(home, 'store') } as never);
    try { expect((await rust.getPage('people/dora-example'))?.title).toBe('Dora Example'); } finally { await rust.disconnect(); }
  }, 120_000);

  test('a brain seeded before follow is reseeded end to end: status says so, stop --delete and seed work, and then follow runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-reseed-'));
    dirs.push(home);
    await fillSeedFixture(primary);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT }, async () => {
      const config = { engine: 'pglite' as const, database_path: join(home, 'brain.pglite') };
      const dir = shadowDirFor(shadowBrainKey(config)!);
      const { record } = await seedInto(primary, addon, dir, 'pglite');
      writeSeedRecord(dir, legacyRecord(record));
      const keep = Object.create(primary, { disconnect: { value: async () => {} } }) as PGLiteEngine;
      const deps = { config: () => config, openPrimary: async () => keep };
      const status = capture();
      expect(await runEngineShadow(['status', '--json'], { ...deps, ...status.deps })).toBe(0);
      expect(JSON.parse(status.out.join('\n')).follower.state).toBe('needs_reseed');
      expect(attachShadowParts(primary, dir, ON, { gbrainArgv: ['unused'] }).follower).toBeUndefined();
      const again = capture();
      expect(await runEngineShadow(['seed'], { ...deps, ...again.deps })).toBe(1);
      expect(again.err.join('\n')).toContain(STOP_COMMAND);
      const stop = capture();
      expect(await runEngineShadow(['stop', '--delete'], { ...deps, ...stop.deps })).toBe(0);
      expect(existsSync(dir)).toBe(false);
      const seeded = capture();
      expect(await runEngineShadow(['seed'], { ...deps, ...seeded.deps })).toBe(0);
      expect(seeded.err.filter((l) => !l.includes('seeding '))).toEqual([]);
      expect(readSeedRecord(dir)?.digests).toBe(true);
      const attached = attachShadowParts(primary, dir, ON, { gbrainArgv: [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts')] });
      try {
        expect(attached.follower).toBeDefined();
        await attached.engine.putPage('people/erin-example', { type: 'person', title: 'Erin Example', compiled_truth: 'Erin.', timeline: '' });
        await attached.follower!.settle();
      } finally {
        attached.supervisor.stop();
        attached.reconciler?.stop();
      }
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !(readFollowerFile(dir)?.applied_rows ?? 0)) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readFollowerFile(dir)!.applied_rows).toBeGreaterThan(0);
      const rust = openRustEngine({ addon, databasePath: join(dir, 'store') });
      await rust.connect({ engine: 'pglite', database_path: join(dir, 'store') } as never);
      try { expect((await rust.getPage('people/erin-example'))?.title).toBe('Erin Example'); } finally { await rust.disconnect(); }
    });
  }, 180_000);
});
