/**
 * E2E: a one-connection Postgres pool (GBRAIN_POOL_SIZE=1) initializes a fresh
 * brain and runs every schema migration.
 *
 * `transaction: false` migrations (CREATE INDEX CONCURRENTLY and friends) run
 * on a reserved connection. The long-hold permit keeps one connection free for
 * reads and control work, so before the fix a pool of one refused them with
 * writer_pool_capacity at the first such migration and `gbrain init` failed.
 * Migration holds are self-contained (they use only the reserved connection),
 * so they may take the only connection; ordinary long holds still may not.
 *
 * Run: DATABASE_URL=postgresql://.../gbrain_test bun run test:e2e \
 *      test/e2e/pool-size-one-migrations.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION, MIGRATIONS } from '../../src/core/migrate.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { makeDoctorHome, runGbrain, type DoctorHome } from '../helpers/doctor-json-golden.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const drops: Array<() => Promise<void>> = [];
const homes: DoctorHome[] = [];
afterAll(async () => {
  for (const drop of drops) await drop();
  for (const h of homes) h.cleanup();
});

async function freshDatabase(): Promise<string> {
  assertSafeE2eDatabaseUrl(DATABASE_URL!);
  const name = `gbrain_test_pool_one_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(DATABASE_URL!, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  drops.push(async () => {
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
  });
  const url = new URL(DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function schemaVersion(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const [row] = await sql<{ value: string }[]>`SELECT value FROM config WHERE key = 'version'`;
    return Number(row?.value);
  } finally { await sql.end(); }
}

describe.skipIf(!DATABASE_URL)('pool size one: fresh init and migrations (E2E)', () => {
  test('the migration chain contains transaction:false migrations, so this exercises the reserved path', () => {
    expect(MIGRATIONS.some(m => m.transaction === false)).toBe(true);
  });

  test('initSchema on a fresh database with a one-connection pool reaches the latest version', async () => {
    const url = await freshDatabase();
    const engine = new PostgresEngine();
    await engine.connect({ database_url: url, poolSize: 1 });
    try {
      expect((engine.sql as unknown as { options: { max: number } }).options.max).toBe(1);
      await engine.initSchema();
      expect(Number(await engine.getConfig('version'))).toBe(LATEST_VERSION);
      await expect(engine.withReservedConnection(async () => 'held')).rejects.toMatchObject({ code: 'writer_pool_capacity' });
      expect((await engine.executeRaw<{ ok: number }>('SELECT 1 AS ok'))[0]?.ok).toBe(1);
    } finally {
      await engine.disconnect();
    }
  }, 180_000);

  test('GBRAIN_POOL_SIZE=1 gbrain init then apply-migrations succeed on a fresh database', async () => {
    const url = await freshDatabase();
    const h = makeDoctorHome('pool-one');
    homes.push(h);
    const env = { GBRAIN_POOL_SIZE: '1' };
    const init = await runGbrain(h, ['init', '--url', url, '--no-embedding', '--non-interactive', '--db-only'], env, 180_000);
    expect(init.stderr).not.toContain('writer_pool_capacity');
    expect(init.stderr).not.toContain('No pool capacity');
    expect(init.exitCode).toBe(0);
    expect(await schemaVersion(url)).toBe(LATEST_VERSION);
    const apply = await runGbrain(h, ['apply-migrations', '--yes', '--no-autopilot-install'], env, 180_000);
    expect(apply.stderr).not.toContain('No pool capacity');
    expect(apply.exitCode).toBe(0);
    expect(await schemaVersion(url)).toBe(LATEST_VERSION);
  }, 400_000);
});
