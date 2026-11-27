/**
 * Postgres twin of test/shadow-seed.test.ts: the shadow seed (src/shadow/seed.ts) from a real Postgres primary.
 *
 * Protects: the seeded Rust store answers the same reads as the Postgres primary; the seed reads one
 * REPEATABLE READ snapshot, so a page written while the seed runs is neither copied nor counted; the seed runs in
 * a read-only transaction and leaves the primary unchanged; seed.json counts the unfinished jobs and not-copied rows.
 * Regression it catches: a seed that reads outside its snapshot (a torn copy), writes to the brain, or decodes a
 * Postgres text value (timestamps, booleans, arrays) the PGLite run never produces.
 * Needs DATABASE_URL; the tests that seed also need the addon `bun run rust:build` writes and skip without it
 * (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error). The test that a seed without the addon fails
 * with the addon's named error and writes nothing needs no addon, so this file always runs against the database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { loadRustAddon, type RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';
import { openRustStore } from '../../src/core/rust-engine/store.ts';
import { openRustEngine } from '../../src/core/rust-engine.ts';
import { runEngineShadow } from '../../src/commands/engine-shadow.ts';
import { loadRustEngineAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { readSeedRecord, runSeed } from '../../src/shadow/seed.ts';
import { shadowBrainKey, shadowDirFor } from '../../src/shadow/state.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectSeedReadParity, fillSeedFixture, insertSeedFixtureJobs, primaryDigests, seedAllowRules, seedInto } from '../helpers/shadow-seed-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const d = hasDatabase() ? describe : describe.skip;
const withAddon = test.skipIf(!HAVE_ADDON);

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
let addon: RustAddon;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-pg-'));
  dirs.push(dir);
  return dir;
}

d('shadow seed from Postgres', () => {
  beforeAll(async () => {
    template = await persistencePostgresTemplate(process.env.DATABASE_URL!);
    if (HAVE_ADDON) addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => {
    await close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('without the Rust addon the seed fails with the addon error and writes nothing: no shadow directory, no seed.json, primary unchanged', async () => {
    // Runs with or without the addon built: the seed asks for a build that does not exist.
    await fillSeedFixture(engine);
    const before = await primaryDigests(engine);
    const home = tempDir();
    const config = { engine: 'postgres' as const, database_url: 'postgresql://example.invalid/brain' };
    const out: string[] = [];
    const err: string[] = [];
    const kept = Object.create(engine, { disconnect: { value: async () => undefined } }) as PostgresEngine;
    let dir = '';
    const code = await withEnv({ GBRAIN_HOME: home }, async () => {
      dir = shadowDirFor(shadowBrainKey(config)!);
      return runEngineShadow(['seed'], {
        config: () => config, out: l => out.push(l), err: l => err.push(l), now: () => new Date('2026-03-04T05:06:07.000Z'),
        loadAddon: () => loadRustEngineAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: join(home, 'no-such-addon.node') } }),
        openPrimary: async () => kept,
      });
    });
    expect(code, [...out, ...err].join('\n')).toBe(1);
    expect(err[0]).toMatch(/^engine shadow: rust_engine_addon_(missing|mismatch) \(/);
    expect(out).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(readSeedRecord(dir)).toBeNull();
    expect(await primaryDigests(engine)).toEqual(before);
  }, 60_000);

  withAddon('the owner allow rules arrive on Rust with the same rows, ids and removed-rule receipts, and count as no gap', async () => {
    const out = await seedAllowRules(engine, addon, tempDir(), 'postgres');
    expect(out.primary.length).toBe(2);
    expect(out.primary[1]!.removed_at).not.toBeNull();
    expect(out.rust).toEqual(out.primary);
    expect(out.next).toBe(Math.max(...out.primary.map(r => r.id)) + 1);
    expect(out.record.relations.trust_allow_rules?.imported).toBe(2);
    expect(out.record.unseeded_gap_rows.trust_allow_rules ?? 0).toBe(0);
  }, 60_000);

  withAddon('the seeded store answers the same reads as the primary', async () => {
    await fillSeedFixture(engine);
    const { record, storePath } = await seedInto(engine, addon, tempDir(), 'postgres');
    expect(record.primary_engine).toBe('postgres');
    expect(record.relations.pages?.imported).toBe(2);
    await expectSeedReadParity(engine, addon, storePath);
  }, 60_000);

  withAddon('the seed reads one snapshot: a page written mid-seed is neither copied nor counted', async () => {
    await fillSeedFixture(engine);
    const storePath = join(tempDir(), 'store');
    const store = await openRustStore(addon, storePath);
    let wrote = false;
    let record;
    try {
      record = await runSeed(engine, store, {
        primaryEngine: 'postgres', batchRows: 1,
        onBatch: async relation => {
          if (relation !== 'pages' || wrote) return;
          wrote = true;
          // Another pool connection, outside the seed's transaction.
          await engine.putPage('people/late-example', { type: 'person', title: 'Late Example', compiled_truth: 'Written while the seed ran.', timeline: '' });
          await engine.addLink('people/late-example', 'companies/acme-example', 'joined', 'works_at');
        },
      });
    } finally {
      await store.close();
    }
    expect(wrote).toBe(true);
    expect(record.relations.pages?.rows_read).toBe(2);
    expect(record.relations.links?.rows_read).toBe(1);
    expect(await engine.getPage('people/late-example')).not.toBeNull();
    const rust = openRustEngine({ addon, databasePath: storePath });
    await rust.connect({ engine: 'pglite', database_path: storePath } as never);
    try {
      expect(await rust.getPage('people/late-example')).toBeNull();
      expect(await rust.getPage('people/alice-example')).not.toBeNull();
    } finally {
      await rust.disconnect();
    }
  }, 60_000);

  withAddon('the seed never writes to the primary and counts the unfinished jobs', async () => {
    await fillSeedFixture(engine);
    await insertSeedFixtureJobs(engine);
    const before = await primaryDigests(engine);
    const { record } = await seedInto(engine, addon, tempDir(), 'postgres');
    expect(await primaryDigests(engine)).toEqual(before);
    expect(record.non_terminal_jobs).toBe(1);
    expect(record.losses.not_copied.find(n => n.table === 'minion_jobs')?.rows).toBe(2);
    expect(record.segmented_pages).toBe(0);
  }, 60_000);

  withAddon('the seed reads in a read-only REPEATABLE READ transaction', async () => {
    await fillSeedFixture(engine);
    // Wrap the primary so the seed's own transaction reports its mode after the seed's reads finish.
    let mode: Array<{ ro: string; iso: string }> = [];
    const probe = Object.create(engine, {
      transaction: {
        value: (fn: (tx: PostgresEngine) => Promise<unknown>, opts?: unknown) => engine.transaction(async tx => {
          const out = await fn(tx as PostgresEngine);
          mode = await tx.executeRaw(`SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso`);
          return out;
        }, opts as never),
      },
    }) as PostgresEngine;
    const { record } = await seedInto(probe, addon, tempDir(), 'postgres');
    expect(record.relations.pages?.imported).toBe(2);
    expect(mode).toEqual([{ ro: 'on', iso: 'repeatable read' }]);
  }, 60_000);
});
