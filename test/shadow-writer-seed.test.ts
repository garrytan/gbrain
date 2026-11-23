/**
 * The shadow seed leaves engine_writer_observations behind on purpose (rust seed::NOT_COPIED), so writer observations
 * never count as unseeded gap rows and never block a swap.
 *
 * Protects: a primary holding observation rows seeds with zero gap rows for that table. Regression it catches: a new
 * operational table the seed plan does not name, which would hold the swap at "unseeded gap rows" forever once shadow
 * mode writes its first observation. Needs the addon `bun run rust:build` writes; skips without it
 * (GBRAIN_TEST_REQUIRE_RUST_ADDON=1 or GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error). The Rust
 * engine workflow's rust-store lane owns it and fails when no test ran.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { fillSeedFixture, seedInto } from './helpers/shadow-seed-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && (process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1' || process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1')) {
  throw new Error(`a Rust addon is required here but ${BUILT} does not exist; run bun run rust:build`);
}

let primary: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  primary = new PGLiteEngine();
  await primary.connect({});
  await primary.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'gbrain-writer-seed-'));
});

afterAll(async () => {
  await primary.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!HAVE_ADDON)('observation rows are left behind on purpose, not counted as gap rows', async () => {
  await fillSeedFixture(primary);
  await primary.executeRaw(`INSERT INTO engine_writer_observations (host_id, application_name, process_kind, gbrain_version)
    VALUES ('11111111-1111-4111-8111-111111111111', 'gbrain cli:1:abcdef01', 'cli', 'test')`);
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const { record } = await seedInto(primary, addon, dir, 'pglite');
  expect(record.unseeded_gap_rows.engine_writer_observations).toBeUndefined();
  expect(record.losses.not_copied.find(n => n.table === 'engine_writer_observations')?.rows).toBe(1);
}, 60_000);
