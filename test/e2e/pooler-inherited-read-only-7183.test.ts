/**
 * #7183: gbrain writes through server connections whose transactions default to read-only.
 *
 * A client that runs a session-level `SET default_transaction_read_only = on` through a transaction-mode pooler can
 * leave that default on a server connection other clients then borrow; a role or database default does the same for
 * every connection. This file reproduces that server state with a database-level default on a scratch database (the
 * session leak itself depends on the pooler build: PgBouncer 1.26 restores this setting per client), connects a fresh
 * engine (through PgBouncer in the backend matrix's pooled pass), and checks that the engine's transactions, its
 * autocommit statements, the database lease and the Minions queue still write, and that the stall detector reclaims an
 * `active` job left with an expired lock by a worker that died on the refused writes, leaving the drain-lease
 * holder record to its lease (#7261).
 *
 * Listed in scripts/e2e-backend-matrix.txt: run once on direct Postgres and once through transaction-mode PgBouncer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { tryAcquireDbLock } from '../../src/core/db-lock.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { waitFor } from '../helpers/wait-for.ts';

const target = process.env.DATABASE_URL;
const pooled = process.env.GBRAIN_TEST_BACKEND === 'pgbouncer';
const adminUrl = pooled ? process.env.GBRAIN_PGBOUNCER_DIRECT_URL : target;
const available = Boolean(target && adminUrl);
const describeDb = available ? describe : describe.skip;

let database = '';
let admin: ReturnType<typeof postgres> | undefined;
let engine: PostgresEngine | undefined;
let queue: MinionQueue;

const withDatabase = (url: string) => { const u = new URL(url); u.pathname = `/${database}`; return u.toString(); };

beforeAll(async () => {
  if (!available) return;
  assertSafeE2eDatabaseUrl(adminUrl!);
  database = `gbrain_test_ro_default_${randomUUID().replaceAll('-', '')}`;
  admin = postgres(adminUrl!, { max: 1, prepare: false, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${database}`);
  // Schema on a direct connection first: the pooler must open its server connections only after the default is set.
  const setup = new PostgresEngine();
  await setup.connect({ database_url: withDatabase(adminUrl!), poolSize: 2 });
  await setup.initSchema();
  await setup.disconnect();
  await admin.unsafe(`ALTER DATABASE ${database} SET default_transaction_read_only = on`);
  engine = new PostgresEngine();
  await engine.connect({ database_url: withDatabase(target!), poolSize: 4 });
  queue = new MinionQueue(engine);
}, 180_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (admin) {
    try { if (database) await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); }
    finally { await admin.end(); }
  }
});

describeDb(`writes on read-only-default server connections (${pooled ? 'pgbouncer' : 'postgres-direct'})`, () => {
  test('precondition: the borrowed server connection defaults to read-only, so the probe is not vacuous', async () => {
    const [row] = await engine!.executeRaw<{ v: string }>('SELECT current_setting($1) AS v', ['default_transaction_read_only']);
    expect(row.v).toBe('on');
  });

  test('an engine transaction writes', async () => {
    const id = `ro-${randomUUID().slice(0, 8)}`;
    await engine!.transaction(async tx => {
      await tx.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1)', [id]);
      await tx.executeRaw('SELECT id FROM sources WHERE id = $1 FOR SHARE', [id]);
    });
    expect(await engine!.executeRaw('SELECT 1 FROM sources WHERE id = $1', [id])).toHaveLength(1);
  });

  test('an autocommit write outside any transaction writes', async () => {
    const id = `ro-${randomUUID().slice(0, 8)}`;
    await engine!.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1)', [id]);
    expect(await engine!.executeRaw('SELECT 1 FROM sources WHERE id = $1', [id])).toHaveLength(1);
  });

  test('a deliberately read-only transaction still refuses a write', async () => {
    await expect(engine!.sql.begin('read only', tx => tx.unsafe("INSERT INTO sources(id, name) VALUES ('ro-never', 'ro-never')")))
      .rejects.toMatchObject({ code: '25006' });
  });

  test('the database lease is taken and released', async () => {
    const lockId = `ro-lease-${randomUUID().slice(0, 8)}`;
    const handle = await tryAcquireDbLock(engine!, lockId, 1);
    expect(handle).not.toBeNull();
    await handle!.release();
    expect(await engine!.executeRaw('SELECT 1 FROM gbrain_cycle_locks WHERE id = $1', [lockId])).toHaveLength(0);
  });

  test('a Minions job is queued, claimed, run and recorded failed by a worker', async () => {
    const job = await queue.add('ro-probe', {}, { max_attempts: 1 });
    const worker = new MinionWorker(engine!, { pollInterval: 50 });
    worker.register('ro-probe', async () => { throw new Error('handler failure'); });
    const running = worker.start();
    try {
      await waitFor(async () => (await queue.getJob(job.id))?.status === 'dead', { timeoutMs: 30_000, label: 'probe job recorded dead' });
    } finally {
      worker.stop();
      await running;
    }
    expect((await queue.getJob(job.id))!.error_text).toBe('handler failure');
  }, 60_000);

  test('the stall detector reclaims a job a worker left active with an expired lock, and leaves the drain-lease holder record (#7261)', async () => {
    const job = await queue.add('ro-stuck', {}, { max_attempts: 3 });
    const claimed = await queue.claim('dead-worker:1', 60_000, 'default', ['ro-stuck']);
    expect(claimed?.id).toBe(job.id);
    // The worker died on refused writes: its error is on the row, its lock stopped renewing and expired.
    await engine!.executeRaw(
      `UPDATE minion_jobs SET lock_until = now() - interval '5 minutes', error_text = 'cannot execute INSERT in a read-only transaction' WHERE id = $1`,
      [job.id]);
    const stuck = { id: job.id };
    // A live holder: its lease lock in gbrain_cycle_locks is current while its record's lock_until lags.
    const leaseToken = '00000000-0000-4000-8000-000000007261';
    await engine!.executeRaw(`INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
       VALUES ('gbrain-sync:source-a', 1, 'host-a', now() - interval '10 minutes', now() + interval '10 minutes', now(), $1::uuid)`, [leaseToken]);
    const [beacon] = await engine!.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs(name, queue, status, submission_authority, data, max_attempts, max_stalled, lock_token, lock_until, started_at, remove_on_complete, remove_on_fail)
       VALUES ('sync', 'gbrain-drain-lease', 'active', '{"version":1,"kind":"application"}'::jsonb, '{"sourceId":"source-a"}'::jsonb, 1, 0,
               $1, now() - interval '5 minutes', now() - interval '10 minutes', true, true) RETURNING id`, [leaseToken]);
    const { requeued, dead } = await queue.handleStalled(0);
    expect(requeued.map(j => j.id)).toEqual([stuck.id]);
    expect(dead).toEqual([]);
    expect(await queue.getJob(stuck.id)).toMatchObject({ status: 'waiting', stalled_counter: 1, lock_token: null });
    expect(await queue.getJob(Number(beacon.id))).toMatchObject({ status: 'active', attempts_made: 0 });
  });
});
