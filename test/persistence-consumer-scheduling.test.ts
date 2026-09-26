import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { admitWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { acquireWorktree } from '../src/core/persistence/ownership.ts';
import { admission, assertCommittedSnapshot, assertConservation, fixtures, initializeFixtures, prepared, selectFixtureHost, type HarnessConfig } from '../scripts/persistence/harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-consumer-scheduling-'));
const config: HarnessConfig = {
  kind: 'pglite', root: home, dataDir: join(home, 'data'), hostId: randomUUID(),
  seed: 5105, schedules: 0, operations: 0,
  sourceIds: ['consumer-scheduling', 'consumer-scheduling-other'], principalIds: [randomUUID()],
};
const env = { GBRAIN_HOME: home, GBRAIN_PERSISTENCE_FIXTURE_HOME: home };
let engine: PGLiteEngine;

beforeAll(async () => withEnv(env, async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  selectFixtureHost(config.hostId);
  await initializeFixtures(engine, config);
}), 120_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('simultaneous bounded waiters retain one unresolved receipt read until settlement', async () => withEnv(env, async () => {
  const release = Promise.withResolvers<never[]>();
  let reads = 0;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
      if (sql === 'SELECT * FROM persistence_requests WHERE id=$1::uuid') { reads++; return release.promise; }
      return target.executeRaw(sql, params);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const row = { id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest;
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => waitForWrite(proxy, row, { engine: 'pglite' }, 100)));
    expect(results.every(value => value === row)).toBe(true);
    expect(reads).toBe(1);
    await waitForWrite(proxy, row, { engine: 'pglite' }, 100);
    expect(reads).toBe(1);
  } finally {
    release.resolve([]);
    await disposePersistenceConsumer(proxy);
  }
}), 5000);

