/**
 * Postgres twin of test/rust-engine-shadow-managed-gate.serial.test.ts: `gbrain engine shadow start` on a managed-storage
 * Postgres brain, through the real default open path (the configured database_url, no injected engine).
 *
 * Protects: a Postgres brain with persistence_brain.enabled = true is refused (exit 3, engine_shadow_refused /
 * managed_storage) by --plan, the bare preview and --yes --expect, before the addon loads and before any shadow
 * file exists; the same brain with enabled = false still gets its plan.
 * Regression it catches: start that reads the mode only on PGLite, or that writes state.json before checking.
 * Needs DATABASE_URL (GBRAIN_TEST_ALLOW_DATABASE_URL=1); skips without it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineShadow, shadowPlan } from '../../src/commands/engine-shadow.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import { DEFAULT_SHADOW_QUEUE_BOUND, DEFAULT_SHADOW_SAMPLE_RATE, shadowBrainKey, shadowDirFor } from '../../src/shadow/state.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

const d = hasDatabase() ? describe : describe.skip;

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
let config: EngineConfig;
let home: string;
const saved: Record<string, string | undefined> = {};

function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const loadAddon = async (): Promise<never> => { throw new Error('the addon was loaded before the managed-storage check'); };
  return runEngineShadow(args, { out: l => out.push(l), err: l => err.push(l), config: () => config, loadAddon })
    .then(code => ({ code, out, err }));
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

  test('a managed brain is refused by --plan, the preview and --yes --expect, and nothing is written', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    for (const args of [['start', '--plan'], ['start'], ['start', '--yes', '--expect', hash()]]) {
      const r = await run(args);
      expect(r.code, args.join(' ')).toBe(3);
      expect(r.err[0], args.join(' ')).toBe('engine shadow: engine_shadow_refused (managed_storage): Shadow mode is refused: this brain uses managed storage.');
      expect(existsSync(dir()), args.join(' ')).toBe(false);
    }
  }, 60_000);

  test('an unmanaged brain still gets its plan', async () => {
    const r = await run(['start', '--plan']);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain(`plan_hash: ${hash()}`);
    expect(existsSync(dir())).toBe(false);
  }, 60_000);
});
