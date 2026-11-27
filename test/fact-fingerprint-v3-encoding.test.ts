/**
 * Migration fact_fingerprint_v3 upgrades a Postgres brain whose database encoding is not UTF8 (database_encoding doctor
 * check: such a brain keeps running with a warning).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: initSchema() on a SQL_ASCII database applies every migration, v353 included, and the fingerprint
 *    function answers there; the migration never blocks that upgrade.
 *  - Regression: v353 swept chr(1..65535) for characters the locale's [[:space:]] and the explicit list disagree on, and
 *    chr(256) raises "requested character too large for encoding" on a non-UTF8 database, so the upgrade stopped there.
 *  - Why existing coverage misses it: every other arm runs on the UTF8 test database.
 *    The sweep now stays inside the range chr() takes on the database's encoding. A single-byte encoding such as LATIN1
 *    (sweep to 255) is not pinned here: initSchema on a fresh LATIN1 database stops earlier, on schema text outside LATIN1.
 *  - Seam: a scratch SQL_ASCII database created beside the test database (template0, C collation), dropped after.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)('fact fingerprint v3 on a SQL_ASCII database (postgres)', () => {
  const name = `gbrain_test_ascii_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let admin: ReturnType<typeof postgres>;
  let engine: PostgresEngine;
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    admin = postgres(databaseUrl!, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name} ENCODING 'SQL_ASCII' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString() });
  });
  afterAll(async () => {
    try { await engine?.disconnect(); } finally {
      try { await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin?.end(); }
    }
  });

  test('initSchema applies the migration and the fingerprint answers', async () => {
    await engine.initSchema();
    const [{ server_encoding }] = await engine.executeRaw<{ server_encoding: string }>('SHOW server_encoding');
    expect(server_encoding).toBe('SQL_ASCII');
    const version = await engine.getConfig('version');
    expect(Number(version)).toBeGreaterThanOrEqual(353);
    const [{ fp }] = await engine.executeRaw<{ fp: string }>(`SELECT gbrain_fact_fingerprint('A  Claim') AS fp`);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);
});