test('shutdown drains an uncancellable receipt read without scheduling another', async () => withEnv(env, async () => {
  const release = Promise.withResolvers<never[]>();
  let reads = 0, stopped = false;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
      if (sql === 'SELECT * FROM persistence_requests WHERE id=$1::uuid') { reads++; return release.promise; }
      return target.executeRaw(sql, params);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const row = { id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest;
  const waiter = waitForWrite(proxy, row, { engine: 'pglite' }, 500);
  try {
    await waitFor(() => reads === 1);
    const stopping = disposePersistenceConsumer(proxy).then(() => { stopped = true; });
    await Bun.sleep(30);
    expect(stopped).toBe(false);
    release.resolve([]);
    await stopping;
    await waiter;
    expect(reads).toBe(1);
  } finally { release.resolve([]); await waiter; await disposePersistenceConsumer(proxy); }
}), 5000);

test.each(['queued', 'committed'] as const)('coalesced receipt reads preserve each result while the first waiter is %s', firstState => withEnv(env, async () => {
  const rows = Array.from({ length: 2 }, () => ({ id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest));
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
      if (sql === 'SELECT * FROM persistence_requests WHERE id=$1::uuid') {
        await Bun.sleep(20);
        return [{ ...rows.find(row => row.id === params?.[0]), state: params?.[0] === rows[0].id ? firstState : 'committed' }];
      }
      return target.executeRaw(sql, params);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  try {
    const results = await Promise.all(rows.map(row => waitForWrite(proxy, row, { engine: 'pglite' }, 1000)));
    expect(results.map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(results.map(row => row.state)).toEqual([firstState, 'committed']);
  } finally { await disposePersistenceConsumer(proxy); }
}), 5000);

test('a stalled receipt read does not hide another request that already committed', async () => withEnv(env, async () => {
  const release = Promise.withResolvers<never[]>();
  const rows = Array.from({ length: 2 }, () => ({ id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest));
  let entered = false;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
      if (sql === 'SELECT * FROM persistence_requests WHERE id=$1::uuid') {
        if (params?.[0] === rows[0].id) { entered = true; return release.promise; }
        return [{ ...rows[1], state: 'committed' }];
      }
      return target.executeRaw(sql, params);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const stalled = waitForWrite(proxy, rows[0], { engine: 'pglite' }, 1000);
  try {
    await waitFor(() => entered);
    const found = await waitForWrite(proxy, rows[1], { engine: 'pglite' }, 250);
    expect(found.id).toBe(rows[1].id);
    expect(found.state).toBe('committed');
  } finally { release.resolve([]); await disposePersistenceConsumer(proxy); await stalled; }
}), 5000);

test.each([false, true])('a shorter receipt waiter cannot abort another caller\'s read (same ID=%s)', sameId => withEnv(env, async () => {
  const release = Promise.withResolvers<never[]>();
  const row = { id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest;
  const other = sameId ? row : { ...row, id: randomUUID(), request_id: randomUUID() };
  let ownerSignal: AbortSignal | undefined;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'kind') return 'postgres';
    if (key === 'executeRaw') return async (...args: Parameters<typeof engine.executeRaw>) => {
      if (args[0] === 'SELECT * FROM persistence_requests WHERE id=$1::uuid') {
        if (args[1]?.[0] === row.id) ownerSignal = args[2]?.signal;
        return release.promise;
      }
      return target.executeRaw(...args);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'postgres' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const owner = waitForWrite(proxy, row, { engine: 'postgres' }, 1000);
  try {
    await waitFor(() => ownerSignal !== undefined);
    expect(await waitForWrite(proxy, other, { engine: 'postgres' }, 100)).toBe(other);
    expect(ownerSignal!.aborted).toBe(false);
  } finally { release.resolve([]); await disposePersistenceConsumer(proxy); await owner; }
}), 5000);

test('distinct stalled receipt reads stay capped and shutdown drains every retained read', async () => withEnv(env, async () => {
  const releases = Array.from({ length: 4 }, () => Promise.withResolvers<never[]>());
  let reads = 0, stopped = false;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
      if (sql === 'SELECT * FROM persistence_requests WHERE id=$1::uuid') {
        const release = releases[reads++];
        expect(release).toBeDefined();
        return release.promise;
      }
      return target.executeRaw(sql, params);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = startPersistenceConsumer(proxy, { engine: 'pglite' });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {};
  const rows = Array.from({ length: 20 }, () => ({ id: randomUUID(), request_id: randomUUID(), state: 'queued' } as import('../src/core/persistence/model.ts').WriteRequest));
  try {
    expect(await Promise.all(rows.map(row => waitForWrite(proxy, row, { engine: 'pglite' }, 100)))).toEqual(rows);
    expect(reads).toBe(4);
    await waitForWrite(proxy, rows.at(-1)!, { engine: 'pglite' }, 100);
    expect(reads).toBe(4);
    const stopping = disposePersistenceConsumer(proxy).then(() => { stopped = true; });
    for (const release of releases.slice(0, -1)) release.resolve([]);
    await Bun.sleep(30);
    expect(stopped).toBe(false);
    releases.at(-1)!.resolve([]);
    await stopping;
    expect(stopped).toBe(true);
    expect(reads).toBe(4);
  } finally { for (const release of releases) release.resolve([]); await disposePersistenceConsumer(proxy); }
}), 5000);

for (const cooperates of [true, false]) test(`preparation deadline retains tracking and fences late results (cooperative=${cooperates})`, async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], `deadline-${cooperates}`, 'deadline body'));
  const release = Promise.withResolvers<void>();
  let attempts = 0;
  let aborted = false;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current, _c, signal?: AbortSignal) => {
    attempts++;
    signal?.addEventListener('abort', () => { aborted = true; if (cooperates) release.resolve(); }, { once: true });
    await release.promise;
    if (cooperates) signal?.throwIfAborted();
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs: 60_000, preparationMs: 50 });
  try {
    consumer.start();
    await waitFor(() => attempts === 1);
    await Bun.sleep(150);
    expect(aborted).toBe(true);
    expect(attempts).toBe(1);
    if (!cooperates) {
      expect(consumer.status().active_preparations).toBe(1);
      expect((await getWriteRequestById(engine, row.id))?.state).toBe('running');
    }
    release.resolve();
    await waitFor(() => consumer.status().active_preparations === 0);
    expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
    expect(await engine.readPageSnapshot(row.slug, { sourceId: row.source_id })).toBeNull();
    await assertConservation(engine);
  } finally {
    release.resolve();
    await consumer.stop();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 5000);

test('publication entering before the preparation deadline keeps its protected terminal outcome', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'publication-wins', 'protected body'));
  let entered = false;
  const release = Promise.withResolvers<void>();
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current) => {
    const mutation = prepared(current, sources);
    return { ...mutation, apply: async tx => { entered = true; await release.promise; return mutation.apply(tx); } };
  }, { hostId: config.hostId, pollMs: 60_000, preparationMs: 50 });
  try {
    consumer.start();
    await waitFor(() => entered);
    await Bun.sleep(100);
    release.resolve();
    await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed');
    await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, row.id))!);
    await assertConservation(engine);
  } finally { release.resolve(); await consumer.stop(); }
}), 5000);

