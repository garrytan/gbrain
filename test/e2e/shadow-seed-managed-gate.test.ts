/**
 * Postgres twin of test/shadow-seed-managed-gate.test.ts: `gbrain engine shadow seed` on a managed-storage Postgres brain.
 *
 * Protects: a Postgres brain with persistence_brain.enabled = true is seeded by `seed` and `seed --json` (exit 0) through
 * the REPEATABLE READ snapshot, prints "this brain cannot swap while it uses managed storage" and records
 * `storage: { managed: true, checked_at }` in seed.json; an unmanaged brain records `false`; a mode that cannot be read
 * records `null` with a reason code and does not block the seed. The seed leaves the primary untouched: every
 * `persistence_*` row and the content root are byte-identical before and after. Nothing emits `engine_swap_refused`.
 * Regression it catches: a seed that refuses over the storage mode only on Postgres, or that writes to the primary.
 * Needs DATABASE_URL (GBRAIN_TEST_ALLOW_DATABASE_URL=1); the tests that seed also need the addon `bun run rust:build` writes
 * and skip without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error). The test that a seed without the
 * addon fails with the addon's named error and writes nothing needs no addon, so this file always runs against the database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineShadow } from '../../src/commands/engine-shadow.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { loadRustAddon, loadRustEngineAddon, type RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';
import { readSeedRecord } from '../../src/shadow/seed.ts';
import { shadowBrainKey, shadowDirFor } from '../../src/shadow/state.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { snapshotPersistence, snapshotTree } from '../helpers/primary-snapshot.ts';
import { fillSeedFixture } from '../helpers/shadow-seed-fixture.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase } from './helpers.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const d = hasDatabase() ? describe : describe.skip;
const withAddon = test.skipIf(!HAVE_ADDON);

const LINE = 'this brain cannot swap while it uses managed storage';
const NOW = new Date('2026-03-04T05:06:07.000Z');

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
let addon: RustAddon;
let contentRoot: string;
const homes: string[] = [];

async function seedCommand(args: string[], open?: () => Promise<BrainEngine>, load?: () => ReturnType<typeof loadRustEngineAddon>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-gate-pg-'));
  homes.push(home);
  const config = { engine: 'postgres' as const, database_url: 'postgresql://example.invalid/brain' };
  const r = { code: -1, out: [] as string[], err: [] as string[], dir: '' };
  const watched = Object.create(engine, { disconnect: { value: async () => undefined } }) as BrainEngine;
  await withEnv({ GBRAIN_HOME: home }, async () => {
    r.dir = shadowDirFor(shadowBrainKey(config)!);
    r.code = await runEngineShadow(args, {
      config: () => config, out: l => r.out.push(l), err: l => r.err.push(l), now: () => NOW,
      loadAddon: load ?? (async () => ({ ok: true as const, addon })), openPrimary: open ?? (async () => watched),
    });
  });
  return { ...r, text: [...r.out, ...r.err].join('\n') };
}

d('engine shadow seed on a Postgres brain', () => {
  beforeAll(async () => {
    template = await persistencePostgresTemplate(process.env.DATABASE_URL!);
    if (HAVE_ADDON) addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => {
    ({ engine, close } = await template.clone());
    contentRoot = mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-content-pg-'));
    homes.push(contentRoot);
    mkdirSync(join(contentRoot, 'people'), { recursive: true });
    writeFileSync(join(contentRoot, 'people', 'a.md'), '# a\n');
  }, 60_000);
  afterEach(async () => { await close(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

  test('without the Rust addon the seed of a managed brain fails with the addon error and writes nothing: no shadow directory, no seed.json, primary unchanged', async () => {
    // Runs with or without the addon built: the seed asks for a build that does not exist.
    await fillSeedFixture(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = { tables: await snapshotPersistence(engine), files: snapshotTree(contentRoot) };
    const missing = join(contentRoot, 'no-such-addon.node');
    const r = await seedCommand(['seed'], undefined, () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: missing } }));
    expect(r.code, r.text).toBe(1);
    expect(r.err[0]).toMatch(/^engine shadow: rust_engine_addon_(missing|mismatch) \(/);
    expect(r.text).not.toContain('engine_swap_refused');
    expect(r.out).toEqual([]);
    expect(existsSync(r.dir)).toBe(false);
    expect(readSeedRecord(r.dir)).toBeNull();
    expect(await snapshotPersistence(engine)).toEqual(before.tables);
    expect(snapshotTree(contentRoot)).toEqual(before.files);
  }, 120_000);

  withAddon('a managed brain is seeded by seed and seed --json, records managed: true, and the primary is byte-identical', async () => {
    await fillSeedFixture(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = { tables: await snapshotPersistence(engine), files: snapshotTree(contentRoot) };
    expect(before.tables.persistence_brain!.some(r => r.includes('"enabled":true'))).toBe(true);
    for (const args of [['seed'], ['seed', '--json']]) {
      const r = await seedCommand(args);
      expect(r.code, `${args.join(' ')}: ${r.text}`).toBe(0);
      expect(r.text).not.toContain('engine_swap_refused');
      const rec = readSeedRecord(r.dir)!;
      expect(rec.storage).toEqual({ managed: true, checked_at: NOW.toISOString() });
      expect(rec.primary_engine).toBe('postgres');
      expect(rec.relations.pages?.imported).toBe(2);
      if (args.includes('--json')) expect(JSON.parse(r.out.join('\n')).storage).toEqual({ managed: true, checked_at: NOW.toISOString() });
      else expect(r.out).toContain(`  storage: ${LINE}`);
      expect(await snapshotPersistence(engine), args.join(' ')).toEqual(before.tables);
      expect(snapshotTree(contentRoot), args.join(' ')).toEqual(before.files);
    }
  }, 180_000);

  withAddon('an unmanaged brain records managed: false and prints no storage line', async () => {
    await fillSeedFixture(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const r = await seedCommand(['seed']);
    expect(r.code, r.text).toBe(0);
    expect(r.text).not.toContain('storage:');
    expect(readSeedRecord(r.dir)?.storage).toEqual({ managed: false, checked_at: NOW.toISOString() });
  }, 120_000);

  withAddon('a mode that cannot be read does not block the seed and records null with a reason code', async () => {
    await fillSeedFixture(engine);
    let calls = 0; // only the first raw query (the mode read before the snapshot) fails
    const failing = async () => Object.create(engine, {
      executeRaw: { value: (...a: unknown[]) => {
        if (calls++ > 0) return (engine.executeRaw as (...x: unknown[]) => unknown)(...a);
        throw Object.assign(new Error('terminating connection'), { code: 'connection_failure' });
      } },
      disconnect: { value: async () => undefined },
    }) as BrainEngine;
    const r = await seedCommand(['seed'], failing);
    expect(r.code, r.text).toBe(0);
    expect(r.text).not.toContain('engine_swap_refused');
    expect(readSeedRecord(r.dir)?.storage).toEqual({ managed: null, checked_at: NOW.toISOString(), reason: 'connection_failure' });
  }, 120_000);
});
