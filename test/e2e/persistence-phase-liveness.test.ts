import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect, type Socket } from 'node:net';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { admission, assertCommittedSnapshot, assertConservation, fixtures, initializeFixtures, prepared, selectFixtureHost, type HarnessConfig } from '../../scripts/persistence/harness.ts';
import { admitWrite, claimNextWrite, getWriteRequestById, prepareRecovery, renewWriteClaim } from '../../src/core/persistence/journal.ts';
import { PersistenceConsumer } from '../../src/core/persistence/consumer.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, waitForWrite } from '../../src/core/persistence/service.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('PostgreSQL persistence phase cancellation', () => {
  async function fixture(run: (pg: Awaited<ReturnType<typeof isolatedPersistencePostgres>>, config: HarnessConfig) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-phase-liveness-'));
    const pg = await isolatedPersistencePostgres(url!);
    const config: HarnessConfig = { kind: 'postgres', root, dataDir: join(root, 'unused'), hostId: randomUUID(),
      seed: 5406, schedules: 0, operations: 0, sourceIds: ['phase-first', 'phase-other'], principalIds: [randomUUID()] };
    try {
      await withEnv({ GBRAIN_HOME: root, GBRAIN_PERSISTENCE_FIXTURE_HOME: root }, async () => {
        selectFixtureHost(config.hostId);
        await initializeFixtures(pg.engine, config);
        await run(pg, config);
      });
    } finally { await pg.close(); rmSync(root, { recursive: true, force: true }); }
  }

  test('stopping before driver dispatch recognizes its prefixed cancellation error', () => fixture(async ({ engine }, config) => {
    await engine.executeRaw('SELECT 1');
    const errors: unknown[] = [];
    let cancellation: unknown;
    let stopping: Promise<void> | undefined;
    let consumer: PersistenceConsumer;
    const proxy = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return (...args: Parameters<typeof engine.executeRaw>) => {
        const work = target.executeRaw(...args);
        if (args[2]?.signal) queueMicrotask(() => { stopping = consumer.stop(); });
        return work.catch(error => { cancellation = error; throw error; });
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    consumer = new PersistenceConsumer(proxy, { engine: 'postgres' }, async () => { throw new Error('unexpected preparation'); },
      { hostId: config.hostId, onError: error => errors.push(error) });
    try {
      await consumer.tick(); await stopping;
      expect(cancellation).toMatchObject({ code: '57014', message: '57014: canceling statement due to user request' });
      expect(errors).toEqual([]);
      expect(consumer.status().last_error).toBeUndefined();
      expect(await engine.executeRaw('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
    } finally { await consumer.stop(); }
  }), 30000);

  test('a slow PostgreSQL receipt read cannot hide an independently committed request', () => fixture(async ({ engine }, config) => {
    const sources = await fixtures(engine, config);
    const first = await admitWrite(engine, admission(config, sources[0], 'slow-receipt', 'first body'));
    const second = await admitWrite(engine, admission(config, sources[1], 'independent-receipt', 'second body'));
    const publisher = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_e, row) => prepared(row, sources),
      { hostId: config.hostId });
    try {
      publisher.start();
      await waitFor(async () => (await getWriteRequestById(engine, second.id))?.state === 'committed', { timeoutMs: 5000 });
    } finally { await publisher.stop(); }
    let entered = false;
    const proxy = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return async (...args: Parameters<typeof engine.executeRaw>) => {
        if (args[0] === 'SELECT * FROM persistence_requests WHERE id=$1::uuid' && args[1]?.[0] === first.id) {
          entered = true;
          return target.executeRaw('SELECT r.* FROM persistence_requests r CROSS JOIN pg_sleep(20) WHERE r.id=$1::uuid', args[1], args[2]);
        }
        return target.executeRaw(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const consumer = startPersistenceConsumer(proxy, { engine: 'postgres' });
    (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
    const stalled = waitForWrite(proxy, first, { engine: 'postgres' });
    try {
      await waitFor(() => entered);
      const found = await waitForWrite(proxy, second, { engine: 'postgres' }, 1000);
      expect(found.id).toBe(second.id);
      expect(found.state).toBe('committed');
      await assertCommittedSnapshot(engine, found);
    } finally { await disposePersistenceConsumer(proxy); await stalled; }
    await assertConservation(engine);
  }), 30000);

  test('an expired locked head does not stall independent roots or skip its own follower', () => fixture(async ({ engine }, config) => {
    const sources = await fixtures(engine, config);
    const head = await admitWrite(engine, admission(config, sources[0], 'locked-head', 'head'));
    expect((await claimNextWrite(engine, config.hostId))?.id).toBe(head.id);
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.persistence_protocol','2',true)");
      await tx.executeRaw("UPDATE persistence_requests SET claim_expires_at=now()-interval '1 minute' WHERE id=$1::uuid", [head.id]);
    });
    const follower = await admitWrite(engine, admission(config, sources[0], 'follower', 'follower'));
    const independent = await admitWrite(engine, admission(config, sources[1], 'independent', 'independent'));
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const holding = engine.transaction(async tx => {
      await tx.executeRaw('SELECT id FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [head.id]);
      held.resolve(); await release.promise;
    });
    await held.promise;
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_e, row) => prepared(row, sources),
      { hostId: config.hostId, pollMs: 100, phaseMs: 200 });
    try {
      consumer.start();
      await waitFor(async () => (await getWriteRequestById(engine, independent.id))?.state === 'committed', { timeoutMs: 4000 });
      expect((await getWriteRequestById(engine, follower.id))?.state).toBe('queued');
      expect((await getWriteRequestById(engine, head.id))?.state).toBe('running');
      release.resolve(); await holding;
      await waitFor(async () => (await getWriteRequestById(engine, follower.id))?.state === 'committed', { timeoutMs: 5000 });
      for (const row of [head, follower, independent]) await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, row.id))!);
      await assertConservation(engine);
    } finally { release.resolve(); await holding; await consumer.stop(); }
  }), 30000);

  for (const [phase, table] of [['refresh_roots', 'persistence_brain'], ['recovery_scan', 'persistence_worktrees']] as const) {
    test(`${phase} stopping cancels its blocked query without reporting a storage failure`, () => fixture(async ({ engine, databaseUrl }, config) => {
      const observer = postgres(databaseUrl, { max: 1, prepare: false });
      const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const holding = engine.transaction(async tx => {
        await tx.executeRaw(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
        held.resolve(); await release.promise;
      });
      await held.promise;
      const errors: unknown[] = [];
      const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async () => { throw new Error('unexpected preparation'); },
        { hostId: config.hostId, phaseMs: 10000, pollMs: 60000, onError: error => errors.push(error) });
      try {
        consumer.start();
        await waitFor(async () => (await observer.unsafe<{ waiting: boolean }[]>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1) AS waiting", [`%${table}%`]))[0].waiting && consumer.status().phase?.name === phase,
        { timeoutMs: 5000 });
        const stopping = consumer.stop();
        await waitFor(() => consumer.status().phase === null, { timeoutMs: 2000, label: 'cancelled phase settlement before releasing its blocker' });
        expect(errors).toEqual([]);
        expect(consumer.status().last_error).toBeUndefined();
        expect(consumer.status().phase).toBeNull();
        release.resolve(); await holding; await stopping;
        expect(await engine.executeRaw('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
      } finally { release.resolve(); await holding; await consumer.stop(); await observer.end(); }
    }), 30000);

    test(`${phase} cancels a real table-lock wait and retains fail-closed scheduling`, () => fixture(async ({ engine }, config) => {
      const sources = await fixtures(engine, config);
      const row = await admitWrite(engine, admission(config, sources[0], `waiting-${phase}`, 'phase fixture'));
      const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const holding = engine.transaction(async tx => {
        await tx.executeRaw(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
        held.resolve(); await release.promise;
      });
      await held.promise;
      const errors: unknown[] = [];
      const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_e, current) => prepared(current, sources),
        { hostId: config.hostId, phaseMs: 150, pollMs: 100, onError: error => errors.push(error) });
      try {
        let settled = false;
        const tick = consumer.tick().then(() => { settled = true; });
        await waitFor(() => settled, { timeoutMs: 2000 });
        await tick;
        expect(errors).toHaveLength(1);
        expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
        release.resolve(); await holding;
        consumer.start();
        await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed', { timeoutMs: 5000 });
        await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, row.id))!);
      } finally { release.resolve(); await holding; await consumer.stop(); }
    }), 30000);
  }

  test('a blocked recovery operation keeps reservations and retries after its SQL bound', () => fixture(async ({ engine }, config) => {
    const sources = await fixtures(engine, config);
    const accepted = await admitWrite(engine, admission(config, sources[0], 'recovery-bound', 'recovery fixture'));
    const row = (await claimNextWrite(engine, config.hostId))!;
    expect(row.id).toBe(accepted.id);
    await prepareRecovery(engine, row, { version: 1, root: sources[0].root, path: join(sources[0].root, 'recovery-bound.md'),
      before: null, beforeHash: null, afterHash: sha256('recovery fixture'), mode: null,
      ownerEpoch: String(sources[0].binding.owner_epoch), attempt: row.execution_token! }, 1024);
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const holding = engine.transaction(async tx => {
      await tx.executeRaw('SELECT id FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
      held.resolve(); await release.promise;
    });
    await held.promise;
    const errors: unknown[] = [];
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_e, current) => prepared(current, sources),
      { hostId: config.hostId, concurrency: 0, onError: error => errors.push(error) });
    try {
      let settled = false;
      const tick = consumer.tick().then(() => { settled = true; });
      await waitFor(() => settled, { timeoutMs: 7000 }); await tick;
      expect(errors.length).toBeGreaterThan(0);
      expect(Number((await getWriteRequestById(engine, row.id))?.recovery_bytes)).toBe(1024);
      release.resolve(); await holding;
      await assertConservation(engine);
    } finally { release.resolve(); await holding; await consumer.stop(); }
    const retry = new PersistenceConsumer(engine, { engine: 'postgres' }, async (_e, current) => prepared(current, sources), { hostId: config.hostId });
    try {
      retry.start(); await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed', { timeoutMs: 5000 });
      await assertConservation(engine);
    } finally { await retry.stop(); }
  }), 30000);

  test('ordinary pool saturation cancels queued scheduler reads without accumulating work', () => fixture(async ({ engine }, config) => {
    const release = Promise.withResolvers<void>();
    let held = 0;
    const holding = Array.from({ length: 4 }, () => engine.transaction(async tx => {
      await tx.executeRaw('SELECT 1'); held++; await release.promise;
    }));
    await waitFor(() => held === 4);
    const errors: unknown[] = [];
    const consumer = new PersistenceConsumer(engine, { engine: 'postgres' }, async () => { throw new Error('No claim may pass unavailable capacity'); },
      { hostId: config.hostId, phaseMs: 100, onError: error => errors.push(error) });
    try {
      for (let i = 0; i < 3; i++) {
        await consumer.tick();
        expect(engine.getPoolDiagnostics()?.tracked.raw).toBe(0);
        expect(engine.getPoolDiagnostics()?.tracked.tx).toBe(4);
      }
      expect(errors).toHaveLength(3);
    } finally { release.resolve(); await Promise.all(holding); await consumer.stop(); }
    expect(engine.getPoolDiagnostics()?.tracked).toEqual({ raw: 0, direct: 0, reserved: 0, tx: 0 });
  }), 30000);

  test('capacity marking names and cancels its real row-lock wait before shutdown', () => fixture(async ({ engine, databaseUrl }, config) => {
    const sources = await fixtures(engine, config);
    const row = await admitWrite(engine, admission(config, sources[0], 'capacity-bound', 'capacity fixture'));
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const holding = engine.transaction(async tx => {
      await tx.executeRaw('SELECT id FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
      held.resolve(); await release.promise;
    });
    await held.promise;
    const worker = new PostgresEngine();
    await worker.connect({ database_url: databaseUrl, poolSize: 1 });
    let entered = false;
    let abortedPhase: ReturnType<PersistenceConsumer['status']>['phase'] = null;
    let consumer: PersistenceConsumer;
    const proxy = new Proxy(worker, { get(target, key) {
      if (key === 'sql') return target.sql;
      if (key === 'executeRaw') return async (...args: Parameters<typeof worker.executeRaw>) => {
        if (args[0].startsWith("UPDATE persistence_requests SET blocked_reason='writer_pool_capacity'")) {
          entered = true;
          args[2]?.signal?.addEventListener('abort', () => { abortedPhase = consumer.status().phase; }, { once: true });
        }
        return target.executeRaw(...args);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const errors: unknown[] = [];
    consumer = new PersistenceConsumer(proxy, { engine: 'postgres' }, async () => { throw new Error('Capacity cannot prepare'); },
      { hostId: config.hostId, phaseMs: 150, onError: error => errors.push(error) });
    try {
      const tick = consumer.tick();
      await waitFor(() => entered);
      expect(consumer.status().phase?.name).toBe('capacity');
      await waitFor(() => errors.length > 0);
      await tick;
      expect(abortedPhase).toMatchObject({ name: 'capacity', deadline_exceeded: true });
      expect(consumer.status().last_error).toMatchObject({ phase: 'capacity', code: '57014' });
      let stopped = false;
      const stopping = consumer.stop().then(() => { stopped = true; });
      await waitFor(() => stopped); await stopping;
      expect(worker.getPoolDiagnostics()?.tracked).toEqual({ raw: 0, direct: 0, reserved: 0, tx: 0 });
      expect((await getWriteRequestById(engine, row.id))?.blocked_reason).toBeNull();
    } finally { release.resolve(); await holding; await consumer.stop(); await worker.disconnect(); }
    expect((await getWriteRequestById(engine, row.id))?.blocked_reason).toBeNull();
    await assertConservation(engine);
  }), 30000);

  test('a queued direct-pool BEGIN stays tracked and cannot prepare after shutdown', () => fixture(async ({ engine, databaseUrl }, config) => {
    await withEnv({ GBRAIN_DIRECT_DATABASE_URL: databaseUrl, GBRAIN_DISABLE_DIRECT_POOL: '0', GBRAIN_DIRECT_POOL_SIZE: '1' }, async () => {
      const worker = new PostgresEngine();
      await worker.connect({ database_url: databaseUrl, poolSize: 4 });
      const direct = await worker.connectionManager!.ddl();
      expect(direct).not.toBe(worker.sql);
      const sources = await fixtures(engine, config);
      const row = await admitWrite(engine, admission(config, sources[0], 'queued-begin', 'direct pool fixture'));
      const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const holding = direct.begin(async tx => { await tx`SELECT 1`; held.resolve(); await release.promise; });
      await held.promise;
      let attempts = 0, stopped = false;
      const consumer = new PersistenceConsumer(worker, { engine: 'postgres' }, async (_e, current) => {
        attempts++; return prepared(current, sources);
      }, { hostId: config.hostId, phaseMs: 100, pollMs: 60000 });
      try {
        const tick = consumer.tick();
        await waitFor(() => consumer.status().phase?.name === 'claim' && consumer.status().phase?.deadline_exceeded === true);
        expect(worker.getPoolDiagnostics()?.tracked.tx).toBeGreaterThanOrEqual(1);
        const stopping = consumer.stop().then(() => { stopped = true; });
        await Bun.sleep(50);
        expect(stopped).toBe(false);
        expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
        release.resolve(); await holding; await tick; await stopping;
        expect(attempts).toBe(0);
        expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
        expect(worker.getPoolDiagnostics()?.tracked.tx).toBe(0);
      } finally { release.resolve(); await holding; await consumer.stop(); await worker.disconnect(); }
    });
  }), 30000);

  for (const outcome of ['delayed', 'rejected'] as const) test(`a ${outcome} cold direct initialization remains observed until settlement`, () => fixture(async ({ engine, databaseUrl }, config) => {
    const target = new URL(databaseUrl);
    const sockets = new Set<Socket>();
    const pending: Array<() => void> = [];
    let released = false, connections = 0;
    const gateway = createServer(socket => {
      connections++;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      const buffered: Buffer[] = [];
      const buffer = (chunk: Buffer) => buffered.push(chunk);
      socket.on('data', buffer);
      const route = () => {
        const upstream = connect({ host: target.hostname, port: Number(target.port) });
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        upstream.on('error', () => socket.destroy());
        socket.once('close', () => upstream.destroy());
        upstream.once('connect', () => {
          socket.off('data', buffer);
          for (const chunk of buffered.splice(0)) upstream.write(chunk);
          socket.pipe(upstream); upstream.pipe(socket);
        });
      };
      if (released) route();
      else pending.push(() => {
        if (outcome === 'delayed') return route();
        const body = Buffer.from('SFATAL\0C28000\0Msynthetic cold initialization rejection\0\0');
        const length = Buffer.alloc(4);
        length.writeUInt32BE(body.length + 4);
        socket.end(Buffer.concat([Buffer.from('E'), length, body]));
      });
    });
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const directUrl = new URL(databaseUrl);
    directUrl.hostname = '127.0.0.1';
    directUrl.port = String((gateway.address() as { port: number }).port);
    const release = () => { released = true; for (const resume of pending.splice(0)) resume(); };
    try {
      await withEnv({ GBRAIN_DIRECT_DATABASE_URL: directUrl.toString(), GBRAIN_DISABLE_DIRECT_POOL: '0', GBRAIN_DIRECT_POOL_SIZE: '1' }, async () => {
        const worker = new PostgresEngine();
        await worker.connect({ database_url: databaseUrl, poolSize: 4 });
        expect(connections).toBe(0);
        const sources = await fixtures(engine, config);
        const row = await admitWrite(engine, admission(config, sources[0], `cold-${outcome}`, 'cold route fixture'));
        let attempts = 0, stopped = false, settled = false, querySettled = false;
        const errors: Array<ReturnType<PersistenceConsumer['status']>['last_error']> = [];
        const consumer = new PersistenceConsumer(worker, { engine: 'postgres' }, async (_e, current) => {
          attempts++; return prepared(current, sources);
        }, { hostId: config.hostId, phaseMs: 100, pollMs: 60000, onError: () => errors.push(consumer.status().last_error) });
        try {
          const tick = consumer.tick().then(() => { settled = true; });
          await waitFor(() => connections === 1 && consumer.status().phase?.name === 'claim' && consumer.status().phase?.deadline_exceeded === true);
          const abort = new AbortController();
          const query = worker.executeRawDirect('SELECT pg_sleep(10)', undefined, { signal: abort.signal })
            .then(() => { querySettled = true; return null; }, error => { querySettled = true; return error; });
          abort.abort();
          const joining = consumer.tick();
          const stopping = consumer.stop().then(() => { stopped = true; });
          await Bun.sleep(50);
          expect(consumer.status().phase).toMatchObject({ name: 'claim', deadline_exceeded: true });
          expect([settled, stopped, querySettled]).toEqual([false, false, false]);
          expect(connections).toBe(1);
          expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
          expect(attempts).toBe(0);
          release();
          await Promise.all([tick, joining, stopping]);
          expect(await query).toMatchObject(outcome === 'delayed' ? { name: 'AbortError' } : { code: '28000' });
          if (outcome === 'delayed') expect(errors).toHaveLength(0);
          else expect(errors.some(error => error?.phase === 'claim' && error.code === '28000')).toBe(true);
          expect(consumer.status().phase).toBeNull();
          expect(attempts).toBe(0);
          expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
          expect(worker.getPoolDiagnostics()?.tracked).toEqual({ raw: 0, direct: 0, reserved: 0, tx: 0 });
          expect(await worker.connectionManager!.ddl()).not.toBe(worker.sql);
          const retry = new PersistenceConsumer(worker, { engine: 'postgres' }, async (_e, current) => prepared(current, sources), { hostId: config.hostId });
          try {
            retry.start();
            await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed', { timeoutMs: 5000 });
            await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, row.id))!);
            await assertConservation(engine);
          } finally { await retry.stop(); }
        } finally { release(); await consumer.stop(); await worker.disconnect(); }
      });
    } finally {
      release();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
    }
  }), 30000);

  test('claim renewal cancels its actual SQL wait without a late lease extension', () => fixture(async ({ engine }, config) => {
    const sources = await fixtures(engine, config);
    await admitWrite(engine, admission(config, sources[0], 'renewal-bound', 'renewal fixture'));
    const row = (await claimNextWrite(engine, config.hostId))!;
    const held = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const holding = engine.transaction(async tx => {
      await tx.executeRaw('SELECT id FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
      held.resolve(); await release.promise;
    });
    await held.promise;
    try {
      await expect(renewWriteClaim({ executeRaw: engine.executeRawDirect.bind(engine) }, row.id, row.execution_token!, 30000,
        AbortSignal.timeout(100))).rejects.toMatchObject({ code: '57014' });
    } finally { release.resolve(); await holding; }
    expect((await getWriteRequestById(engine, row.id))?.claim_expires_at).toEqual(row.claim_expires_at);
  }), 30000);
});
