import { describe, expect, spyOn, test } from 'bun:test';
import { CRASH_BOUNDARIES, runValidation } from '../../scripts/persistence/validate.ts';
import { createConnection, createServer, Socket } from 'node:net';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer as createTlsServer } from 'node:tls';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { withEnv } from '../helpers/with-env.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres process-separated journal concurrency', () => {
  test('isolated database verifies competing principals, publication boundaries and durable recovery', async () => {
    const result = await runValidation({ engine: 'postgres', databaseUrl: url, schedules: 50, operations: 64, seed: 5105 });
    expect(result.status).toBe('passed'); expect(result.full_gate).toBe(false);
    expect(CRASH_BOUNDARIES).toHaveLength(8);
    expect(result.crash_cases.map((entry: { boundary: string }) => entry.boundary)).toEqual([...CRASH_BOUNDARIES]);
    expect(result.crash_cases.find((entry: { boundary: string }) => entry.boundary === 'staging_flushed').flushed_before_rename_verified).toBe(true);
    expect(result.crash_cases.find((entry: { boundary: string }) => entry.boundary === 'staging_flushed').unexpected_staging_preserved).toBe(true);
    expect(result.crash_cases.find((entry: { boundary: string }) => entry.boundary === 'after_response').response_read_before_kill).toBe(true);
    expect(Object.values(result.schedules.cases)).toEqual(Array(10).fill(5));
    expect(Object.values(result.schedules.boundaries)).toEqual(Array(5).fill(1));
    expect(result.soak.owner_processes).toBe(2); expect(result.soak.producer_processes).toBe(4);
    expect(result.soak.verified).toBe(64);
  }, 120_000);
});

