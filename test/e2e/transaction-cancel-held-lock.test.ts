/**
 * #6598: an aborted `engine.transaction(fn, { signal })` cancels the statement it is running instead of only closing
 * the socket. A Terminate on a busy connection does not interrupt the backend: a statement waiting on a row lock keeps
 * waiting (holding its own locks and the pooler's server connection) until the lock frees or its statement timeout
 * fires. With the vendored `cancelAndDiscard()` the transaction's abort listener sends the fenced statement's
 * CancelRequest before discarding, so the backend stops while the blocking lock is still held.
 *
 * Protects, on direct Postgres (`DATABASE_URL`) and through transaction-mode PgBouncer (`GBRAIN_PGBOUNCER_URL` +
 * `GBRAIN_PGBOUNCER_DIRECT_URL`, the CI fixture): the aborted transaction rejects with `AbortError` well inside the
 * statement timeout; an observer connection sees no backend still running the blocked statement BEFORE the lock holder
 * lets go; after the holder commits, neither the blocked UPDATE nor the transaction's earlier INSERT is applied (the
 * late statement never commits); the engine serves the next caller. Fails on master: the abort only discards, the
 * backend stays in `Lock` wait until the holder releases, and the observer finds it active.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const directUrl = process.env.DATABASE_URL;
const pooled = process.env.GBRAIN_PGBOUNCER_URL;
const pooledDirect = process.env.GBRAIN_PGBOUNCER_DIRECT_URL;
const pooledAvailable = Boolean(pooled && pooledDirect);
if (process.env.GBRAIN_CI_REQUIRE_PGBOUNCER === '1' && !pooledAvailable) throw new Error('The transaction-cancel pooled arm requires the configured CI PgBouncer fixture.');

const MARK = `w18b_6598_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

interface Arm {
  engine: PostgresEngine;
  holder: ReturnType<typeof postgres>;
  observer: ReturnType<typeof postgres>;
  cleanup: () => Promise<void>;
}

async function openArm(engineUrl: string, adminUrl: string): Promise<Arm> {
  const engine = new PostgresEngine();
  await engine.connect({ engine: 'postgres', database_url: engineUrl, poolSize: 2 });
  const holder = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  const observer = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  await engine.executeRaw(`CREATE TABLE ${MARK}_rows (id int PRIMARY KEY, v int NOT NULL)`);
  await engine.executeRaw(`CREATE TABLE ${MARK}_log (x int)`);
  await engine.executeRaw(`INSERT INTO ${MARK}_rows VALUES (1, 0)`);
  return {
    engine, holder, observer,
    cleanup: async () => {
      await engine.executeRaw(`DROP TABLE IF EXISTS ${MARK}_rows`).catch(() => {});
      await engine.executeRaw(`DROP TABLE IF EXISTS ${MARK}_log`).catch(() => {});
      await engine.disconnect();
      await holder.end();
      await observer.end();
    },
  };
}

async function blockedBackends(observer: ReturnType<typeof postgres>): Promise<Array<{ pid: number; state: string; wait: string | null }>> {
  return observer.unsafe(
    `SELECT pid, state, wait_event_type AS wait FROM pg_stat_activity
      WHERE query LIKE $1 AND query NOT LIKE '%pg_stat_activity%' AND state <> 'idle'`,
    [`%${MARK}_blocked%`],
  ) as unknown as Promise<Array<{ pid: number; state: string; wait: string | null }>>;
}

async function waitFor(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return predicate();
}

async function scenario(arm: Arm): Promise<void> {
  const { engine, holder, observer } = arm;
  const release = Promise.withResolvers<void>();
  const locked = Promise.withResolvers<void>();
  const holding = holder.begin(async sql => {
    await sql.unsafe(`SELECT v FROM ${MARK}_rows WHERE id = 1 FOR UPDATE`);
    locked.resolve();
    await release.promise;
    await sql.unsafe(`UPDATE ${MARK}_rows SET v = 100 WHERE id = 1`);
  });
  await locked.promise;

  const ac = new AbortController();
  const started = Date.now();
  const tx = engine.transaction(async t => {
    await t.executeRaw("SELECT set_config('statement_timeout', '30000', true)");
    await t.executeRaw(`INSERT INTO ${MARK}_log VALUES (1)`);
    await t.executeRaw(`UPDATE ${MARK}_rows SET v = v + 1 WHERE id = 1 /* ${MARK}_blocked */`, [], { signal: ac.signal });
    await t.executeRaw(`INSERT INTO ${MARK}_log VALUES (2)`);
  }, { signal: ac.signal }).then(() => null, (e: Error) => e);

  try {
    expect(await waitFor(async () => (await blockedBackends(observer)).some(r => r.wait === 'Lock'), 5000)).toBe(true);
    ac.abort(new Error('deadline'));
    const error = await Promise.race([tx, new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), 8000))]);
    expect(error).not.toBe('hung');
    expect((error as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(15000);
    // The holder still has the row: the blocked statement must already be gone from the server.
    const stopped = await waitFor(async () => (await blockedBackends(observer)).length === 0, 1500);
    if (!stopped) console.log(JSON.stringify({ evidence: 'blocked_backend_still_active', rows: await blockedBackends(observer) }));
    expect(stopped).toBe(true);
  } finally {
    release.resolve();
    await holding;
  }

  const [row] = await engine.executeRaw<{ v: number }>(`SELECT v FROM ${MARK}_rows WHERE id = 1`);
  expect(row!.v).toBe(100);
  await new Promise(resolve => setTimeout(resolve, 300));
  expect((await engine.executeRaw<{ v: number }>(`SELECT v FROM ${MARK}_rows WHERE id = 1`))[0]!.v).toBe(100);
  expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${MARK}_log`))[0]!.n).toBe(0);
  expect(await engine.executeRaw<{ x: number }>('SELECT 1 AS x')).toEqual([{ x: 1 }]);
  expect(engine.getPoolDiagnostics()?.tracked.tx).toBe(0);
}

describe.skipIf(!directUrl)('aborted transaction cancels its lock-blocked statement (direct Postgres)', () => {
  let arm: Arm;
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(directUrl!);
    arm = await openArm(directUrl!, directUrl!);
  }, 60_000);
  afterAll(async () => { await arm?.cleanup(); });

  test('the blocked statement stops before the lock holder releases, and nothing the transaction wrote commits', async () => {
    await scenario(arm);
  }, 30_000);
});

describe.skipIf(!pooledAvailable)('aborted transaction cancels its lock-blocked statement (PgBouncer transaction mode)', () => {
  let arm: Arm;
  let admin: ReturnType<typeof postgres>;
  let database: string;
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(pooledDirect!);
    database = `gbrain_test_tx_cancel_${randomUUID().replaceAll('-', '')}`;
    admin = postgres(pooledDirect!, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const engineUrl = new URL(pooled!);
    engineUrl.pathname = `/${database}`;
    engineUrl.searchParams.set('prepare', 'false');
    const adminUrl = new URL(pooledDirect!);
    adminUrl.pathname = `/${database}`;
    arm = await openArm(engineUrl.toString(), adminUrl.toString());
  }, 60_000);
  afterAll(async () => {
    await arm?.cleanup();
    if (admin) { try { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); } }
  });

  test('the blocked statement stops before the lock holder releases, and nothing the transaction wrote commits', async () => {
    await scenario(arm);
  }, 30_000);
});
