/**
 * #5945 on a real server. Protects: a `database_url` carrying
 * `?connect_timeout=N` connects, and every pool (module singleton, engine
 * instance pool, ConnectionManager read and direct pools) runs with that
 * value. Fails when: a pool hardcodes 10s again, or the parameter leaks into
 * the startup packet as an unknown server setting (Postgres would refuse it).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as db from '../../src/core/db.ts';
import { ConnectionManager } from '../../src/core/connection-manager.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl, hasDatabase } from './helpers.ts';

const base = process.env.DATABASE_URL ?? '';
const withTimeout = (seconds: number) => {
  const url = new URL(base);
  url.searchParams.set('connect_timeout', String(seconds));
  return url.toString();
};
const timerOf = (pool: unknown) => (pool as { options: { connect_timeout: unknown } }).options.connect_timeout;

describe.skipIf(!hasDatabase())('connect_timeout from database_url (Postgres)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterAll(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); await db.disconnect(); });

  test('module singleton and engine instance pool connect and carry the URL value', async () => {
    assertSafeE2eDatabaseUrl(base);
    await db.connect({ database_url: withTimeout(17) });
    const singleton = db.getConnection();
    expect(timerOf(singleton)).toBe(17);
    expect((await singleton`SELECT 1 AS ok`)[0].ok).toBe(1);

    const engine = new PostgresEngine();
    cleanups.push(() => engine.disconnect());
    await engine.connect({ database_url: withTimeout(23), poolSize: 2 });
    expect(timerOf(engine.sql)).toBe(23);
    expect((await engine.executeRaw<{ ok: number }>('SELECT 1 AS ok'))[0].ok).toBe(1);
  }, 60_000);

  test('ConnectionManager read and direct pools each use their own URL', async () => {
    const cm = new ConnectionManager({ url: withTimeout(19), directUrl: withTimeout(29) });
    cleanups.push(() => cm.disconnect());
    const read = await cm.getReadPool();
    const ddl = await cm.ddl();
    expect(timerOf(read)).toBe(19);
    expect(timerOf(ddl)).toBe(29);
    expect((await ddl`SELECT 1 AS ok`)[0].ok).toBe(1);

    const plain = new ConnectionManager({ url: base });
    cleanups.push(() => plain.disconnect());
    expect(timerOf(await plain.getReadPool())).toBe(10);
  }, 60_000);
});