test.each([false, true])('a synchronous late preparation cannot outrun its delayed abort timer (reject=%s)', reject => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], `synchronous-deadline-${reject}`, 'unpublished body'));
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current) => {
    const until = performance.now() + 60;
    while (performance.now() < until) {}
    if (reject) throw new DOMException('Synthetic late abort', 'AbortError');
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs: 60000, preparationMs: 20 });
  try {
    await consumer.tick();
    await waitFor(() => consumer.status().active_preparations === 0);
    expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
    expect(await engine.readPageSnapshot(row.slug, { sourceId: row.source_id })).toBeNull();
  } finally { await consumer.stop(); await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id); }
}), 5000);

test('shutdown does not finish while an abort-ignoring preparer remains active', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'stop-ignoring-abort', 'unpublished body'));
  const release = Promise.withResolvers<void>();
  let aborted = false, entered = false, stopped = false;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_e, current, _cfg, signal) => {
    entered = true;
    signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
    await release.promise;
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs: 60_000 });
  try {
    consumer.start(); await waitFor(() => entered);
    const stop = consumer.stop().then(() => { stopped = true; });
    await Bun.sleep(50);
    expect(aborted).toBe(true); expect(stopped).toBe(false);
    expect(consumer.status().active_preparations).toBe(1);
    release.resolve(); await stop;
    expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
    expect(await engine.readPageSnapshot(row.slug, { sourceId: row.source_id })).toBeNull();
  } finally { release.resolve(); await consumer.stop(); await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id); }
}), 5000);

test('an immediate wake-up during an active tick is retained until that tick finishes', async () => {
  const release = Promise.withResolvers<void>();
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => { throw new Error('No writes in scheduler probe'); },
    { hostId: config.hostId, pollMs: 60_000 });
  const scheduler = consumer as unknown as { doTick(): Promise<void>; schedule(ms: number): void };
  let ticks = 0;
  scheduler.doTick = async () => { if (++ticks === 1) await release.promise; };
  try {
    const active = consumer.tick();
    scheduler.schedule(0);
    await Bun.sleep(25);
    expect(ticks).toBe(1);
    release.resolve();
    await active;
    await waitFor(() => ticks === 2, { timeoutMs: 5_000 });
  } finally {
    release.resolve();
    await consumer.stop();
  }
});

test('process-local diagnostic errors never retain arbitrary driver codes or messages', async () => {
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async () => { throw new Error('No preparation'); },
    { hostId: config.hostId, onError: () => {} });
  (consumer as unknown as { doTick(): Promise<void> }).doTick = async () => {
    throw Object.assign(new Error('PRIVATE_DRIVER_MESSAGE'), { code: 'PRIVATE_DRIVER_CODE' });
  };
  try {
    await consumer.tick();
    expect(consumer.status().last_error?.code).toBe('storage_error');
    expect(JSON.stringify(consumer.status())).not.toContain('PRIVATE_');
  } finally { await consumer.stop(); }
});

