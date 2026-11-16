/**
 * GST-363: config access.serves_derived (kept by v309's gbrain_access_refresh_serves) never reads `one` on a brain
 * that serves several people after two transactions change members at once. Without the transaction lock, a member
 * disabled while another is being added counts the brain from a snapshot that misses the new member and writes
 * `one` after the add commits, so unbound reads stop being refused. A transaction above read committed counts from a
 * snapshot that can miss a member committed after it, so it never lowers the value.
 * Run: DATABASE_URL=... bun test test/e2e/serves-derived-concurrency.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
const name = `gbrain_test_serves_${randomUUID().replaceAll('-', '')}`;
let admin: ReturnType<typeof postgres> | null = null;
let conn: ReturnType<typeof postgres> | null = null;

describeE2E('access.serves_derived under concurrent member changes (Postgres)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    admin = postgres(DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${name}`;
    const engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString() });
    try { await engine.initSchema(); } finally { await engine.disconnect(); }
    conn = postgres(url.toString(), { max: 2, prepare: false, onnotice: () => {} });
  }, 240_000);
  afterAll(async () => {
    await conn?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  }, 60_000);

  const derived = async () => (await conn!.unsafe("SELECT value FROM config WHERE key = 'access.serves_derived'"))[0]?.value ?? null;
  const enabled = async () => (await conn!.unsafe('SELECT count(*)::int AS n FROM access_members WHERE disabled_at IS NULL AND tombstoned_at IS NULL'))[0]!.n;

  test('a member disabled while another is added leaves several, not one', async () => {
    expect(await derived()).toBeNull();
    await conn!.unsafe("INSERT INTO access_members (id) VALUES ('alice-example'), ('bob-example')");
    expect(await derived()).toBe('several');
    const adding = await conn!.reserve();
    const disabling = await conn!.reserve();
    try {
      await adding.unsafe('BEGIN');
      await adding.unsafe("INSERT INTO access_members (id) VALUES ('carol-example')");
      await disabling.unsafe('BEGIN');
      const disabled = disabling.unsafe("UPDATE access_members SET disabled_at = now() WHERE id = 'alice-example'").execute();
      await Bun.sleep(300);
      await adding.unsafe('COMMIT');
      await disabled;
      await disabling.unsafe('COMMIT');
    } finally {
      await adding.unsafe('ROLLBACK').catch(() => {});
      await disabling.unsafe('ROLLBACK').catch(() => {});
      adding.release();
      disabling.release();
    }
    expect(await enabled()).toBe(2);
    expect(await derived()).toBe('several');
  }, 60_000);

  test('a repeatable-read disable whose snapshot misses a newly added member leaves several, not one', async () => {
    expect({ enabled: await enabled(), derived: await derived() }).toEqual({ enabled: 2, derived: 'several' });
    const disabling = await conn!.reserve();
    try {
      await disabling.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await disabling.unsafe('SELECT count(*) FROM access_members');
      await conn!.unsafe("INSERT INTO access_members (id) VALUES ('dave-example')");
      await disabling.unsafe("UPDATE access_members SET disabled_at = now() WHERE id = 'bob-example'");
      await disabling.unsafe('COMMIT');
    } finally {
      await disabling.unsafe('ROLLBACK').catch(() => {});
      disabling.release();
    }
    expect(await enabled()).toBe(2);
    expect(await derived()).toBe('several');
  }, 60_000);
});
