import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { setMigrationStatementTimeoutMs } from '../src/core/migration-timeout.ts';
import { v273 } from '../src/core/schema-migrations/v273-segment-derivations.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

// v273 adds facts_source_window_chk NOT VALID in its SQL and validates it in the handler's own statement. That
// statement gets the migration's bounds: the schema lock wait (GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS) and the
// migration statement budget, on a dedicated backend. Before, it ran on the pool with neither, so a session
// holding facts waited the VALIDATE out (forever, or until a server statement_timeout).
for (const kind of testBackends()) describe(`v273 facts_source_window_chk validation (${kind})`, () => {
  let engine: BrainEngine, databaseUrl = '', close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, databaseUrl, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });
  const validated = async () => (await engine.executeRaw<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint WHERE conname = 'facts_source_window_chk' AND conrelid = 'facts'::regclass`)).map(row => row.convalidated);
  beforeEach(async () => {
    await engine.executeRaw('ALTER TABLE facts DROP CONSTRAINT facts_source_window_chk');
    await engine.runMigration(273, v273.sql);
    expect(await validated()).toEqual([false]);
  });

  test('the handler validates the constraint', async () => {
    await v273.handler!(engine);
    expect(await validated()).toEqual([true]);
  });

  if (kind !== 'postgres') return;
  /** Holds facts in SHARE mode (conflicts with VALIDATE's SHARE UPDATE EXCLUSIVE) on its own session until `release`. */
  async function holdFacts() {
    const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
    const conn = await sql.reserve();
    await conn.unsafe('BEGIN');
    await conn.unsafe('LOCK TABLE facts IN SHARE MODE');
    const release = async () => { await conn.unsafe('COMMIT'); conn.release(); await sql.end(); };
    const timer = setTimeout(() => { void release(); }, 3_000);
    return async () => { clearTimeout(timer); await release().catch(() => {}); };
  }

  test('a session holding facts makes the VALIDATE refuse at the schema lock bound, and a rerun validates', async () => {
    const release = await holdFacts();
    try {
      await withEnv({ GBRAIN_SCHEMA_LOCK_TIMEOUT_SECONDS: '0.2' }, () =>
        expect(v273.handler!(engine)).rejects.toMatchObject({ code: 'schema_lock_blocked' }));
      expect(await validated()).toEqual([false]);
    } finally { await release(); }
    await v273.handler!(engine);
    expect(await validated()).toEqual([true]);
  }, 30_000);

  test('the VALIDATE runs under the migration statement budget', async () => {
    const release = await holdFacts();
    setMigrationStatementTimeoutMs(300);
    try {
      await expect(v273.handler!(engine)).rejects.toMatchObject({ code: '57014' });
      expect(await validated()).toEqual([false]);
    } finally { setMigrationStatementTimeoutMs(null); await release(); }
    await v273.handler!(engine);
    expect(await validated()).toEqual([true]);
  }, 30_000);
});
