/**
 * #6089 on Postgres: apply-migrations never exits 0 while the schema stays
 * behind. An applied reconcile re-check is not pending work, so with nothing
 * else pending a schema that is behind fails the run before the re-check; when
 * orchestrators did run, the schema version is read again afterwards. The
 * failure is `migrations_pending` (exit 1) with a reason that says which case
 * it was and the schema migrations still pending. After an authorized run the
 * fix is a report, never another `--yes`.
 *
 * Each case runs the real runner in a child process (stubbed orchestrator
 * registry) against one scratch database created for this file.
 * Run: DATABASE_URL=... bun test test/e2e/apply-migrations-schema-exit.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { collect, makeHome, spawnDriver } from '../helpers/apply-migrations-lock-driver.ts';
import { parseDocument, writeSchemaDriver, type StubMigration } from '../helpers/apply-migrations-schema-driver.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;

let scratchUrl = '';
let scratchName = '';
let admin: ReturnType<typeof postgres> | null = null;
let conn: ReturnType<typeof postgres> | null = null;
const homes: string[] = [];

async function setVersion(version: number): Promise<void> {
  await conn!.unsafe(`INSERT INTO config (key, value) VALUES ('version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(version)]);
}

async function readVersion(): Promise<number> {
  const rows = await conn!.unsafe(`SELECT value FROM config WHERE key = 'version'`);
  return Number(rows[0]?.value);
}

async function run(migrations: StubMigration[], args: string[], extra: { failSchemaMigrations?: boolean; entry?: 'post-upgrade' } = {}) {
  const home = makeHome({ engine: 'postgres', database_url: scratchUrl });
  homes.push(home);
  const result = await collect(spawnDriver(home, writeSchemaDriver(home, { migrations, args: [...args, '--json', '--no-autopilot-install'], ...extra })));
  const log = existsSync(join(home, 'orchestrator.log')) ? readFileSync(join(home, 'orchestrator.log'), 'utf8') : '';
  return { ...result, log, doc: parseDocument(result.stdout), out: result.stderr + result.stdout };
}

describeE2E('apply-migrations exit when the schema stays behind (#6089, Postgres)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    scratchName = `gbrain_test_schema_exit_${randomUUID().replaceAll('-', '')}`;
    admin = postgres(DATABASE_URL!, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${scratchName}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${scratchName}`;
    scratchUrl = url.toString();
    const engine = new PostgresEngine();
    await engine.connect({ database_url: scratchUrl });
    await engine.initSchema();
    await engine.disconnect();
    conn = postgres(scratchUrl, { max: 1, prepare: false });
  }, 180_000);

  afterAll(async () => {
    await conn?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
      await admin.end();
    }
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await conn!.unsafe(`DO $$ BEGIN IF to_regclass('config_hidden_6089') IS NOT NULL THEN ALTER TABLE config_hidden_6089 RENAME TO config; END IF; END $$`);
    await conn!.unsafe(`DELETE FROM gbrain_cycle_locks WHERE id = 'gbrain-apply-migrations'`);
  });

  test('only the reconcile re-check left, schema behind, no --yes: exit 1 not_applied, re-check not run', async () => {
    await setVersion(LATEST_VERSION - 1);
    const r = await run(['reconcile'], []);
    expect(r.code, r.out).toBe(1);
    expect(r.doc.code).toBe('migrations_pending');
    expect(r.doc.reason).toBe('not_applied');
    expect(r.doc.schema_pending).toMatchObject({ current: LATEST_VERSION - 1, latest: LATEST_VERSION, pending: [LATEST_VERSION] });
    expect(r.doc.fix.argv).toContain('--yes');
    expect(r.log).toBe('');
    expect(await readVersion()).toBe(LATEST_VERSION - 1);
  }, 120_000);

  test('only the re-check left, --yes, the schema migration fails: exit 1 still_behind, the fix is a report, not another --yes', async () => {
    await setVersion(LATEST_VERSION - 1);
    const r = await run(['reconcile'], ['--yes', '--non-interactive'], { failSchemaMigrations: true });
    expect(r.code, r.out).toBe(1);
    expect(r.doc.code).toBe('migrations_pending');
    expect(r.doc.reason).toBe('still_behind');
    expect(r.doc.schema_pending.pending).toEqual([LATEST_VERSION]);
    expect(r.doc.fix.next).toBe('report');
    expect(r.doc.fix.argv).toBeUndefined();
    expect(r.doc.fix.verify.argv).toEqual(['gbrain', 'doctor', '--json']);
    expect(r.log).toBe('');
  }, 120_000);

  test('only the re-check left, --yes: the schema is migrated, the re-check runs, exit 0', async () => {
    await setVersion(LATEST_VERSION - 1);
    const r = await run(['reconcile'], ['--yes', '--non-interactive']);
    expect(r.code, r.out).toBe(0);
    expect(r.log).toBe('ran reconcile\n');
    expect(await readVersion()).toBe(LATEST_VERSION);
  }, 120_000);

  test('schema current, no --yes: the re-check runs, exit 0', async () => {
    await setVersion(LATEST_VERSION);
    const r = await run(['reconcile'], []);
    expect(r.code, r.out).toBe(0);
    expect(r.doc.status).toBe('ok');
    expect(r.log).toBe('ran reconcile\n');
  }, 120_000);

  test('a pending orchestrator that leaves the schema behind runs, then exit 1', async () => {
    await setVersion(LATEST_VERSION - 1);
    const r = await run(['reconcile', 'noop'], []);
    expect(r.code, r.out).toBe(1);
    expect(r.log).toContain('ran noop');
    expect(r.doc.code).toBe('migrations_pending');
    expect(r.doc.reason).toBe('not_applied');
    expect(r.doc.schema_pending.pending).toEqual([LATEST_VERSION]);
  }, 120_000);

  test('a pending orchestrator that migrates the schema itself: exit 0', async () => {
    await setVersion(LATEST_VERSION - 1);
    const r = await run(['reconcile', 'migrate_schema'], []);
    expect(r.code, r.out).toBe(0);
    expect(r.log).toContain('ran migrate_schema');
  }, 120_000);

  test('the schema version cannot be read back after orchestrators: exit 1 schema_unreadable with the read error', async () => {
    await setVersion(LATEST_VERSION);
    const r = await run(['reconcile', 'hide_version'], ['--yes', '--non-interactive']);
    expect(r.code, r.out).toBe(1);
    expect(r.doc.code).toBe('migrations_pending');
    expect(r.doc.reason).toBe('schema_unreadable');
    expect(r.doc.message).toContain('could not be read');
    expect(r.doc.schema_pending).toMatchObject({ current: null, latest: LATEST_VERSION });
    expect(r.doc.fix.next).toBe('report');
  }, 120_000);

  test('gbrain post-upgrade (in-process apply-migrations --yes) stops on a schema that stays behind', async () => {
    await setVersion(LATEST_VERSION - 1);
    const r = await run(['reconcile'], [], { failSchemaMigrations: true, entry: 'post-upgrade' });
    expect(r.code, r.out).toBe(1);
    expect(r.doc.code).toBe('migrations_pending');
    expect(r.doc.reason).toBe('still_behind');
    expect(r.doc.apply_migrations).toEqual({ exit_code: 1 });
    expect(r.doc.fix.next).toBe('report');
  }, 120_000);

  test('a failed orchestrator reports migration_failed ahead of the schema check', async () => {
    await setVersion(LATEST_VERSION - 1);
    const r = await run(['reconcile', 'fail'], []);
    expect(r.code, r.out).toBe(1);
    expect(r.doc.code).toBe('migration_failed');
  }, 120_000);
});
