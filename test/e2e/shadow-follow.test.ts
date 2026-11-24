/**
 * Postgres twin of test/shadow-follow.test.ts: the shadow follower, reconcile, fingerprint probe and allocator check
 * (scenarios in test/helpers/shadow-follow-scenarios.ts) from a real Postgres primary, where reads are typed
 * parameterised queries in a real REPEATABLE READ transaction and `gbrain_fact_fingerprint` is the server's.
 * Needs DATABASE_URL and the addon `bun run rust:build` writes; skips without either
 * (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { loadRustAddon, type RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';
import { attachShadowParts } from '../../src/shadow/attach.ts';
import { buildFollowStatus } from '../../src/shadow/follow-status.ts';
import type { ShadowState } from '../../src/shadow/state.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { defineEvidenceScenarios } from '../helpers/shadow-evidence-scenarios.ts';
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

  defineEvidenceScenarios({ primary: () => engine, addon: () => addon, addonPath: BUILT, kind: 'postgres' });
});

// Needs a database but no addon, so the stress gate (which has no addon) still runs it.
(hasDatabase() ? describe : describe.skip)('a seed written before shadow follow existed, on Postgres', () => {
  test('follow does not run, and status says the brain needs a reseed', async () => {
    const legacyTemplate = await persistencePostgresTemplate(process.env.DATABASE_URL!);
    const { engine: pg, close: closePg } = await legacyTemplate.clone();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-legacy-pg-'));
    try {
      const record = {
        version: 1, seed_id: 'seed-legacy', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', primary_engine: 'postgres',
        relations: {}, losses: { values: {}, not_copied: [], gaps: {} }, unseeded_gap_rows: {}, unseeded_gap_rows_total: 0, non_terminal_jobs: 0, segmented_pages: 0,
      };
      writeFileSync(join(dir, 'seed.json'), JSON.stringify(record));
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 0, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: 'postgres' } as unknown as ShadowState;
      const attached = attachShadowParts(pg, dir, state, { gbrainArgv: ['unused'] });
      try {
        expect(attached.follower).toBeUndefined();
        expect(attached.reconciler).toBeUndefined();
      } finally { attached.supervisor.stop(); }
      const follower = buildFollowStatus(dir, state).follower;
      expect(follower.state).toBe('needs_reseed');
      expect(follower.action).toContain('gbrain engine shadow stop --delete');
    } finally {
      await closePg();
      await legacyTemplate.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
