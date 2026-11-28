/**
 * Postgres twin of test/rust-engine-shadow-managed-gate.serial.test.ts: `gbrain engine shadow start` on a managed-storage
 * Postgres brain, through the real default open path (the configured database_url, no injected engine).
 *
 * Protects: a Postgres brain with persistence_brain.enabled = true gets --plan, the bare preview and --yes --expect
 * (exit 0, 0 and 3 for the preview), each printing "this brain cannot swap while it uses managed storage", and state.json
 * records `storage.managed: true`; the same brain with enabled = false records `false`. start never emits
 * `engine_swap_refused`, and leaves the primary untouched: every persistence_* table and the content root beside the brain are
 * byte-identical before and after.
 * Regression it catches: start that refuses over the storage mode only on Postgres, or that writes to the primary.
 * Needs DATABASE_URL (GBRAIN_TEST_ALLOW_DATABASE_URL=1); skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineShadow, shadowPlan } from '../../src/commands/engine-shadow.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import { DEFAULT_SHADOW_QUEUE_BOUND, DEFAULT_SHADOW_SAMPLE_RATE, OPT_IN_WRITE_SAMPLE_RATE, readShadowState, shadowBrainKey, shadowDirFor } from '../../src/shadow/state.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { snapshotPersistence, snapshotTree } from '../helpers/primary-snapshot.ts';
import { hasDatabase } from './helpers.ts';

const d = hasDatabase() ? describe : describe.skip;
const LINE = 'this brain cannot swap while it uses managed storage';
const NOW = new Date('2026-03-04T05:06:07.000Z');

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
let config: EngineConfig;
let home: string;
let contentRoot: string;
const saved: Record<string, string | undefined> = {};

function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const loadAddon = async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1' } as never });
  return runEngineShadow(args, { out: l => out.push(l), err: l => err.push(l), config: () => config, loadAddon, now: () => NOW })
    // `start --yes` also warns when the Rust store is not seeded; that warning is not what these tests are about.
    .then(code => ({ code, out, err: err.filter(l => !l.startsWith('engine shadow: warning: the Rust store is not seeded')), text: [...out, ...err].join('\n') }));
}

d('engine shadow start on a Postgres brain', () => {
  beforeAll(async () => { template = await persistencePostgresTemplate(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => {
    ({ engine, close } = await template.clone());
    const [{ db }] = await engine.executeRaw<{ db: string }>('SELECT current_database() AS db');
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${db}`;
    config = { engine: 'postgres', database_url: url.toString() };
    home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-managed-pg-'));
    contentRoot = join(home, 'content-root');
    mkdirSync(join(contentRoot, 'people'), { recursive: true });
    writeFileSync(join(contentRoot, 'people', 'a.md'), '# a\n');
    for (const k of ['GBRAIN_HOME', 'GBRAIN_SHADOW_CHILD', 'GBRAIN_RUST_ENGINE_ADDON']) saved[k] = process.env[k];
    process.env.GBRAIN_HOME = home;
    delete process.env.GBRAIN_SHADOW_CHILD;
    delete process.env.GBRAIN_RUST_ENGINE_ADDON;
  }, 60_000);
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await close();
    rmSync(home, { recursive: true, force: true });
  });

  const dir = (): string => shadowDirFor(shadowBrainKey(config)!);
  const hash = (): string => shadowPlan(shadowBrainKey(config)!, 'postgres', dir(), { sampleRate: DEFAULT_SHADOW_SAMPLE_RATE, queueBound: DEFAULT_SHADOW_QUEUE_BOUND }).hash;
  // A brain that can opt in compares every write, and the plan binds that applied rate.
  const optInHash = (): string => shadowPlan(shadowBrainKey(config)!, 'postgres', dir(), { sampleRate: DEFAULT_SHADOW_SAMPLE_RATE, queueBound: DEFAULT_SHADOW_QUEUE_BOUND, writeSampleRate: OPT_IN_WRITE_SAMPLE_RATE }).hash;

  test('a managed brain gets the plan, the preview and --yes, prints the line, records managed: true, and the primary is byte-identical', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = { tables: await snapshotPersistence(engine), files: snapshotTree(contentRoot) };
    expect(before.tables.persistence_brain!.some(r => r.includes('"enabled":true'))).toBe(true);
    const plan = await run(['start', '--plan']);
    expect(plan.err).toEqual([]);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain(`  storage: ${LINE}`);
    const preview = await run(['start']);
    expect(preview.code).toBe(3);
    expect(preview.out).toContain(`  storage: ${LINE}`);
    expect(existsSync(dir())).toBe(false);
    const go = await run(['start', '--yes', '--expect', hash()]);
    expect(go.err).toEqual([]);
    expect(go.code).toBe(0);
    expect(go.out).toContain(`storage: ${LINE}`);
    expect(go.text).not.toContain('engine_swap_refused');
    expect(readShadowState(dir())?.storage).toEqual({ managed: true, checked_at: NOW.toISOString() });
    const status = JSON.parse((await run(['status', '--json'])).out.join('\n'));
    expect(status.storage).toEqual({ managed: true, checked_at: NOW.toISOString(), note: LINE });
    expect(await snapshotPersistence(engine)).toEqual(before.tables);
    expect(snapshotTree(contentRoot)).toEqual(before.files);
  }, 60_000);

  test('an unmanaged brain records managed: false and prints no storage line', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const plan = await run(['start', '--plan']);
    expect(plan.err).toEqual([]);
    expect(plan.code).toBe(0);
    expect(plan.text).not.toContain('storage:');
    expect(existsSync(dir())).toBe(false);
    expect((await run(['start', '--yes', '--expect', optInHash()])).code).toBe(0);
    expect(readShadowState(dir())?.storage).toEqual({ managed: false, checked_at: NOW.toISOString() });
    expect(readShadowState(dir())?.write_sample_rate).toBe(OPT_IN_WRITE_SAMPLE_RATE);
  }, 60_000);

  test('a database that cannot be reached does not block start and records managed: null', async () => {
    config = { engine: 'postgres', database_url: 'postgresql://postgres:postgres@127.0.0.1:1/none' };
    const plan = await run(['start', '--plan']);
    expect(plan.err).toEqual([]);
    expect(plan.code).toBe(0);
    expect(plan.out.join('\n')).toContain('could not read whether this brain uses managed storage; the swap will check it');
    expect((await run(['start', '--yes', '--expect', hash()])).code).toBe(0);
    expect(readShadowState(dir())?.storage?.managed).toBeNull();
  }, 60_000);
});