describe.skipIf(!url)('Postgres cancellation ownership', () => {
  async function fixture(run: (ctx: {
    engine: PostgresEngine; observer: postgres.Sql; proxyUrl: string;
    cancelHeld: () => boolean; releaseCancel: () => void;
    stopAccepting: () => Promise<void>; restart: () => Promise<void>;
    closeQueryConnections: () => void;
    pauseQueries: () => void; resumeQueries: () => void; failNextStartup: () => void;
  }) => Promise<void>, options: { tls?: boolean; targetUrl?: string; observerUrl?: string } = {}) {
    assertSafeE2eDatabaseUrl(options.targetUrl ?? url!);
    assertSafeE2eDatabaseUrl(options.observerUrl ?? url!);
    const target = new URL(options.targetUrl ?? url!);
    const sockets = new Set<Socket>();
    const querySockets = new Set<Socket>();
    let held: (() => void) | undefined;
    let rejectStartup = false;
    const accept = (client: Socket) => {
      sockets.add(client);
      client.once('close', () => { sockets.delete(client); querySockets.delete(client); });
      client.on('error', () => {});
      const chunks: Buffer[] = [];
      const receive = (data: Buffer) => {
        chunks.push(data);
        const initial = Buffer.concat(chunks);
        if (initial.length < 8) return;
        client.removeListener('data', receive);
        client.pause();
        if (rejectStartup && initial.readInt32BE(4) === 196608) {
          rejectStartup = false;
          const body = Buffer.from('SFATAL\0C28000\0Msynthetic startup rejection\0\0');
          const length = Buffer.alloc(4);
          length.writeUInt32BE(body.length + 4);
          client.end(Buffer.concat([Buffer.from('E'), length, body]));
          return;
        }
        const forward = () => {
          const upstream = createConnection({ host: target.hostname, port: Number(target.port) || 5432 });
          sockets.add(upstream);
          upstream.once('close', () => { sockets.delete(upstream); querySockets.delete(upstream); });
          upstream.on('error', () => client.destroy());
          client.on('error', () => upstream.destroy());
          upstream.once('connect', () => {
            upstream.write(initial);
            client.pipe(upstream);
            upstream.pipe(client);
            client.resume();
          });
          return upstream;
        };
        if (initial.readInt32BE(0) === 16 && initial.readInt32BE(4) === 80877102) held = () => { if (!client.destroyed) forward(); };
        else { querySockets.add(client); querySockets.add(forward()); }
      };
      client.on('data', receive);
    };
    const server = options.tls ? createTlsServer({
      cert: readFileSync(new URL('../fixtures/guarded-http-localhost.crt', import.meta.url)),
      key: readFileSync(new URL('../fixtures/guarded-http-localhost.key', import.meta.url)),
      ALPNProtocols: ['postgresql'],
    }, accept) : createServer(accept);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test proxy port');
    const proxy = new URL(options.targetUrl ?? url!);
    proxy.hostname = '127.0.0.1';
    proxy.port = String(address.port);
    const engine = new PostgresEngine();
    const observer = postgres(options.observerUrl ?? url!, { max: 1, prepare: false });
    const releaseCancel = () => { const release = held; held = undefined; release?.(); };
    try {
      await withEnv({ GBRAIN_DIRECT_DATABASE_URL: undefined }, () => run({
        engine, observer, proxyUrl: proxy.toString(), cancelHeld: () => !!held, releaseCancel,
        stopAccepting: () => new Promise<void>(resolve => server.close(() => resolve())),
        restart: () => new Promise<void>(resolve => server.listen(address.port, '127.0.0.1', resolve)),
        closeQueryConnections: () => { for (const socket of querySockets) socket.destroy(); },
        pauseQueries: () => { for (const socket of querySockets) socket.pause(); },
        resumeQueries: () => { for (const socket of querySockets) socket.resume(); },
        failNextStartup: () => { rejectStartup = true; },
      }));
    } finally {
      releaseCancel();
      await engine.disconnect();
      await observer.end();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  for (const route of ['ordinary', 'direct', 'transaction', 'tls'] as const) {
    test(`${route} parameterized queries retain ownership until a delayed CancelRequest settles`, () => fixture(async ctx => {
      await withEnv({ GBRAIN_DIRECT_DATABASE_URL: route === 'direct' ? ctx.proxyUrl : undefined }, async () => {
        const target = new URL(route === 'direct' ? url! : ctx.proxyUrl);
        if (route === 'tls') { target.searchParams.set('sslmode', 'require'); target.searchParams.set('sslnegotiation', 'direct'); }
        await ctx.engine.connect({ database_url: target.toString(), poolSize: 1 });
        const execute = route === 'direct' ? ctx.engine.executeRawDirect.bind(ctx.engine) : ctx.engine.executeRaw.bind(ctx.engine);
        const [{ pid }] = await execute<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const abort = new AbortController();
        let firstSettled = false;
        let successorStarted = false;
        const run = async (engine: PostgresEngine) => {
          const call = route === 'direct' ? engine.executeRawDirect.bind(engine) : engine.executeRaw.bind(engine);
          await call('SELECT pg_sleep($1) AS cancellation_victim', [0.2], { signal: abort.signal });
          firstSettled = true;
          successorStarted = true;
          return call('SELECT 42 AS answer');
        };
        const work = route === 'transaction' ? ctx.engine.transaction(tx => run(tx as PostgresEngine)) : run(ctx.engine);
        void work.catch(() => {});
        try {
          await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('cancellation_victim'), { timeoutMs: 5000 });
          abort.abort();
          await waitFor(ctx.cancelHeld, { timeoutMs: 5000 });
          await waitFor(async () => (await ctx.observer`SELECT state FROM pg_stat_activity WHERE pid=${pid}`)[0]?.state.startsWith('idle'), { timeoutMs: 5000 });
          expect(firstSettled).toBe(false);
          expect(successorStarted).toBe(false);
          ctx.releaseCancel();
          expect(await work).toEqual([{ answer: 42 }]);
        } finally { ctx.releaseCancel(); await work.catch(() => {}); }
      });
    }, { tls: route === 'tls' }), 30000);
  }

  test('active parameterized queries are cancelled without poisoning the next statement', () => fixture(async ctx => {
    await ctx.engine.connect({ database_url: ctx.proxyUrl, poolSize: 1 });
    const [{ pid }] = await ctx.engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const abort = new AbortController();
    const work = ctx.engine.executeRaw('SELECT pg_sleep($1) AS cancellation_victim', [10], { signal: abort.signal }).catch(error => error);
    await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('cancellation_victim'), { timeoutMs: 5000 });
    abort.abort();
    await waitFor(ctx.cancelHeld, { timeoutMs: 5000 });
    ctx.releaseCancel();
    expect(await work).toMatchObject({ code: '57014' });
    expect(await ctx.engine.executeRaw('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
  }), 30000);

  test('a cancelled queued empty query cannot supply an unrelated read with its response', () => fixture(async ctx => {
    await ctx.engine.connect({ database_url: ctx.proxyUrl, poolSize: 1 });
    const [{ pid }] = await ctx.engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await ctx.observer`SELECT pg_advisory_lock(${pid},5406)`;
    const gate = ctx.engine.executeRaw(`SELECT pg_advisory_xact_lock(${pid},5406)`);
    try {
      await waitFor(async () => (await ctx.observer`SELECT wait_event FROM pg_stat_activity WHERE pid=${pid}`)[0]?.wait_event === 'advisory');
      const abort = new AbortController();
      const cancelled = ctx.engine.executeRaw('SELECT 1 WHERE false', undefined, { signal: abort.signal }).catch(error => error);
      const successor = ctx.engine.executeRaw('SELECT 42 AS answer');
      await Bun.sleep(30);
      abort.abort();
      expect(await cancelled).toMatchObject({ name: 'AbortError' });
      await ctx.observer`SELECT pg_advisory_unlock(${pid},5406)`;
      await gate;
      expect(await successor).toEqual([{ answer: 42 }]);
      expect(ctx.cancelHeld()).toBe(false);
    } finally { await ctx.observer`SELECT pg_advisory_unlock(${pid},5406)`; await gate; }
  }), 30000);

  test.skipIf(!process.env.GBRAIN_PGBOUNCER_URL || !process.env.GBRAIN_PGBOUNCER_DIRECT_URL)('a late pooler cancellation cannot hit another client reusing the same backend', async () => {
    const direct = process.env.GBRAIN_PGBOUNCER_DIRECT_URL!;
    assertSafeE2eDatabaseUrl(direct);
    const admin = postgres(direct, { max: 1, prepare: false });
    const database = `gbrain_test_cancel_pool_${randomUUID().replaceAll('-', '')}`;
    const pooled = new URL(process.env.GBRAIN_PGBOUNCER_URL!);
    pooled.pathname = `/${database}`;
    try {
      await admin.unsafe(`CREATE DATABASE ${database}`);
      await fixture(async ctx => {
        const other = postgres(pooled.toString(), { max: 1, prepare: false });
        try {
          await ctx.engine.connect({ database_url: ctx.proxyUrl, poolSize: 1 });
          const [{ pid }] = await ctx.engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          const abort = new AbortController();
          const first = ctx.engine.executeRaw('SELECT pg_sleep($1) AS cancellation_victim', [0.2], { signal: abort.signal });
          void first.catch(() => {});
          await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('cancellation_victim'));
          abort.abort();
          await waitFor(ctx.cancelHeld);
          await waitFor(async () => (await ctx.observer`SELECT state FROM pg_stat_activity WHERE pid=${pid}`)[0]?.state === 'idle');
          const competitor = other.unsafe('SELECT pg_backend_pid() AS pid, pg_sleep(0.3) AS pooler_successor').execute();
          void competitor.catch(() => {});
          await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('pooler_successor'));
          ctx.releaseCancel();
          await first;
          expect((await competitor)[0].pid).toBe(pid);
          expect(await ctx.engine.executeRaw('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
        } finally { ctx.releaseCancel(); await other.end({ timeout: 1 }); }
      }, { targetUrl: pooled.toString(), observerUrl: direct });
    } finally { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); }
  }, 30000);

  test('transaction cancellation fences concurrent tagged queries and nested savepoints', () => fixture(async ctx => {
    await ctx.engine.connect({ database_url: ctx.proxyUrl, poolSize: 1 });
    const [{ pid }] = await ctx.engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const abort = new AbortController();
    let taggedSettled = false, nestedSettled = false;
    const submitted = Promise.withResolvers<void>();
    const work = ctx.engine.transaction(async tx => {
      const first = tx.executeRaw('SELECT pg_sleep($1) AS cancellation_victim', [0.2], { signal: abort.signal });
      await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('cancellation_victim'), { timeoutMs: 5000 });
      const tagged = (tx as PostgresEngine).sql`SELECT 42 AS answer`.then(rows => { taggedSettled = true; return rows; });
      const nested = tx.transaction(inner => inner.executeRaw('SELECT 7 AS answer')).then(rows => { nestedSettled = true; return rows; });
      submitted.resolve();
      return Promise.all([first, tagged, nested]);
    });
    void work.catch(error => submitted.reject(error));
    void work.catch(() => {});
    try {
      await submitted.promise;
      abort.abort();
      await waitFor(ctx.cancelHeld, { timeoutMs: 5000 });
      await waitFor(async () => (await ctx.observer`SELECT state FROM pg_stat_activity WHERE pid=${pid}`)[0]?.state === 'idle in transaction', { timeoutMs: 5000 });
      expect([taggedSettled, nestedSettled]).toEqual([false, false]);
      ctx.releaseCancel();
      const result = await work;
      expect(Array.from(result[1])).toEqual([{ answer: 42 }]);
      expect(result[2]).toEqual([{ answer: 7 }]);
    } finally { ctx.releaseCancel(); await work.catch(() => {}); }
  }), 30000);

  test('cancelling an unsent transaction query drains its followers without a CancelRequest', () => fixture(async ctx => {
    await ctx.engine.connect({ database_url: ctx.proxyUrl, poolSize: 1 });
    const [{ pid }] = await ctx.engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const abort = new AbortController();
    let follower: unknown;
    const result = await ctx.engine.transaction(async tx => {
      const previous = tx.executeRaw('SELECT pg_sleep($1) AS cancellation_predecessor', [0.2]);
      const cancelled = tx.executeRaw('SELECT pg_sleep($1)', [10], { signal: abort.signal }).catch(error => error);
      await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('cancellation_predecessor'), { timeoutMs: 5000 });
      abort.abort();
      expect(await cancelled).toMatchObject({ code: '57014' });
      const next = tx.executeRaw('SELECT 42 AS answer');
      await previous;
      follower = await next;
    }).catch(error => error);
    expect(result).toMatchObject({ code: '57014' });
    expect(follower).toEqual([{ answer: 42 }]);
    expect(ctx.cancelHeld()).toBe(false);
    expect(await ctx.engine.executeRaw('SELECT 7 AS answer')).toEqual([{ answer: 7 }]);
  }), 30000);

  test('a cancellation transport timeout retires the transaction and rejects queued followers', () => fixture(async ctx => {
    const pool = postgres(ctx.proxyUrl, { max: 1, prepare: false, connect_timeout: 1 });
    try {
      const [{ pid }] = await pool`SELECT pg_backend_pid() AS pid`;
      const submitted = Promise.withResolvers<void>();
      let first: postgres.PendingQuery<postgres.Row[]>;
      const work = pool.begin(async tx => {
        first = tx.unsafe<postgres.Row[]>('SELECT pg_sleep($1) AS cancellation_victim', [0.2], { cancelFence: true }).execute();
        await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('cancellation_victim'), { timeoutMs: 5000 });
        const follower = tx`SELECT 42 AS answer`.execute();
        void follower.catch(() => {});
        submitted.resolve();
        await first;
        return follower;
      }).catch(error => error);
      await submitted.promise;
      const cancellation = first!.cancel().catch(error => error);
      await waitFor(ctx.cancelHeld);
      expect(await cancellation).toMatchObject({ code: 'CONNECT_TIMEOUT' });
      expect(await work).toMatchObject({ code: 'CONNECTION_CLOSED' });
      const [{ pid: replacement }] = await pool`SELECT pg_backend_pid() AS pid`;
      expect(replacement).not.toBe(pid);
    } finally { ctx.releaseCancel(); await pool.end({ timeout: 1 }); }
  }), 30000);

  test('multi-host cancellation connection errors cannot masquerade as acknowledgement', () => fixture(async ctx => {
    const port = Number(new URL(ctx.proxyUrl).port);
    const pool = postgres(ctx.proxyUrl, { host: '127.0.0.1,127.0.0.1', port, max: 1, prepare: false });
    try {
      const owned = await pool.reserve();
      const [{ pid }] = await owned`SELECT pg_backend_pid() AS pid`;
      const first = owned.unsafe('SELECT pg_sleep($1) AS cancellation_victim', [0.2], { cancelFence: true }).execute();
      await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('cancellation_victim'));
      const stopped = ctx.stopAccepting();
      const cancellation = first.cancel().catch(error => error);
      await first;
      expect(await cancellation).toMatchObject({ code: 'ECONNREFUSED' });
      owned.release();
      await stopped;
      await ctx.restart();
      expect((await pool`SELECT pg_backend_pid() AS pid`)[0].pid).not.toBe(pid);
    } finally { await pool.end({ timeout: 1 }); }
  }), 30000);

  test('a failed cancellation connection retires only its completed query connection', () => fixture(async ctx => {
    await ctx.engine.connect({ database_url: ctx.proxyUrl, poolSize: 1 });
    const [{ pid }] = await ctx.engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const abort = new AbortController();
    const work = ctx.engine.executeRaw('SELECT pg_sleep($1) AS cancellation_victim', [0.2], { signal: abort.signal });
    void work.catch(() => {});
    await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('cancellation_victim'), { timeoutMs: 5000 });
    const stopped = ctx.stopAccepting();
    abort.abort();
    await work;
    await stopped;
    await ctx.restart();
    const [{ pid: replacement }] = await ctx.engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(replacement).not.toBe(pid);
  }), 30000);

  test('late cancellation cleanup cannot release a replacement connection after socket loss', () => fixture(async ctx => {
    await ctx.engine.connect({ database_url: ctx.proxyUrl, poolSize: 1 });
    const [{ pid }] = await ctx.engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const abort = new AbortController();
    const work = ctx.engine.executeRaw('SELECT pg_sleep($1) AS cancellation_victim', [0.2], { signal: abort.signal });
    void work.catch(() => {});
    await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('cancellation_victim'), { timeoutMs: 5000 });
    abort.abort();
    await waitFor(ctx.cancelHeld, { timeoutMs: 5000 });
    await waitFor(async () => (await ctx.observer`SELECT state FROM pg_stat_activity WHERE pid=${pid}`)[0]?.state === 'idle', { timeoutMs: 5000 });
    ctx.closeQueryConnections();
    const replacement = ctx.engine.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid, pg_sleep($1) AS replacement_owner', [0.2], { signal: new AbortController().signal });
    void replacement.catch(() => {});
    await waitFor(async () => (await ctx.observer`SELECT pid FROM pg_stat_activity WHERE pid<>${pid} AND state='active' AND query LIKE '%AS replacement_owner'`).length === 1, { timeoutMs: 5000 });
    ctx.releaseCancel();
    await work;
    expect((await replacement)[0].pid).not.toBe(pid);
    expect(await ctx.engine.executeRaw('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
  }), 30000);

  const drivers = { esm: postgres, commonjs: createRequire(import.meta.url)('../../node_modules/postgres/cjs/src/index.js') as typeof postgres };
  for (const [name, driver] of Object.entries(drivers)) {
    test(`${name} releasing a lease during pool shutdown cannot grant its waiter`, async () => {
      assertSafeE2eDatabaseUrl(url!);
      const pool = driver(url!, { max: 1, prepare: false });
      const lease = await pool.reserve();
      let granted: postgres.ReservedSql | undefined;
      try {
        const active = lease`SELECT pg_sleep(0.1)`.execute();
        await waitFor(() => Reflect.get(active, 'active') === true);
        const waiting = pool.reserve().then(value => { granted = value; return value; });
        void waiting.catch(() => {});
        const ending = pool.end({ timeout: 1 });
        await active; lease.release();
        await ending;
        await expect(waiting).rejects.toMatchObject({ code: 'CONNECTION_ENDED' });
        expect(granted).toBeUndefined();
      } finally { lease.discard(); granted?.discard(); await pool.end({ timeout: 1 }); }
    }, 30000);

    test(`${name} ending a pool rejects a pending reservation without reconnecting`, async () => {
      assertSafeE2eDatabaseUrl(url!);
      const pool = driver(url!, { max: 1, prepare: false });
      let granted: postgres.ReservedSql | undefined;
      try {
        await pool`SELECT 1`;
        const active = pool`SELECT pg_sleep(0.1)`.execute();
        await waitFor(() => Reflect.get(active, 'active') === true);
        const waiting = pool.reserve({ signal: new AbortController().signal }).then(lease => { granted = lease; return lease; });
        void waiting.catch(() => {});
        await pool.end({ timeout: 1 });
        await active;
        await expect(waiting).rejects.toMatchObject({ code: 'CONNECTION_ENDED' });
        expect(granted).toBeUndefined();
      } finally { granted?.discard(); await pool.end({ timeout: 1 }); }
    }, 30000);

    test(`${name} unfenced transaction followers resume pipelining after a parameter description`, async () => {
      assertSafeE2eDatabaseUrl(url!);
      const pool = driver(url!, { max: 1, prepare: false });
      try {
        await pool.begin(async tx => {
          const previous = tx`SELECT pg_sleep(${0.1})`.execute();
          const first = tx`SELECT pg_sleep(0.1)`.execute();
          const follower = tx`SELECT 42 AS answer`.execute();
          await previous;
          expect(Reflect.get(first, 'state')).not.toBeNull();
          expect(Reflect.get(follower, 'state')).not.toBeNull();
          await first;
          expect(Array.from(await follower)).toEqual([{ answer: 42 }]);
        });
      } finally { await pool.end({ timeout: 1 }); }
    }, 30000);

    for (const warm of [false, true]) {
      test(`${name} reservation opens ${warm ? 'after reconnect without another type fetch' : 'with type fetching disabled'}`, async () => {
        assertSafeE2eDatabaseUrl(url!);
        const closed = Promise.withResolvers<void>();
        const pool = driver(url!, { max: 1, prepare: false, fetch_types: warm, onclose: () => closed.resolve() });
        const observer = postgres(url!, { max: 1, prepare: false });
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (warm) {
            const [{ pid }] = await pool`SELECT pg_backend_pid() AS pid`;
            await observer`SELECT pg_terminate_backend(${pid})`;
            await closed.promise;
          }
          timer = setTimeout(() => abort.abort(), 2000);
          const lease = await pool.reserve({ signal: abort.signal });
          expect(Array.from(await lease`SELECT 42 AS answer`)).toEqual([{ answer: 42 }]);
          lease.release();
        } finally { clearTimeout(timer); await pool.end({ timeout: 1 }); await observer.end({ timeout: 1 }); }
      }, 30000);
    }

    test(`${name} cancelling a completed cursor settles without a new cancel request`, async () => {
      assertSafeE2eDatabaseUrl(url!);
      const pool = driver(url!, { max: 1, prepare: false });
      try {
        const lease = await pool.reserve();
        const query = lease`SELECT generate_series(1, 2) AS n`;
        const values: number[] = [];
        for await (const rows of query.cursor(1)) values.push(...rows.map(row => row.n));
        expect(values).toEqual([1, 2]);
        expect(await Promise.race([query.cancel().then(() => true), Bun.sleep(50).then(() => false)])).toBe(true);
        expect(Array.from(await lease`SELECT 42 AS answer`)).toEqual([{ answer: 42 }]);
        lease.release();
      } finally { await pool.end({ timeout: 1 }); }
    }, 30000);

    test(`${name} a saved savepoint handle cannot enter a replacement transaction`, async () => {
      assertSafeE2eDatabaseUrl(url!);
      const pool = driver(url!, { max: 1, prepare: false });
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      let stale: postgres.TransactionSql | undefined;
      let replacement: Promise<unknown> | undefined;
      try {
        await pool.begin(async tx => { stale = tx; await tx`SELECT 1`; });
        replacement = pool.begin(async tx => { entered.resolve(); await release.promise; return tx`SELECT 7 AS answer`; });
        void replacement.catch(() => {});
        await entered.promise;
        await expect(stale!.savepoint(tx => tx`SELECT 42 AS answer`)).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
        stale!.discard();
        release.resolve();
        expect(Array.from(await replacement as postgres.Row[])).toEqual([{ answer: 7 }]);
      } finally { release.resolve(); await replacement?.catch(() => {}); await pool.end({ timeout: 1 }); }
    }, 30000);

    test(`${name} an ended pool rejects a new reservation without waiting`, async () => {
      assertSafeE2eDatabaseUrl(url!);
      const pool = driver(url!, { max: 1, prepare: false });
      await pool`SELECT 1`;
      await pool.end();
      await expect(pool.reserve()).rejects.toMatchObject({ code: 'CONNECTION_ENDED' });
    }, 30000);

    test(`${name} transaction ownership survives actual socket backpressure`, () => fixture(async ctx => {
      const pool = driver(ctx.proxyUrl, { max: 1, prepare: false });
      const write = Socket.prototype.write;
      let backpressure = false;
      const writes = spyOn(Socket.prototype, 'write').mockImplementation(function(this: Socket, ...args: unknown[]) {
        const ready = Reflect.apply(write, this, args);
        if (!ready && this.remotePort === Number(new URL(ctx.proxyUrl).port) && args[0] instanceof Uint8Array && args[0].byteLength > 65536) backpressure = true;
        return ready;
      });
      let work: Promise<unknown> | undefined;
      try {
        await pool`SELECT 1`;
        ctx.pauseQueries();
        work = pool.begin(' '.repeat(8 * 1024 * 1024), tx => tx`SELECT 42 AS answer`);
        void work.catch(() => {});
        await waitFor(() => backpressure, { label: 'actual write backpressure' });
        ctx.resumeQueries();
        const rows = await work as postgres.Row[];
        expect(Array.from(rows)).toEqual([{ answer: 42 }]);
        expect(backpressure).toBe(true);
      } finally { ctx.resumeQueries(); writes.mockRestore(); await work?.catch(() => {}); await pool.end({ timeout: 1 }); }
    }), 30000);

    test(`${name} a rejected cold reservation cannot consume the replacement connection`, () => fixture(async ctx => {
      const pool = driver(ctx.proxyUrl, { max: 1, prepare: false });
      try {
        ctx.failNextStartup();
        await expect(pool.reserve()).rejects.toMatchObject({ code: '28000' });
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 2000);
        try {
          const next = await pool.reserve({ signal: abort.signal });
          expect(Array.from(await next`SELECT 42 AS answer`)).toEqual([{ answer: 42 }]);
          next.release();
        } finally { clearTimeout(timer); }
      } finally { await pool.end({ timeout: 1 }); }
    }), 30000);

    test(`${name} a granted reservation excludes a competing transaction continuation`, () => fixture(async ctx => {
      const pool = driver(ctx.proxyUrl, { max: 1, prepare: false });
      const release = Promise.withResolvers<void>();
      let lease: postgres.ReservedSql | undefined;
      let competing: Promise<unknown> | undefined;
      try {
        const [{ pid }] = await pool`SELECT pg_backend_pid() AS pid`;
        const previous = pool`SELECT pg_sleep(0.1) AS reservation_predecessor`.execute();
        await waitFor(async () => (await ctx.observer`SELECT query FROM pg_stat_activity WHERE pid=${pid} AND state='active'`)[0]?.query.includes('reservation_predecessor'));
        let entered = false;
        competing = previous.then(() => pool.begin(async tx => { entered = true; await release.promise; return tx`SELECT 7 AS answer`; }));
        void competing.catch(() => {});
        lease = await pool.reserve();
        expect(Array.from(await lease`SELECT 42 AS answer`)).toEqual([{ answer: 42 }]);
        await Bun.sleep(30);
        expect(entered).toBe(false);
        lease.release();
        lease = undefined;
        await waitFor(() => entered);
        release.resolve();
        expect(Array.from(await competing as postgres.Row[])).toEqual([{ answer: 7 }]);
      } finally { lease?.release(); release.resolve(); await competing?.catch(() => {}); await pool.end({ timeout: 1 }); }
    }), 30000);

    for (const timing of ['waiting', 'granted'] as const) {
      test(`${name} aborting a ${timing} reservation returns the only connection`, async () => {
        assertSafeE2eDatabaseUrl(url!);
        const pool = driver(url!, { max: 1, prepare: false });
        try {
          const held = await pool.reserve();
          const abort = new AbortController();
          const waiting = pool.reserve({ signal: abort.signal });
          if (timing === 'granted') held.release();
          abort.abort();
          if (timing === 'waiting') held.release();
          await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
          const successor = await pool.reserve();
          expect(Array.from(await successor`SELECT 42 AS answer`)).toEqual([{ answer: 42 }]);
          successor.release();
        } finally { await pool.end({ timeout: 1 }); }
      }, 30000);
    }

    test(`${name} stale reservations cannot query, release or discard a replacement owner`, async () => {
      assertSafeE2eDatabaseUrl(url!);
      const pool = driver(url!, { max: 1, prepare: false });
      const observer = driver(url!, { max: 1, prepare: false });
      let replacement: postgres.ReservedSql | undefined;
      try {
        const original = await pool.reserve();
        const [{ pid }] = await original`SELECT pg_backend_pid() AS pid`;
        await observer`SELECT pg_terminate_backend(${pid})`;
        replacement = await pool.reserve();
        const [{ pid: nextPid }] = await replacement`SELECT pg_backend_pid() AS pid`;
        expect(nextPid).not.toBe(pid);
        original.release();
        original.discard();
        await expect(original`SELECT 1`.execute()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
        let acquired = false;
        const waiting = pool.reserve().then(value => { acquired = true; return value; });
        await Bun.sleep(30);
        expect(acquired).toBe(false);
        expect(Array.from(await replacement`SELECT 42 AS answer`)).toEqual([{ answer: 42 }]);
        replacement.release();
        replacement = undefined;
        (await waiting).release();
      } finally { replacement?.release(); await pool.end({ timeout: 1 }); await observer.end(); }
    }, 30000);
  }
});
