/**
 * Shadow follow with the real Rust addon on a PGLite primary (src/shadow/follower.ts, follow-child.ts, reconcile.ts):
 * scenarios in test/helpers/shadow-follow-scenarios.ts. Postgres twin: test/e2e/shadow-follow.test.ts.
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes it an error).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { attachShadowParts } from '../src/shadow/attach.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import { readFollowerFile } from '../src/shadow/follow-status.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { readPasses } from '../src/shadow/follow-status.ts';
import { writeSeedRecord } from '../src/shadow/seed.ts';
import { shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';
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
      attached.supervisor.stop(); // ends the child's stdin: it applies what it holds, writes a clean stop and exits
      attached.reconciler!.stop();
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && readFollowerFile(home)?.clean_stop !== true) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readFollowerFile(home)).toMatchObject({ clean_stop: true, applied_rows: expect.any(Number) });
      expect(readFollowerFile(home)!.applied_rows).toBeGreaterThan(0);
    });
    const rust = openRustEngine({ addon, databasePath: join(home, 'store') });
    await rust.connect({ engine: 'pglite', database_path: join(home, 'store') } as never);
    try { expect((await rust.getPage('people/dora-example'))?.title).toBe('Dora Example'); } finally { await rust.disconnect(); }
  }, 120_000);
});
