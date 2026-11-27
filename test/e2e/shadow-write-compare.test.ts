/**
 * Postgres twin of test/shadow-write-compare.test.ts: the preimage read, the scratch replay with the real addon, the counts that
 * must never be comparable and the promise that the pilot never changes a primary write (scenarios in
 * test/helpers/shadow-write-compare-scenarios.ts), from a real Postgres primary. Needs DATABASE_URL and the addon
 * `bun run rust:build` writes for the replay scenarios; skips without a database (a missing addon skips only the replay,
 * and GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes it an error).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { loadRustAddon, type RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { defineWriteCompareScenarios } from '../helpers/shadow-write-compare-scenarios.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
let addon: RustAddon | undefined;
const dirs: string[] = [];

(hasDatabase() ? describe : describe.skip)('write comparisons on Postgres', () => {
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

  defineWriteCompareScenarios({
    primary: () => engine, reset: async () => {}, kind: 'postgres',
    tempDir: () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-write-compare-pg-')); dirs.push(dir); return dir; },
    ...(HAVE_ADDON ? { addon: () => addon!, addonPath: BUILT } : {}),
  });
});
