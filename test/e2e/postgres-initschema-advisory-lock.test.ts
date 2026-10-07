/**
 * E2E (#6085): initSchema must release advisory lock 42 on the backend that
 * took it, and must still finish on small pools.
 *
 * pg_advisory_lock is session-scoped, but ConnectionManager.ddl() returns a
 * POOL on plain Postgres. Under concurrent pool traffic the acquire and the
 * `pg_advisory_unlock(42)` can land on different backends: the unlock returns
 * false and the holder idles in the pool still holding key 42, stalling every
 * later initSchema until the deadlined acquire gives up. Idle pools reuse one
 * connection and hide the bug, so the leak cases keep the pool busy.
 *
 * Protects: CLI cold start on Postgres. Fails when: acquire and unlock run on
 * different backends (leak), the reservation is taken on a one-slot pool, a
 * long-hold permit starves a pending transaction:false migration on a pool of
 * two, or a failed acquire keeps the reserved backend. Every case runs in its
 * own scratch database with a hard bound so a hang fails instead of stalling.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import { PERSISTENCE_SYNC_RUN_INDEXES } from '../../src/core/persistence/schema.ts';
import { assertSafeE2eDatabaseUrl, hasDatabase } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';

async function scratchDatabase() {
  assertSafeE2eDatabaseUrl(DATABASE_URL);
  const name = `gbrain_test_initlock_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const observer = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
  return {
    url: url.toString(),
    observer,
    async heldLock42(): Promise<number> {
      const [row] = await observer<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'advisory' AND objid = 42 AND granted AND pid <> pg_backend_pid()
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
      return row.n;
    },
    async drop() {
      await observer.end();
      try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await admin.end(); }
    },
  };
}

async function bounded<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms); });
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
}

async function leakedAcrossInits(engine: PostgresEngine, db: Awaited<ReturnType<typeof scratchDatabase>>, runs: number): Promise<number> {
  let stop = false;
  const noise = (async () => {
    while (!stop) await Promise.all(Array.from({ length: 8 }, () => engine.executeRaw('SELECT pg_sleep(0.005)')));
  })();
  let leaked = 0;
  try {
    for (let i = 0; i < runs; i++) {
      await bounded('initSchema under pool load', 60_000, engine.initSchema());
      if (await db.heldLock42() > 0) leaked++;
    }
  } finally {
    stop = true;
    await noise;
  }
  return leaked;
}

describe.skipIf(!hasDatabase())('PostgresEngine.initSchema advisory lock 42 (E2E)', () => {
  test('(a) instance pool: lock 42 is never left held after initSchema under concurrent pool load', async () => {
    const db = await scratchDatabase();
    const engine = new PostgresEngine();
    try {
      await engine.connect({ database_url: db.url, poolSize: 4 });
      await bounded('cold initSchema', 90_000, engine.initSchema());
      expect(await leakedAcrossInits(engine, db, 5)).toBe(0);
    } finally {
      await engine.disconnect();
      await db.drop();
    }
  }, 240_000);

  test('(a) module singleton pool: lock 42 is never left held after initSchema under concurrent pool load', async () => {
    const db = await scratchDatabase();
    const engine = new PostgresEngine();
    try {
      await withEnv({ GBRAIN_POOL_SIZE: undefined }, async () => {
        await engine.connect({ database_url: db.url });
        await bounded('cold initSchema', 90_000, engine.initSchema());
        expect(await leakedAcrossInits(engine, db, 5)).toBe(0);
      });
    } finally {
      await engine.disconnect();
      await db.drop();
    }
  }, 240_000);

  test('(b) GBRAIN_POOL_SIZE=1: a cold-start initSchema on a current brain completes on one backend and releases the lock', async () => {
    const db = await scratchDatabase();
    const setup = new PostgresEngine();
    const engine = new PostgresEngine();
    try {
      await setup.connect({ database_url: db.url, poolSize: 4 });
      await bounded('cold initSchema', 90_000, setup.initSchema());
      await setup.disconnect();
      await withEnv({ GBRAIN_POOL_SIZE: '1' }, async () => {
        await engine.connect({ database_url: db.url });
        expect(engine.sql.options.max).toBe(1);
        await bounded('initSchema at pool size 1', 60_000, engine.initSchema());
        await bounded('repeat initSchema at pool size 1', 60_000, engine.initSchema());
      });
      expect(await db.heldLock42()).toBe(0);
    } finally {
      await engine.disconnect();
      await db.drop();
    }
  }, 240_000);

  test('(c) pool of 2 with a pending transaction:false migration completes and builds its index', async () => {
    const db = await scratchDatabase();
    const engine = new PostgresEngine();
    try {
      await engine.connect({ database_url: db.url, poolSize: 2 });
      await bounded('cold initSchema at pool size 2', 90_000, engine.initSchema());
      for (const index of PERSISTENCE_SYNC_RUN_INDEXES) await engine.executeRaw(`DROP INDEX IF EXISTS ${index.name}`);
      await engine.setConfig('version', '178');
      await bounded('initSchema replaying v179 (CREATE INDEX CONCURRENTLY) at pool size 2', 90_000, engine.initSchema());
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      const rows = await engine.executeRaw<{ name: string; valid: boolean }>(
        `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = ANY($1::text[]) ORDER BY c.relname`, [PERSISTENCE_SYNC_RUN_INDEXES.map(index => index.name)]);
      expect(rows).toEqual(PERSISTENCE_SYNC_RUN_INDEXES.map(index => ({ name: index.name, valid: true })).sort((a, b) => a.name.localeCompare(b.name)));
      expect(await db.heldLock42()).toBe(0);
    } finally {
      await engine.disconnect();
      await db.drop();
    }
  }, 240_000);

  test('a failed lock acquire returns the reserved backend to a pool of 2', async () => {
    const db = await scratchDatabase();
    const engine = new PostgresEngine();
    try {
      await engine.connect({ database_url: db.url, poolSize: 2 });
      await bounded('cold initSchema at pool size 2', 90_000, engine.initSchema());
      await db.observer`SELECT pg_advisory_lock(42)`;
      await withEnv({ GBRAIN_INITSCHEMA_LOCK_TIMEOUT_SECONDS: '1' }, async () => {
        await expect(bounded('contended initSchema', 30_000, engine.initSchema())).rejects.toThrow(/timed out after/);
      });
      await db.observer`SELECT pg_advisory_unlock(42)`;
      await bounded('two concurrent queries on the pool of 2', 10_000,
        Promise.all([engine.executeRaw('SELECT pg_sleep(0.2)'), engine.executeRaw('SELECT pg_sleep(0.2)')]));
      await bounded('initSchema after a failed acquire', 60_000, engine.initSchema());
      expect(await db.heldLock42()).toBe(0);
    } finally {
      await engine.disconnect();
      await db.drop();
    }
  }, 240_000);
});