test('an uncancellable PGLite scheduler phase stays observed and awaited through stop', async () => withEnv(env, async () => {
  const release = Promise.withResolvers<never[]>();
  let entered = false, stopped = false;
  const proxy = new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (...args: Parameters<typeof engine.executeRaw>) => {
      if (args[0] === 'SELECT brain_id,enabled FROM persistence_brain WHERE singleton=1') {
        expect(args[2]?.signal).toBeUndefined();
        entered = true; return release.promise;
      }
      return target.executeRaw(...args);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const consumer = new PersistenceConsumer(proxy, { engine: 'pglite' }, async () => { throw new Error('No late preparation'); },
    { hostId: config.hostId, phaseMs: 20 });
  try {
    const tick = consumer.tick();
    await waitFor(() => entered && consumer.status().phase?.deadline_exceeded === true);
    expect(consumer.status().phase?.name).toBe('refresh_roots');
    const stopping = consumer.stop().then(() => { stopped = true; });
    await Bun.sleep(40);
    expect(stopped).toBe(false);
    expect(consumer.status().phase?.deadline_exceeded).toBe(true);
    release.resolve([]); await tick; await stopping;
    expect(consumer.status().phase).toBeNull();
  } finally { release.resolve([]); await consumer.stop(); }
}), 5000);

for (const outcome of ['committed', 'failed'] as const) test(`a ${outcome} write preempts idle polling and drains the next FIFO request`, async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const first = await admitWrite(engine, admission(config, sources[0], `first-${outcome}`, 'first body'));
  const second = await admitWrite(engine, admission(config, sources[0], `second-${outcome}`, 'second body'));
  const release = Promise.withResolvers<void>();
  const started: string[] = [];
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, row) => {
    started.push(row.id);
    if (row.id === first.id) {
      await release.promise;
      if (outcome === 'failed') throw new Error('Permanent fixture failure');
    }
    return prepared(row, sources);
  }, { hostId: config.hostId, concurrency: 1, pollMs: 60_000, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(() => started.length === 1);
    await consumer.tick();
    expect(started).toEqual([first.id]);
    release.resolve();
    await waitFor(async () => (await getWriteRequestById(engine, second.id))?.state === 'committed',
      { timeoutMs: 5_000, label: 'completion wake-up must not wait for the idle poll' });
    expect(started).toEqual([first.id, second.id]);
    const terminal = (await getWriteRequestById(engine, first.id))!;
    expect(terminal.state).toBe(outcome);
    if (outcome === 'committed') await assertCommittedSnapshot(engine, terminal);
    else expect(await engine.readPageSnapshot(first.slug, { sourceId: config.sourceIds[0] })).toBeNull();
    await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, second.id))!);
    await assertConservation(engine);
    expect(errors).toEqual([]);
  } finally {
    release.resolve();
    await consumer.stop();
    for (const row of [first, second]) await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 15_000);

test('stopping while preparation is active does not schedule another queued write', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const first = await admitWrite(engine, admission(config, sources[0], 'stop-first', 'first body'));
  const second = await admitWrite(engine, admission(config, sources[0], 'stop-second', 'second body'));
  const release = Promise.withResolvers<void>();
  const started: string[] = [];
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, row) => {
    started.push(row.id);
    await release.promise;
    return prepared(row, sources);
  }, { hostId: config.hostId, concurrency: 1, pollMs: 60_000, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(() => started.length === 1);
    await consumer.tick();
    const stopped = consumer.stop();
    release.resolve();
    await stopped;
    await consumer.tick();
    expect(started).toEqual([first.id]);
    expect((await getWriteRequestById(engine, first.id))?.state).toBe('queued');
    expect((await getWriteRequestById(engine, second.id))?.state).toBe('queued');
    expect(consumer.status()).toMatchObject({ accepting: false, active_preparations: 0 });
    expect(errors).toEqual([]);
    await assertConservation(engine);
  } finally {
    release.resolve();
    await consumer.stop();
    for (const row of [first, second]) await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 15_000);

