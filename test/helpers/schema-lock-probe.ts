/**
 * GBRA-467: the probe for "two runners apply a schema migration once". A deliberately non-idempotent migration
 * (its SQL adds a column without IF NOT EXISTS; its handler records each run, then sleeps) is pushed past the
 * latest version, the first runner is started, and the second starts once the first is inside the step. A
 * second run of the step either fails on the column or records a second handler row; a correct lock makes the
 * second runner wait, find nothing to do, and succeed.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';
import { withEnv } from './with-env.ts';

export const PROBE_VERSION = LATEST_VERSION + 1;

export type Runner = (engine: BrainEngine) => Promise<unknown>;
/** What `gbrain apply-migrations` runs under its orchestration lease. */
export const explicitRun: Runner = engine => runMigrations(engine);
/** What every process start runs on connect. */
export const processStart: Runner = engine => engine.initSchema();

/** A scratch database at the latest schema with an empty probe table; `drop` removes it. */
export async function probeDatabase(databaseUrl: string): Promise<{ url: string; drop: () => Promise<void> }> {
  assertSafeE2eDatabaseUrl(databaseUrl);
  const name = `gbrain_test_schema_lock_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const drop = async () => {
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
  };
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const setup = new PostgresEngine();
  try {
    await setup.connect({ database_url: url.toString(), poolSize: 4 });
    await setup.initSchema();
    await setup.executeRaw('CREATE TABLE schema_lock_probe (step TEXT NOT NULL)');
  } catch (error) {
    await drop();
    throw error;
  } finally { await setup.disconnect(); }
  return { url: url.toString(), drop };
}

async function bounded<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms); });
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
}

/** Runs `first` on `a`, then `second` on `b` once `first` is inside the probe step, and expects one clean run of it. */
export async function expectProbeAppliedOnce(a: BrainEngine, b: BrainEngine, first: Runner, second: Runner, stepMs: number): Promise<void> {
  let entered!: () => void;
  const inside = new Promise<void>(resolve => { entered = resolve; });
  MIGRATIONS.push({
    version: PROBE_VERSION,
    name: 'schema_lock_probe',
    sql: "INSERT INTO schema_lock_probe (step) VALUES ('sql'); ALTER TABLE schema_lock_probe ADD COLUMN applied INTEGER",
    handler: async (engine) => {
      entered();
      await engine.executeRaw("INSERT INTO schema_lock_probe (step) VALUES ('handler')");
      await Bun.sleep(stepMs);
    },
    idempotent: false,
  });
  try {
    await withEnv({ GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS: '90' }, async () => {
      const firstRun = first(a);
      await bounded('first runner entering the probe step', 60_000, inside);
      const results = await bounded('both runners', 150_000, Promise.allSettled([firstRun, second(b)]));
      expect(results.map(r => r.status === 'fulfilled' ? 'ok' : (r.reason as Error).message)).toEqual(['ok', 'ok']);
    });
    expect(await a.executeRaw('SELECT step, count(*)::int AS n FROM schema_lock_probe GROUP BY step ORDER BY step'))
      .toEqual([{ step: 'handler', n: 1 }, { step: 'sql', n: 1 }]);
    expect(await a.getConfig('version')).toBe(String(PROBE_VERSION));
  } finally {
    MIGRATIONS.splice(MIGRATIONS.findIndex(m => m.version === PROBE_VERSION), 1);
  }
}
