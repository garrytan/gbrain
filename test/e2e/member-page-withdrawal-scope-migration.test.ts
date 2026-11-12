/**
 * GST-2346: the member_page_withdrawal_scope migration re-creates the two fact insert guards
 * (gbrain_preserve_fact_withdrawal, gbrain_guard_inserted_facts) and nothing else. Each arm stubs both functions,
 * winds the brain back one schema version and runs two migration runners at once, then expects both to succeed,
 * the brain at the latest version and both guards back with the member-page rule. On Postgres (direct, and through
 * a transaction-mode PgBouncer: this file is in scripts/e2e-backend-matrix.txt) the runners do it while another
 * connection holds ROW EXCLUSIVE on facts, so a step that locked the table (an index or trigger rebuild) would wait
 * on that transaction and fail the bound. PGLite admits one connection, so its arm checks the two runners only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { probeDatabase } from '../helpers/schema-lock-probe.ts';
import { withEnv } from '../helpers/with-env.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const GUARDS = ['gbrain_guard_inserted_facts', 'gbrain_preserve_fact_withdrawal'];
const migration = MIGRATIONS.find(m => m.name === 'member_page_withdrawal_scope')!;

/** Replaces both guards with bodies that mark nothing, and winds the brain back to just before the migration. */
async function windBack(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('CREATE OR REPLACE FUNCTION gbrain_preserve_fact_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$');
  await engine.executeRaw('CREATE OR REPLACE FUNCTION gbrain_guard_inserted_facts() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END $fn$');
  await engine.setConfig('version', String(migration.version - 1));
}

async function expectGuardsRestored(engine: BrainEngine): Promise<void> {
  expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
  const rows = await engine.executeRaw<{ proname: string; member_rule: boolean }>(
    "SELECT proname, position('memory/members/' in prosrc) > 0 AS member_rule FROM pg_proc WHERE proname = ANY($1::text[]) ORDER BY proname", [GUARDS]);
  expect(rows).toEqual(GUARDS.map(proname => ({ proname, member_rule: true })));
}

async function bounded<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms); });
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
}

const settled = (results: PromiseSettledResult<unknown>[]) => results.map(r => r.status === 'fulfilled' ? 'ok' : (r.reason as Error).message);
const twoRunners = (a: BrainEngine, b: BrainEngine) => withEnv({ GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS: '90' }, () =>
  bounded('both runners', 60_000, Promise.allSettled([runMigrations(a), runMigrations(b)])));

test('the migration is registered at 306, no later than the latest, and is idempotent', () => {
  expect(migration.version).toBe(306);
  expect(migration.version).toBeLessThanOrEqual(LATEST_VERSION);
  expect(migration.idempotent).toBe(true);
});

describe('member_page_withdrawal_scope migration under two runners (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(() => withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }), 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('two runMigrations calls both succeed and restore both guards', async () => {
    await windBack(engine);
    expect(settled(await twoRunners(engine, engine))).toEqual(['ok', 'ok']);
    await expectGuardsRestored(engine);
  }, 120_000);
});

describe.skipIf(!DATABASE_URL)(`member_page_withdrawal_scope migration under two runners [${process.env.GBRAIN_TEST_BACKEND ?? 'postgres'}] (E2E)`, () => {
  test('two runners finish while another connection holds ROW EXCLUSIVE on facts, and restore both guards', async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    const db = await probeDatabase(DATABASE_URL!);
    const a = new PostgresEngine();
    const b = new PostgresEngine();
    const holder = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await a.connect({ database_url: db.url, poolSize: 4 });
      await b.connect({ database_url: db.url, poolSize: 4 });
      await windBack(a);
      const results = await holder.begin(async sql => {
        await sql`LOCK TABLE facts IN ROW EXCLUSIVE MODE`;
        return twoRunners(a, b);
      });
      expect(settled(results)).toEqual(['ok', 'ok']);
      await expectGuardsRestored(a);
    } finally {
      await holder.end();
      await a.disconnect();
      await b.disconnect();
      await db.drop();
    }
  }, 240_000);
});