for (const reason of ['locked root', 'retryable preparation'] as const) test(`${reason} keeps idle backoff instead of spinning on immediate wake-ups`, async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'blocked', 'blocked body'));
  const lock = reason === 'locked root' ? await acquireWorktree(sources[0].binding) : undefined;
  if (reason === 'locked root') expect(lock).not.toBeNull();
  let attempts = 0;
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, current) => {
    attempts++;
    if (reason === 'retryable preparation') throw Object.assign(new Error('Retryable fixture failure'), { code: '40001' });
    return prepared(current, sources);
  }, { hostId: config.hostId, concurrency: 1, pollMs: 60_000, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(() => attempts > 0 && consumer.status().active_preparations === 0);
    await Bun.sleep(100);
    expect(attempts).toBe(1);
    expect((await getWriteRequestById(engine, row.id))?.state).toBe('queued');
    expect(errors).toEqual([]);
  } finally {
    await consumer.stop();
    await lock?.release();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 15_000);

for (const reason of ['locked root', 'retryable preparation'] as const) test(`healthy completions preserve ${reason} backoff on another root`, async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const suffix = reason.replaceAll(' ', '-');
  const blocked = await admitWrite(engine, admission(config, sources[0], `mixed-blocked-${suffix}`, 'blocked body'));
  const healthy = await Promise.all(Array.from({ length: 3 }, (_, i) =>
    admitWrite(engine, admission(config, sources[1], `mixed-healthy-${suffix}-${i}`, `healthy body ${i}`))));
  const lock = reason === 'locked root' ? await acquireWorktree(sources[0].binding) : undefined;
  if (reason === 'locked root') expect(lock).not.toBeNull();
  let attempts = 0;
  const errors: unknown[] = [];
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, row) => {
    if (row.id === blocked.id) {
      attempts++;
      if (reason === 'retryable preparation') throw Object.assign(new Error('Retryable fixture failure'), { code: '40001' });
    }
    return prepared(row, sources);
  }, { hostId: config.hostId, concurrency: 2, pollMs: 60_000, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(async () => (await Promise.all(healthy.map(row => getWriteRequestById(engine, row.id))))
      .every(row => row?.state === 'committed'), { timeoutMs: 5_000 });
    await waitFor(() => consumer.status().active_preparations === 0);
    expect(attempts).toBe(1);
    expect((await getWriteRequestById(engine, blocked.id))?.state).toBe('queued');
    for (const row of healthy) await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, row.id))!);
    await assertConservation(engine);
    expect(errors).toEqual([]);
  } finally {
    await consumer.stop();
    await lock?.release();
    for (const row of [blocked, ...healthy]) await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 15_000);

test('a retryable root becomes eligible again after its backoff expires', async () => withEnv(env, async () => {
  const sources = await fixtures(engine, config);
  const row = await admitWrite(engine, admission(config, sources[0], 'retry-expiry', 'retry body'));
  const attempts: number[] = [];
  const errors: unknown[] = [];
  const pollMs = 200;
  const consumer = new PersistenceConsumer(engine, { engine: 'pglite' }, async (_engine, current) => {
    attempts.push(Date.now());
    if (attempts.length === 1) throw Object.assign(new Error('Retryable fixture failure'), { code: '40001' });
    return prepared(current, sources);
  }, { hostId: config.hostId, pollMs, onError: error => errors.push(error) });
  try {
    consumer.start();
    await waitFor(async () => (await getWriteRequestById(engine, row.id))?.state === 'committed', { timeoutMs: 5_000 });
    expect(attempts).toHaveLength(2);
    expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(pollMs);
    await assertCommittedSnapshot(engine, (await getWriteRequestById(engine, row.id))!);
    await assertConservation(engine);
    expect(errors).toEqual([]);
  } finally {
    await consumer.stop();
    await cancelWriteRequest(engine, { kind: 'local_cli', id: config.principalIds[0] }, row.request_id);
  }
}), 15_000);
