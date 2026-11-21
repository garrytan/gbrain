/**
 * Postgres twin of test/shadow-follow.test.ts: the shadow follower, reconcile, fingerprint probe and allocator check
 * (scenarios in test/helpers/shadow-follow-scenarios.ts) from a real Postgres primary, where reads are typed
 * parameterised queries in a real REPEATABLE READ transaction and `gbrain_fact_fingerprint` is the server's.
 * Needs DATABASE_URL and the addon `bun run rust:build` writes; skips without either
 * (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
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
import { defineFollowScenarios } from '../helpers/shadow-follow-scenarios.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
let addon: RustAddon;
const dirs: string[] = [];

(hasDatabase() && HAVE_ADDON ? describe : describe.skip)('shadow follow on Postgres', () => {
  beforeAll(async () => {
    template = await persistencePostgresTemplate(process.env.DATABASE_URL!);
    addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => {
    await close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  defineFollowScenarios({
    primary: () => engine, addon: () => addon, kind: 'postgres',
    tempDir: () => { const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-follow-pg-')); dirs.push(dir); return dir; },
  });
});
